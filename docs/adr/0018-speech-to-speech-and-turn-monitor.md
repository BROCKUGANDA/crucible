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

### The session credential is a bearer token, and it does not travel in a URL

`POST /sts/session` returns a **token** — 256 bits of randomness — and the token
is returned **once**. There is no route that hands it back, because a route that
gives a bearer credential back is a route that puts it in a log. The session's
public `ref` is the first eight characters of its digest: for a log line and a
panel heading, and **not** a credential, because it cannot open the session.

**It travels in a header** (`x-crucible-session`), never in a path. A path
segment travels: it lands in an access log, in the browser's history, and in a
`Referer` when the page links anywhere. A credential in any of those is a
credential in three places it was not meant to be. The routes are
`POST /sts/session`, `GET /sts/session` and `POST /sts/turn` — none of them
carries an identifier.

**The host holds only the digest.** The ledger is keyed by `sha256(token)`, so
the raw token exists in exactly one place — the browser that owns the
conversation — and a memory dump of the host is not a list of conversations.

The header is a custom one rather than `Authorization`, for a concrete reason:
the Fetch specification forbids a wildcard `Access-Control-Allow-Origin` on a
request that carries an `Authorization` header, and this API supports an
`ALLOWED_ORIGINS=*` deployment — the public anonymous reads the transport policy
describes. A custom header has no such rule, so the session works under both
shapes of the allowlist.

**What this is and is not.** It is a bearer credential: whoever holds it may
read that conversation. It is not an authenticated one — there is no signature
and no wallet, because the voice room works for a visitor who has not connected
one. A wallet signature would be the stronger gate and the wrong one here: it
would make the feature unusable for exactly the people who are not already
on-chain.

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

### A new turn supersedes the one in flight

The visitor answered again, so the answer to the previous words is not the answer
they want. A turn that arrives while another is running **stops** it: the
provider calls are torn down through an abort signal, and the ledger records the
superseded turn as **`interrupted`**.

`interrupted` is its own outcome and not a failure, because the two are
different facts: a failed turn is the host's problem, and an interrupted one is
the visitor changing their mind. A failed provider call says `failed`; a turn the
visitor answered over says `interrupted`, with the reason named.

The first word about how a turn ended is the one that stands: closing a turn is
idempotent, so a late handler cannot reopen a turn that a newer turn has already
superseded.

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
| Body ceiling | per path, 256 KiB on `/sts/` | the default 64 KiB stays for every other route |
| Request timeout | 45 s on `/sts/session/` | three round trips; still a ceiling, not an absent one |

### The microphone is open to this origin, and that is a correction

`Permissions-Policy: microphone=(self)` on every page, `microphone=()` nowhere.

The policy used to say `microphone=()` on every page — and the product has
shipped a voice control since 2026-10-28: the header's Frenchy panel asks for
the microphone, and `microphone=()` makes the browser refuse it **before the
visitor is ever prompted**. The button could not work, and the refusal it
produced told the visitor to change their browser settings, which was not what
was wrong. The policy contradicted the product.

`microphone=(self)` is the narrowest thing that lets the shipped feature work:
this origin may ask, no other origin may, and **the browser still asks the
visitor**. The microphone is requested only when somebody presses a button.

This is a correction to the deployment, not a widening of it, and it is recorded
here because the first draft of this ADR assumed the microphone was closed
everywhere and could be opened on one route. It could not: the header's panel is
global, so a route-scoped exception would have left the shipped control dead on
every page but one.

### Two voice paths, and what tells them apart

The header's Frenchy panel and the voice room are the same brain and the same
voice, and they are not the same conversation:

| | Header's Frenchy panel | The voice room |
|---|---|---|
| Transcription | the browser, against ElevenLabs Scribe Realtime | the **host**, against the same provider over HTTP |
| The turn record | none — the conversation lives in the browser | the host's ledger, with each step's cost measured |
| Answers with | words and voice | words and voice |

The difference is **whether the turns are kept**. The panel is the quick
question; the voice room is the conversation that is written down. Neither is a
second answer to the same question, and only one of them is a measurement.

Merging them — routing the panel through the speech host so there is one voice
path and one ledger — is the shape this would take if the panel were ever
rebuilt. It is not done here because it would rewrite a shipped panel, and
because the quick question and the recorded conversation are different products.

## Consequences

- **ADR-0009 is not replaced.** The one-way host, the fixed copy, the muted
  default and the daily cap are all unchanged. This ADR supersedes only ADR-0009's
  rejection of the interactive variant; the reason it was rejected — "no
  microphone permission" — is the thing that changed.
- **The API holds one more kind of spend.** Transcription, brain and synthesis are
  three provider calls per turn. `STS_DISABLED=1` turns the whole host off, and
  `/sts/status` says which piece is missing rather than a flat "not configured".
- **A turn is a request, not a stream.** The visitor presses, speaks, presses
  again. What a stream would buy is the ability to interrupt an answer
  mid-sentence; what it would cost is the long-lived connection the never-list
  names. The part of barge-in that is worth having is shipped: **a new turn
  supersedes the one in flight**, the interrupted work is torn down, and the
  ledger says `interrupted`. The part that is not shipped is interrupting the
  *playback* of an answer already in the browser's hands.
- **Frenchy's grounding is now real.** The read model is a dependency of the route
  rather than a context variable nothing set. The answers are about this
  deployment, or the model says it does not know.
- **The session credential is a bearer token, and it is not a URL.** 256 bits of
  randomness, returned once, travelling in a header, and held by the host only as
  a digest. Whoever holds it may read that conversation: for a demo host whose
  conversations contain a wallet address and nothing else, that is the honest
  trade — and it is a trade, not a protection. A wallet signature would be the
  stronger gate and the wrong one here, because the voice room has to work for a
  visitor who has not connected one.
- **The microphone policy was corrected, not narrowed.** The app shipped a voice
  control under a `microphone=()` policy, so the control could not work. The
  policy now matches the product. A deployment that wants the microphone closed
  should remove the control rather than the permission: a button that cannot
  work is a control that lies.
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
- **The session addressed by an id in the URL.** Rejected, and it was the first
  draft: an id in a path travels, and a credential that travels in an access log
  and in the browser's history is a credential in three places it was not meant
  to be. The token travels in a header instead, and the host keeps only its
  digest.
- **A wallet signature on the session.** Rejected: it is the stronger gate and
  the wrong one. The voice room has to work for a visitor who has not connected
  a wallet, and a gate that refuses the majority of its users is a gate that
  will be worked around rather than satisfied.

## Evidence

- `apps/api/src/sts.ts` — the host, the ledger, the state machine, the bounds.
- `apps/api/src/frenchy.ts` — the shared brain, the shared voice, the grounding
  fix, and the abort signal that supersedes a turn.
- `apps/api/test/sts.test.ts` — 34 tests; 8 mutations proven and restored for
  the credential and the superseding alone, on top of the 15 for the host.
- `apps/web/src/lib/sts.ts` — the client, the display rules, the token.
- `apps/web/src/components/TurnMonitor.tsx` — the panel.
- `apps/web/src/app/voice/page.tsx` — the one page that may hear the room.
- `apps/web/test/sts.test.ts` — 21 tests; 7 mutations proven and restored.
- `apps/web/next.config.mjs` — the Permissions-Policy correction.
- `docs/key-inventory.md` — the credential this spends.
- `apps/api/test/compose-env.test.ts` — the deployment hands the API every
  variable it reads, which is how the speech host's own switches were found
  missing from the container.