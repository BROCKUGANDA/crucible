# Runbook: voice host (Frenchy)

## How it is wired

- `apps/api/src/voice.ts` proxies ElevenLabs. The browser never receives the
  key.
- `GET /voice/status` → `{configured, model}`. The web control is hidden when
  `configured` is false.
- `POST /voice/speak` accepts `{moment}` for fixed copy, or `{moment:"spec",
text}` with 1–600 characters. It has its own 8/minute per-client bucket.
- `apps/web/src/components/VoiceControl.tsx` owns the muted-by-default control;
  `apps/web/src/lib/voice.ts` owns the once-a-day and reduced-motion policy.
- The trial page announces a verdict only for a **paid** verdict while the
  quench panel is visible.

## Configure

On the host, in `/home/ubuntu/crucible/.env` (or the local `.env` for dev):

```bash
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...          # the id from the ElevenLabs dashboard, not the name
ELEVENLABS_MODEL_ID=eleven_flash_v2_5
# VOICE_DISABLED=1               # optional kill switch
```

The API reads the key at boot. Recreate the API after changing it:

```bash
cd ~/crucible
docker compose -f compose.yaml -f compose.vps.yaml up -d --no-deps api
docker logs --tail 20 crucible-api-1 | grep 'voice:'
```

The boot log says `voice: Frenchy on (<model>)` or `voice: off (...)`; it never
prints the key.

## Verify

```bash
curl -sS https://crucible.svalley.tech/api/voice/status
# {"configured":true,"model":"eleven_flash_v2_5"}
```

In the browser, the header should show `Frenchy off`. Click it and allow audio.
The greeting is the consent/gate. A Tour button appears once enabled.

## Cost and abuse

- The route is not a general TTS API: the copy for greeting/tour/verdict is
  fixed server-side; only `spec` accepts text, capped at 600 characters.
- The global limiter plus the 8/minute voice bucket apply. Neither is a global
  budget across instances; the demo runs one API process.
- If the bill is a concern, set `VOICE_DISABLED=1` and recreate the API. The
  control disappears; the rest of the app is unchanged.

## Rotate or revoke the key

1. Create the new key in ElevenLabs.
2. Update `ELEVENLABS_API_KEY` in the host `.env`.
3. Recreate the API (`up -d --no-deps api`).
4. Revoke the old key at the provider.
5. Confirm `/voice/status` and one manual greeting.

A leaked TTS key spends credits; it cannot move escrow or sign a chain
transaction. The key inventory records this boundary.

## Provider outage

A non-2xx provider response becomes `502` with a generic message; a network
failure becomes `502` and a DLQ entry under `voice.upstream`. The browser
treats either as silence. The page must remain fully usable. Check:

```bash
docker logs --tail 50 crucible-api-1 | grep -i voice
curl -sS https://crucible.svalley.tech/api/health   # dlq count/last kind
```

Do not put the provider body in a client response; it can contain account
details.

## "Read the spec" is not wired

The web has the spec CID, not its text, so no button sends a `spec` moment yet.
When a spec viewer exists, call the same endpoint with `moment:"spec"` and the
visible text; the server caps and normalises it.

## This is not a conversational agent

No microphone, no STT, no 8-second goodbye. It is one-way TTS. The PRD prompt
for an ElevenLabs conversational agent does not apply to this integration.
