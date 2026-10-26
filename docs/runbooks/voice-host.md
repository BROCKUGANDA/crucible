# Runbook: voice host (Frenchy)

## How it is wired

- `apps/api/src/voice.ts` proxies ElevenLabs. The browser never receives the
  key.
- `GET /voice/status` → `{configured, model}`. The web control is hidden when
  `configured` is false.
- `POST /voice/speak` accepts `{moment}` and nothing else — one of
  `greeting`, `tour`, `verdict`, `verdict-repeat`. A body carrying `text` is
  refused. It has its own 8/minute per-client bucket.
- `apps/web/src/components/VoiceControl.tsx` owns the muted-by-default control;
  `apps/web/src/lib/voice.ts` owns the once-a-day and reduced-motion policy.
- The trial page announces a verdict only for a **paid** verdict while the
  quench panel is visible.

## Configure

On the host, in `/home/ubuntu/crucible/.env` (or the local `.env` for dev):

```bash
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...          # the id from the ElevenLabs dashboard, not the name
ELEVENLABS_MODEL_ID=eleven_multilingual_v4
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
# {"configured":true,"model":"eleven_multilingual_v4"}
```

In the browser, the header should show `Frenchy off`. Click it and allow audio.
The greeting is the consent/gate. A Tour button appears once enabled.

## Cost and abuse

- The route is not a TTS API at all: every phrase is in `COPY` server-side and a
  request carrying `text` is refused before the provider is contacted. The
  account therefore never synthesizes words nobody reviewed — see
  "Caller text is refused" below.
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

## Caller text is refused — and why

`POST /voice/speak` used to accept `{moment:"spec", text}` up to 600 characters.
Nothing in the product ever called it; the public internet found it. Measured on
the deployed site before removal:

```
curl -X POST https://crucible.svalley.tech/api/voice/speak \
  -d '{"moment":"spec","text":"..."}'  → HTTP 200, 66917 bytes, audio/mpeg
```

That is an unauthenticated, unmoderated text-to-speech proxy running on the
account holder's key and voice. Under the provider's Usage Policy the account is
answerable for Input and Output produced through a product built on the service,
and arbitrary synthetic speech is the mechanism for impersonation, harassment,
and fraudulent endorsement — so the capability is gone rather than guarded. The
test asserts the provider is never contacted when text arrives, because "we
rejected it" is only worth something if no audio was produced on our account.

## What the provider's policy asks of us

| Obligation | Where it holds |
|---|---|
| No unreviewed Input | `COPY` is the whole vocabulary; `text` is refused with 400. |
| Disclosure that the voice is synthetic | The control reads `Frenchy (AI) on/off` in its visible label, and the tooltip says AI-generated. |
| No impersonation of a real person | One licensed stock voice (`ELEVENLABS_VOICE_ID`), no cloning, no voice swap from a request. |
| No deceptive or unverifiable claims in Output | The four lines name no amount, deadline, address or CID — asserted by a test that rejects digits in the copy. |
| Key never in a client | The proxy is server-side; `/voice/status` returns only `{configured, model}`; the provider body is never reflected. |
| Abuse ceiling | 8/minute per-client voice bucket plus the global limiter. |
| High-impact decisions not made by audio | The voice is decoration; every fact stays on screen, and the app is fully usable with the route deleted. |

Reporting and appeals routes exist at the provider; an unauthorized-voice claim
against us would arrive through those, and the key rotation procedure below is
the response that does not need an incident channel to start.

## This is not a conversational agent

No microphone, no STT, no 8-second goodbye. It is one-way TTS. The PRD prompt
for an ElevenLabs conversational agent does not apply to this integration.
