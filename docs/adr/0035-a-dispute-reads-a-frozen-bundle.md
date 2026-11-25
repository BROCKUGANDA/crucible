# ADR-0035: A dispute reads a frozen bundle, and the bundle says what it does not contain

- **Status:** accepted
- **Date:** 2026-11-20
- **Supersedes:** nothing
- **Relates to:** ADR-0005 (deterministic evidence first), ADR-0008 (in-memory indexer), ADR-0023 (PostgreSQL is app data; the chain is the authority), ADR-0033 (the tenancy model is durable), ADR-0034 (a published score carries its method and its limits)

## Context

A break can be filed against a trial. The chain records who broke it, what
they staked, and the proof they filed — but the **evidence** those facts
point to lived in three places that could each move on their own:

- the **disclosure log** (the sponsor's CID text), written by whichever
  process pinned the files;
- the **off-chain stores** — the pinned spec, the replay manifest, the
  scores — which are process memory (ADR-0008's in-memory indexer, and the
  replay manifest store, which is the same);
- the **content store**, which holds the bytes behind a CID.

Nothing froze them. A committee that read the evidence on Tuesday and again
on Thursday could read two different sets of facts, and neither read would
say which one was the evidence the parties broke the trial over. There was
also no way to state, in one place, that a piece of evidence was **absent**:
an omission and a completeness looked the same.

The published method (ADR-0034) fixed the same problem for scores. A dispute
has the same shape and a stronger requirement: the evidence is read by
people deciding whether money moves.

## Decision

**1. A bundle is a freeze, and it is content-addressed.**

A bundle carries what the chain said and what the platform measured, and
its address is the digest of its own contents (`bundle_` plus the first 32
hex characters). Consequences, the same as ADR-0034's:

- sealing the same evidence twice is the same bundle — the store keeps one
  row, not a pile of identical ones;
- a bundle **cannot be edited**. Any change produces a different address
  and a different row, and the old row keeps saying what it said. The
  append-only store enforces this at the database.

**2. The bundle states what it does NOT contain.**

The `gaps` array is part of the bundle's substance — it is inside the
digest. It says:

- the chain's facts are absent (the trial is not known to the chain
  reader, so nothing in the bundle is a chain reading);
- the chain committed to no spec digest;
- the sponsor has not disclosed the suite;
- no break has been filed, or a break was filed without its proof;
- no replay manifest was recorded, so the bundle carries no measurement at
  all;
- fewer than the three required replays were recorded;
- the replays did not agree;
- no aggregate score was recorded, so none of the numbers is a grade.

An omission that is not stated reads as a completeness. That is the whole
reason the gaps are inside the address: a bundle cannot carry a gap list
that was edited afterwards to look tidier.

**3. The seal is compared with the dispute on the CHAIN's clock.**

`predatesDispute` answers the question that decides whether a bundle is
usable: was it sealed before the trial was broken? A bundle sealed
afterwards may contain evidence the parties never saw, and a committee
deciding on it would be deciding on a record that did not exist when the
dispute opened.

The comparison is chain-seconds against chain-seconds. The host's wall
clock is a different clock — the indexer's own rule is that a client
anchors on `max(headTimestamp + 1, now)`, precisely because the chain's
clock and the host's are not the same — so when this host cannot read the
chain's clock the answer is **unknown**, never a guess across two clocks.
A guess here decides whether a committee is reading the parties' evidence.

**4. The bundle is durable.**

`dispute_evidence_bundles` is a PostgreSQL table (migration 0015). The
store is chosen once at boot, never per request (ADR-0033's rule): a record
written to one store and read from another is a record that lies. Without
`DATABASE_URL` the API runs on the in-memory store and says so.

**5. A caller may not state the evidence.**

`POST /v1/disputes/:trialId/bundle` accepts nothing but the trial id in the
path and refuses a body carrying `gaps`, `digest`, `chain`, `measurement`,
`sealedAt`, `bundle`, `score` or `verdict` — by name, whatever the value.
A bundle is a statement about what the platform saw; a bundle a caller can
write is a bundle nobody can rely on.

**6. The chain facts come from the same read model the rest of the API
reads**, so a bundle's chain facts and the trial page's chain facts cannot
disagree.

## Consequences

**What this buys.** A committee reads one addressable artefact. The
evidence cannot move under it, the absence of evidence is stated rather
than implied, and the order of the seal against the break is checkable by
anyone with the two timestamps.

**What it costs.** A bundle freezes a moment. Evidence that arrives later
is not in it, which is why the gaps say what was missing at the seal; a
fresh freeze produces a different address, and both are kept.

**What it does not fix.** The off-chain stores the bundle reads are still in
process memory (REPL-D1): a measurement can be lost on restart even though
its bundle survives. The bundle is then a record of something that cannot
be re-derived, and that gap is named in `CRUCIBLE_AUDIT.md`. The content
store itself is a host-local directory in this deployment, so "the bytes
behind this CID" is available only on the host that pinned them.

## Rejected

- **A live view of the evidence.** A committee reading a moving target is
  the failure this exists to prevent.
- **Free-text notes instead of derived gaps.** A note is a promise; a
  derived gap cannot disagree with the data it describes.
- **Comparing the seal against the dispute on the host's clock.** Two
  clocks; the chain's dispute time is on the chain's clock.
- **Guessing the order when the chain's clock cannot be read.** "Unknown"
  is the honest answer, and the question it answers decides what a
  committee reads.
- **Letting the caller supply the bundle.** Then it is a document, not
  evidence.

## Proof

- `apps/api/test/evidence-bundle.test.ts` — the bundle carries the chain's
  facts and the platform's measurement and nothing either of them did not
  say; the gaps are stated; the address is content-addressed; the digest
  can be recomputed and a tampered bundle fails the check; the
  seal-against-dispute comparison uses the chain's clock and says "unknown"
  when that clock cannot be read.
- `apps/api/test/evidence-bundle-routes.test.ts` — the route refuses a
  caller-supplied bundle, refuses an unauthenticated seal, and reads back
  what it sealed.
- `apps/api/test/evidence-bundle-pg.test.ts` — against a real PostgreSQL:
  the bundle survives a fresh read, a later write with the same id cannot
  rewrite it, and the bundles of a trial are listed oldest first.
- `.scratch/mutate_evidence_bundle.py` — **nine** mutations, all proven red:
  dropping the "the suite was not disclosed" gap, dropping the "no replay
  manifest" gap, assuming the replays agreed, ignoring the timestamps
  entirely, comparing against the host's clock, comparing when the chain's
  clock is unreadable, a digest verification that always passes, a route
  that accepts a caller's bundle, and a store that lets a later bundle
  overwrite a frozen one.
  **One of them was green on the first attempt** — the "the suite was not
  disclosed" gap, because the assertion matched a substring that ANOTHER
  gap also contained ("the break's proof was not disclosed"). The
  assertions now name the exact sentence, and the mutation is red.
- End to end over HTTP against the live chain (`.scratch/BundleProof.mjs`):
  trial 1's real facts — sponsor `0x976EA7…`, status settled, verdict paid,
  the committed spec digest, the break and its proof — sealed into a
  bundle with three stated gaps, re-sealed to the same address, read back,
  and a caller-supplied bundle refused.
- Browser verification of `/disputes/1` against the running API and a live
  PostgreSQL (screenshot in `.scratch/shots/dispute-bundle.png`).
