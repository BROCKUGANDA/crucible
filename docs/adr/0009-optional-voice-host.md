# ADR-0009: Frenchy is optional, server-proxied and muted by default

- Status: Accepted
- Date: 2026-10-21

## Context

The external PRD specifies Frenchy, an ElevenLabs voice host: a greeting, a
tour, reading a task aloud and a celebratory line on a paid verdict, with
silence on failures, a once-a-day cap and reduced-motion respect. The product
has no audio today, and a vendor key in the browser would be a public secret.

## Decision

Implement Frenchy as a one-way TTS host:

- The API proxies ElevenLabs; the key and voice id are server-side.
- The copy is a fixed server-side set of moments. Only the `spec` moment accepts
  caller text, capped at 600 characters.
- The web control is muted by default; one button enables it; a Tour button is
  available once on.
- Automatic speech is allowed at most once per local day. A manual Tour or
  unmute click may bypass the daily cap; a paid verdict announcement does not.
- Automatic speech is disabled under `prefers-reduced-motion`.
- Only a paid verdict triggers the verdict line, and only while the quench panel
  is visible. Slashes, refunds, errors, disputes, forms and withdrawals are
  silent.
- A missing key, a provider error, a blocked autoplay or a codec failure is
  silence; the page is unchanged.
- The catchphrase is used on the first paid verdict of a session; later ones use
  a different line.
- The API has an 8/minute voice bucket and a `VOICE_DISABLED=1` kill switch.

## Consequences

- This is not a conversational agent: no microphone, no speech-to-text, and the
  "8-second goodbye" in the PRD prompt is not applicable.
- "Read the spec aloud" is not wired because the web has only the spec CID, not
  its text. The `spec` moment exists for a future spec viewer.
- The API now holds one non-chain provider key. It spends TTS credits, not
  escrow; see `docs/key-inventory.md`.
- The feature is invisible until `GET /voice/status` reports configured.

## Alternatives considered

- **ElevenLabs key in the browser.** Rejected: public key and unbounded spend.
- **An interactive voice agent (WebSocket + STT).** Rejected for this pass: the
  product has no microphone permission and the demo does not need a
  conversation.
- **Browser speech synthesis.** Rejected: not the specified voice, and the demo
  needs a consistent French accent.

## Evidence

- `apps/api/src/voice.ts` — fixed moments, proxy, 8/minute bucket.
- `apps/web/src/lib/voice.ts` — daily cap, reduced motion, catchphrase.
- `apps/web/src/components/VoiceControl.tsx` — muted default, greeting, tour.
- `apps/web/src/app/trials/[id]/page.tsx` — paid-verdict-only announcement.
- `README.md` — the voice-host section.
