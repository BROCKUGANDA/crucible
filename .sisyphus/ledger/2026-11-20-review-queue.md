# Review queue — the reviewer's surface, and the bar a conflict puts on it

**Date**: 2026-11-20
**Branch**: `develop`
**ADR**: 0039 (`docs/adr/0039-a-review-queue-bars-whoever-has-a-conflict.md`)

## Why this slice

The conflict register (ADR-0038) and the audit chain (ADR-0037) were both
durable and both had **no consumer** — a declaration could be recorded and
then change no decision. A conflict of interest that changes no behaviour is
a decoration. The reviewer surface was the named next piece of product work
in the assessment, and it is the P1 surface that had no consumer at all.

## What was built

| File | What it is |
|---|---|
| `apps/api/src/review-queue.ts` | the cases (chain-derived), the reviewer's state, the refusals |
| `apps/api/src/review-store.ts` | the reviewer's own state behind a store interface; chosen once at boot |
| `apps/api/src/review-pg.ts` | the durable store (PostgreSQL) |
| `apps/api/src/review-routes.ts` | `GET /v1/reviews`, `POST /v1/reviews/:trialId/{claim,abstain,conflict}` |
| `migrations/0019_review_claims.sql` | `review_claims` (one case, one holder), `review_abstentions` |
| `packages/agent-security/src/org-coi.ts` | `conflictsWithOrg` — the reviewer's declared interest IN an organisation |
| `apps/web/src/app/reviews/` | the page |
| `apps/web/src/lib/useReviewQueue.ts` | the client |

## The decisions

- **The cases are chain-derived.** A trial `judging` or `challenged`. NOT
  `disputeOpenedAt !== null`: that flag says a dispute was *opened at some
  point* and stays set after the trial settles, so reading it as "still
  open" puts every settled-and-disputed trial back on the queue.
- **The reviewer's own state is durable.** A queue that forgets its claims
  after a restart is a queue where two reviewers believe they hold the same
  case.
- **One case, one holder** — the uniqueness is on the case, not on the pair.
- **A conflict BARS, it does not warn.** The case is not offered; a direct
  claim is refused with the reason; declaring releases the claim.
- **The sponsor is not a principal in the register**, so the bar asks two
  questions: a shared interest (`conflictsBetween`) and a declared interest
  *in* the sponsor (`conflictsWithOrg`). The declaration names the
  organisation, which for a trial is the sponsor's address.
- **The actions are audited**, and an entry is an EVENT: the id is unique per
  event, because the chain is append-only and a collision is a refusal, not
  an idempotent success.

## Defects found (three of them by the browser proof)

1. **The page never re-read the queue** (REVIEW-D2). The actions fired, the
   API did the work, the screen kept the state from before the click. Fixed:
   the page reads the queue with the actions' refresh token.
2. **The audit id collided → HTTP 500** (AUDIT-D2). `audit-review-claim-<trial>-<reviewer>`
   against an append-only chain with a unique id: the second claim of the
   same case was a database error rather than a sentence. Fixed: unique ids
   per event, and `already-yours` with a reason.
3. **A settled trial was offered** because `disputeOpenedAt` was read as
   "the dispute is still open". Fixed by the chain's own status.

## Evidence

- 13 API tests (`apps/api/test/review-queue.test.ts`), 9 PostgreSQL tests
  (`apps/api/test/review-pg.test.ts`).
- **10/10 mutations proven red** (`.scratch/mutate_review.py`). Two were
  green on the first attempt and had to be made honest:
  - M7's test asserted a consequence that did not depend on the decision (a
    claim that stayed held by a conflicted reviewer was invisible until
    another reviewer was blocked by it) — the test now claims the case as a
    second reviewer does;
  - M6/M10 were SKIPPED because their anchors no longer matched the code
    after the edits — the mutation was skipping its own test.
- Browser proof: `.scratch/review-queue-ui.spec.ts` → 1 passed; screenshot
  `.scratch/shots/review-queue.png`. The page shows trial 5 with "YOU HOLD
  THIS CASE" — a claim made **before the API was restarted** — and the
  reward as `0.5 ETH` with "test ETH worth nothing on this chain", and an
  em dash for the sponsor that has not disclosed its suite.
- The local chain was given two real cases by running the repo's own golden
  path, phase A: `forge script script/GoldenPath.s.sol:Begin` → trial 5
  `challenged`, trial 6 `judging`.

## Still open, named

- A hold has no timeout (a reviewer who stops leaves the case held).
- The review verdict itself is not modelled.
- The seat assignment is still unscreened by the register.
- Budgets and quotas, webhook endpoints, API keys: still in process memory
  (AUTHZ-D1).
- REPL-D2: migration 0008's dead `replay_manifests`/`replay_records`.
- The RLS role split (the API still connects as the table owner).

## Next

The RLS role split, or the remaining in-memory org side models
(budgets/webhooks/API keys) — the same AUTHZ-D1 slice — or REPL-D2.
