# ADR-0018: Frenchy, spoken — a speech-to-speech host and a turn monitor

- Status: Accepted
- Date: 2026-10-29

## Context

ADR-0009 made the voice host **one-way**: the API proxies ElevenLabs, the browser
never sees the key, and the only phrases the host will synthesise are a fixed set
of server-side moments. A request that carries text is refused, and the reason is
written down: under the provider's usage policy the account holder is responsible
for the input and output produced on their key, and an unmoderated text-to-speech
endpoint on the public internet is the impersonation, harassment and abuse
surface that policy puts on them.

ADR-0009 also **rejected** the interactive variant in advance:

> **An interactive voice agent (WebSocket + STT).** Rejected for this pass: the
> product has no microphone permission and the demo does not need a conversation.

Two things have changed since that sentence was written.

1. **The microphone permission now exists, on one route.** The web app's
   Permissions-Policy closed the microphone on every page; this ADR opens it on
   `/voice` and only there.
2. **There is now something to have a conversation about.** Frenchy's brain was
   answering from an **empty read model** — the route read a context variable that
   nothing ever set — while its own system prompt told the model it was "grounded
   in live CRUCIBLE state". A voice agent that cannot see the deployment it is
   talking about is a worse product than no voice agent, so the grounding had to
   be fixed whether or not the microphone was opened.

What was wanted is a **speech-to-speech endpoint** — speech in, speech out — and a
**turn monitor**: a live reading of the conversation, turn by turn, with the cost
of each step measured rather than guessed.

## Decision

Ship a speech-to-speech host on the API, and a turn monitor that reads the host's
own record of the conversation.

### The boundary ADR-0009 drew, kept

**The caller brings audio, not words.**

The request body is a recorded utterance. The host transcribes it with our key,
the brain composes an answer, and **only the brain's words** are handed to the
synthesiser. The string that reaches the TTS endpoint is never the caller's
string. This is the same boundary ADR-0009 drew, reached from the other side: a
caller cannot make the voice say something the model did not choose, and the
moderation that matters happens in the model rather than in a copy table.

The transcription is the other half of the exposure — the visitor's speech is
text on our key before it is text anywhere else — and it is bounded like
everything else: 256 KiB of audio per turn, twenty turns a minute, and a
transcript that goes no further than the brain's prompt.

### The shape: one request, one response, no socket

The exchange is a single HTTP round trip: audio up, words and audio down.

**No WebSocket and no second SSE stream.** The security whitepaper's never-list
carries "second SSE stream / WebSocket", and this host needs neither. The
monitor reads the host's phase over the ordinary HTTP the rest of the API
already uses, polled while a turn is in flight.

### The turn monitor is the host's record, not the client's

The API keeps the ledger. It is written by the party that did the work — the
transcription, the brain and the synthesis all happen on the host — so the
monitor cannot be a client-side claim about something the client made up.

Each exchange records what the visitor said, what Frenchy said, and **what each
step cost**. A step that did not finish has `null` for its duration, and `null` is
not zero: a step that never ran did not take no time, and a panel that printed
`0 ms` for it would be reporting a measurement that was never taken.

The host publishes the phase it is in (`transcribing`, `thinking`, `speaking`)
while the turn runs, so the panel shows the phase the host is actually in rather
than a guess made from a timer on the client.

### The words are the content; the audio is the garnish

If the synthesiser refuses, the transcript and the reply are still returned with
the failure named. A visitor who asked a question deserves the answer even on a
host whose voice has stopped working. The reverse is never true: audio without
words is decoration, and it does not stand in for the reply.

### The bounds, named

| Bound | Value | Why |
|---|---|---|
| Audio per turn | 256 KiB | ~16 s of Opus; a ceiling on what this process buffers |
| Turns per session | 40 | a conversation, not a log |
| Sessions per host | 50 | a ledger that grows without limit is a second outage |
| Session idle TTL | 30 min | the session is forgotten, not kept |
| Turns per minute | 20 | three provider calls each |
| Session reads per minute | 120 | the monitor polls while a turn runs |
| Body ceiling | per path, 256 KiB on `/sts/session/` | the default 64 KiB stays for every other route |
| Request timeout | 45 s on `/sts/session/` | three round trips; still a ceiling, not an absent one |

### The microphone is opened on one route

`Permissions-Policy: microphone=(self)` on `/voice`, and `microphone=()` on every
other route in the app. The narrow rule is registered **after** the global one,
because Next applies matching header rules in order and the last one to set a key
wins — put it first and every page would keep the microphone closed, which would
make the page look broken rather than deliberate.

## Consequences

- **ADR-0009 is not replaced.** The one-way host, the fixed copy, the muted
  default and the daily cap are all unchanged. This ADR supersedes only ADR-0009's
  rejection of the interactive variant; the reason it was rejected — "no
  microphone permission" — is the thing that changed.
- **The API holds one more kind of spend.** Transcription, brain and synthesis are
  three provider calls per turn. `STS_DISABLED=1` turns the whole host off, and
  `/sts/status` says which piece is missing rather than a flat "not configured".
- **A turn is a request, not a stream.** The visitor presses, speaks, presses
  again. Barge-in is not implemented: a visitor cannot interrupt an answer
  mid-sentence, and saying so is better than shipping a half-duplex that stutters.
- **Frenchy's grounding is now real.** The read model is a dependency of the route
  rather than a context variable nothing set. The answers are about this
  deployment, or the model says it does not know.
- **The session id is the only credential.** It is a UUID, it is unguessable, and
  anyone holding it can read that conversation. For a demo host whose
  conversations contain a wallet address and nothing else, that is the honest
  trade — and it is a trade, not a protection.
- **The turn cost is a measurement of three provider calls, not of the
  conversation.** A slow provider reads as a slow provider.

## Alternatives considered

- **A WebSocket to the provider, as Scribe Realtime already does.** Rejected for
  the turn host: the browser would hold the provider's socket, the API would hold
  no record of the turns, and the monitor would be a client-side account of
  something the client did. The Scribe path stays where it is — it is
  transcription for captions, and it has no ledger to keep.
- **The API proxying the provider's socket.** Rejected: it adds a long-lived
  connection to the host, and the never-list names exactly that. The HTTP round
  trip costs latency the demo does not notice and buys a host that can be
  reasoned about.
- **A server-sent-event stream of phases.** Rejected for the same reason: a
  second stream. Polling a phase over the ordinary HTTP is slower by a few
  hundred milliseconds and adds no surface.
- **Text in, audio out — a speech endpoint with the words supplied by the
  caller.** Rejected, and it is the rejection ADR-0009 made. It is an
  unmoderated text-to-speech endpoint on the public internet, which is the
  surface the provider's policy puts on the account holder.
- **The voice answering from the browser's own transcript.** Rejected: the
  browser's transcript is the client's word about what the visitor said, and the
  ledger would be recording a client claim.

## Evidence

- `apps/api/src/sts.ts` — the host, the ledger, the state machine, the bounds.
- `apps/api/src/frenchy.ts` — the shared brain, the shared voice, the grounding
  fix.
- `apps/api/test/sts.test.ts` — 26 tests; 15 mutations proven and restored.
- `apps/web/src/lib/sts.ts` — the client, the display rules.
- `apps/web/src/components/TurnMonitor.tsx` — the panel.
- `apps/web/src/app/voice/page.tsx` — the one page that may hear the room.
- `apps/web/test/sts.test.ts` — 18 tests; 7 mutations proven and restored.
- `apps/web/next.config.mjs` — the Permissions-Policy exception.
- `docs/key-inventory.md` — the credential this spends.
