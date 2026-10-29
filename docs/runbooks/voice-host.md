# Runbook: voice host (Frenchy)

Two hosts, one account, one key. This runbook covers both: the **one-way host**
(`/voice`, the fixed lines) and the **speech-to-speech host** (`/sts`, ADR-0018),
which is what the voice room in the web app uses.

## How it is wired

### The one-way host

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

### The speech-to-speech host

- `apps/api/src/sts.ts` holds the key, the brain, and **the turn ledger**. The
  browser never receives the key.
- `GET /sts/status` → `{configured, stt, brain, tts, model}`. The voice room
  says which piece is missing rather than a flat "not configured".
- `POST /sts/session` opens a conversation and returns the **token** that owns
  it — once. `GET /sts/session` reads it back and `POST /sts/turn` sends one
  utterance; both carry the token in the `x-crucible-session` header, and
  **neither URL carries an identifier**. The host keeps only the token's digest.
- The exchange is one request and one response: **there is no socket**. The
  monitor polls `GET /sts/session` for the phase while a turn runs.
- The **caller brings audio, not words.** The host transcribes it with our key,
  the brain composes the answer, and only the model's words reach the
  synthesiser — so the boundary below is kept from the other side rather than
  loosened.
- The words are the content and the audio is the garnish: a synthesiser that
  refuses still returns the transcript and the reply with the failure named.
- The **turn monitor** is the host's own ledger, written by the party that did
  the work. A step that did not finish carries `null`, never `0`.
- **A turn that is superseded is `interrupted`, not `failed`.** A visitor who
  answers again stops the turn in flight, and the ledger says so.
- `apps/web/src/app/voice/page.tsx` is the page; `TurnMonitor.tsx` is the panel.

## Configure

On the host, in `/home/ubuntu/crucible/.env` (or the local `.env` for dev):

```bash
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...          # the id from the ElevenLabs dashboard, not the name
ELEVENLABS_MODEL_ID=eleven_multilingual_v4
ELEVENLABS_STT_MODEL_ID=scribe_v1 # the transcription model the speech host posts to
# VOICE_DISABLED=1               # optional kill switch for the one-way host
# STS_DISABLED=1                 # optional kill switch for the speech host
```

The API reads the key at boot. Recreate the API after changing it:

```bash
cd ~/crucible
docker compose -f compose.yaml -f compose.vps.yaml up -d --no-deps api
docker logs --tail 20 crucible-api-1 | grep 'voice:'
docker logs --tail 20 crucible-api-1 | grep 'speech-to-speech:'
```

The boot log says `voice: Frenchy on (<model>)` or `voice: off (...)`, and
`speech-to-speech: on (stt <model>, brain <model>, voice on|off)`; it never
prints the key.

## Verify

```bash
curl -sS https://crucible.svalley.tech/api/voice/status
# {"configured":true,"model":"eleven_multilingual_v4"}

curl -sS https://crucible.svalley.tech/api/sts/status
# {"configured":true,"stt":true,"brain":true,"tts":true,"model":"scribe_v1"}
```

In the browser, the header should show `Frenchy off`. Click it and allow audio.
The greeting is the consent/gate. A Tour button appears once enabled. The voice
room is at `/voice` — **Voice room** in the navigation — and asks the browser
for the microphone only when you press *Talk to Frenchy*.

## Cost and abuse

- The route is not a TTS API at all: every phrase is in `COPY` server-side and a
  request carrying `text` is refused before the provider is contacted. The
  account therefore never synthesizes words nobody reviewed — see
  "Caller text is refused" below.
- The global limiter plus the 8/minute voice bucket apply. Neither is a global
  budget across instances; the demo runs one API process.
- If the bill is a concern, set `VOICE_DISABLED=1` and recreate the API. The
  control disappears; the rest of the app is unchanged.
- **The speech host costs three provider calls a turn** — a transcription, the
  brain, a synthesis — and it is the one host here that spends on *input*: the
  visitor's speech is text on our key before it is text anywhere else. It is
  bounded at 20 turns a minute, 256 KiB of audio a turn, 40 turns a session, 50
  sessions a host and a 30-minute idle TTL, but **none of those is a daily
  budget**. `STS_DISABLED=1` is the switch that stops it entirely.

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

The speech host fails the same way, with two differences worth knowing: a
**failed synthesis still returns the words**, because the words are the content
and the audio is the garnish; and a failed transcription is a refusal, because
there is nothing to answer.

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

**The speech host does not reopen it.** It takes audio, and the words that reach
the synthesiser are the model's. A caller cannot make the voice say something
the model did not choose, and a test reads the request the provider actually
received to prove it.

## What the provider's policy asks of us

| Obligation | Where it holds |
|---|---|
| No unreviewed Input | `COPY` is the whole vocabulary; `text` is refused with 400. The speech host takes audio, and the only words it synthesises are the brain's. |
| Disclosure that the voice is synthetic | The control reads `Frenchy (AI) on/off` in its visible label, and the tooltip says AI-generated. |
| No impersonation of a real person | One licensed stock voice (`ELEVENLABS_VOICE_ID`), no cloning, no voice swap from a request. |
| No deceptive or unverifiable claims in Output | The four lines name no amount, deadline, address or CID — asserted by a test that rejects digits in the copy. |
| Key never in a client | The proxy is server-side; `/voice/status` returns only `{configured, model}`; the provider body is never reflected. |
| Abuse ceiling | 8/minute per-client voice bucket plus the global limiter; 20 turns a minute for the speech host, with per-session and per-host caps. |
| High-impact decisions not made by audio | The voice is decoration; every fact stays on screen, and the app is fully usable with the route deleted. |

Reporting and appeals routes exist at the provider; an unauthorized-voice claim
against us would arrive through those, and the key rotation procedure below is
the response that does not need an incident channel to start.

## The two voice paths, and what tells them apart

The header's Frenchy panel and the voice room are the same brain and the same
voice. They differ in **whether the turns are kept**: the panel transcribes in
the browser and keeps nothing, and the voice room transcribes on the host and
writes a ledger with each step's cost. The panel is the quick question; the
voice room is the conversation that is written down.

## The microphone

The web app's `Permissions-Policy` says `microphone=(self)` on every page. It
used to say `microphone=()`, which made the browser refuse the header's Frenchy
"Listen" button before the visitor was ever prompted — the button could not
work, and it told the visitor to change their browser settings for it. **The
policy now matches the product.** If a deployment wants the microphone closed,
it should remove the control rather than the permission: a button that cannot
work is a control that lies.
