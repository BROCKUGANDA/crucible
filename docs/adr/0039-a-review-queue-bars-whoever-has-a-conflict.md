# ADR-0039 — A review queue bars whoever has a conflict, and holds its state durably

- **Status**: accepted
- **Date**: 2026-11-20
- **Deciders**: platform engineering
- **Supersedes**: none
- **Relates to**: ADR-0023 (the chain is the money authority), ADR-0033 (tenancy is durable), ADR-0037 (the audit chain is durable), ADR-0038 (the conflict register is durable)

## Context

Two of the three things this platform was built to do — measure an agent's work, and
let paid skeptics try to break the claim — have a product surface now (the published
method card, the frozen dispute bundle). The third did not: **a reviewer had nowhere to
work and no way to be screened**.

What a reviewer does with a case is three things, and only one of them was representable
anywhere in the system:

1. take a case;
2. step away from one;
3. declare a conflict of interest with one.

The third was the hard one. The conflict register exists and is durable (ADR-0038), and
the audit chain exists and is durable (ADR-0037) — and **nothing consumed either**. The
register was a filing cabinet with no door: a declaration could be recorded and then have
no effect on any decision anywhere in the platform.

That is the same class of defect as ADR-0033's: a fact the system records and then never
reads. A conflict of interest that changes no behaviour is a decoration.

## Decision

**A review queue is a real surface, and it enforces three things.**

### 1. The cases are CHAIN-DERIVED; the reviewer's own state is DURABLE

A case is a trial whose status is `judging` or `challenged` — the windows in which the
evidence exists and the chain has not settled it. Those are facts the chain holds, and the
indexer re-reads them, so the queue is not a memory.

What the chain does **not** hold is the reviewer's side of it: who holds a case, who
stepped away, and why. That lives in PostgreSQL (`review_claims`, `review_abstentions`,
migration `0019`), behind the same store-once-at-boot rule as ADR-0033.

A queue that forgets its claims after a restart is a queue where two reviewers believe
they hold the same case, and the second one to finish is refused by the platform for no
stated reason.

**One case, one holder.** The uniqueness is on the *case*, not on the pair: a pair's
uniqueness would allow one reviewer to hold many cases while two reviewers could hold
one.

### 2. A conflict BARS a reviewer from a case; it is not a warning

A reviewer with a recorded conflict is **not offered** the case, and a direct claim is
refused with the reason. A conflict that is merely displayed is a conflict a reviewer in a
hurry can ignore, and the review would then carry a conflict nobody was told about at the
moment it mattered.

The bar is the platform's, not the reviewer's memory. Declaring a conflict releases the
reviewer's claim on that case — a bar that left the claim standing would block the case
for everybody else too.

**The sponsor is not a principal in the register**, so "shares an interest with the
sponsor" cannot be the whole test: the sponsor has no entry to share with. The reviewer's
own declaration names the organisation the interest relates to, and for a trial that is
the sponsor's address. `conflictsWithOrg` is that query; `conflictsFor` asks both
questions and unions the answers.

### 3. The ACTIONS are audited; the QUEUE is derived

Taking a case, stepping away from one and declaring a conflict are three entries in the
durable audit chain (ADR-0037). The chain is append-only, so an entry is an **event**: a
second claim of the same case is a second event with its own id, not a repeat of the
first. (An id derived from the action alone collides with the first one, and a collision
on an append-only chain is a refusal, not an idempotent success — that defect was found
by the browser proof, not by the tests, and it produced a 500.)

## Consequences

**Good**

- The conflict register and the audit chain now have a consumer: a declaration changes
  what the platform will let a reviewer do, and it is recorded in the chain.
- The reviewer's own state survives a restart, and the boot log says which store is in
  use (`[crucible] review queue: postgresql (a claim survives a restart)`).
- A settled trial is not a case. `disputeOpenedAt` says a dispute was *opened at some
  point* and stays set after the trial settles; reading it as "the dispute is still open"
  would put every settled-and-disputed trial back on the queue — a question the chain has
  already answered.

**Bad, and named**

- The queue is only as good as the trial statuses the chain reports. A trial that the
  indexer has not learned about yet is not in the queue; the queue says `store` and shows
  what it has, so a reader can tell an empty queue from a stale one only by looking at
  the chain.
- The review action itself (reading the evidence, writing a verdict) is **not** modelled
  yet. What is modelled is the queue, the hold, the abstention and the conflict. A
  reviewer who takes a case and then does nothing leaves it held; there is no timeout on
  a hold, because a hold that expires on a timer would push work back onto the queue with
  no way for the platform to know whether the reviewer was slow or gone. That is a real
  gap, and naming it is better than inventing a timeout that would silently withdraw
  work from a reviewer who was, in fact, working.
- The declared conflict is the reviewer's own statement about themselves. The platform
  records what was declared; it does not decide whether the declaration was true.

## References

- `apps/api/src/review-queue.ts` — the cases, the state, the refusals
- `apps/api/src/review-store.ts`, `apps/api/src/review-pg.ts` — the durable reviewer's own state
- `apps/api/src/review-routes.ts` — `GET /v1/reviews`, `POST /v1/reviews/:trialId/{claim,abstain,conflict}`
- `migrations/0019_review_claims.sql`
- `packages/agent-security/src/org-coi.ts` — `conflictsWithOrg`
- `apps/web/src/app/reviews/` — the surface
