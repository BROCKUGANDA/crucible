# ADR-0031: A sponsor's funding is a chain fact

**Date:** 2026-11-20  
**Status:** Accepted  
**Related:** ADR-0006 (API Holds No Chain Key), ADR-0022 (Organisation Tenancy), ADR-0023 (Production Infrastructure), ADR-0029 (Chain Environments), ADR-0030 (One Worker)

## Context

The sponsor programme that shipped with Phase 8 had a budget accounting
model with eight states, a validation function, and a "deposit to escrow"
call. The deposit call did this:

```ts
export function depositToEscrow(programId: string, amountWei: string): boolean
```

The API believed it. Nothing checked the chain. The consequence is the one
that matters commercially: a sponsor console could show "fully distributed"
for a programme that paid nothing, and a programme could report a budget the
escrow never held. Three truths were supposed to be separated — the chain's,
the evaluation's and the commercial ledger's — and only the commercial ledger
existed.

The programme state was also held in the API process's memory: restarting the
API lost every sponsor, every programme and every budget line.

## Decision

### 1. A funding claim is recorded, then checked against the chain

Two tables, in migration `0011_sponsor_funding_chain_truth.sql`:

- `sponsor_funding_claims` — what the programme claims it funded: the arena
  trial id, the sponsor address the money is claimed to have come from, the
  amount in wei, and the posting transaction if it is known.
- `sponsor_funding_receipts` — what the chain said when the claim was
  checked, appended and never overwritten.

A claim counts for NOTHING until the chain confirms it. The claim is written
BEFORE the check, so a claim the chain contradicts leaves a record: a claim
that was never written cannot be reported as false.

### 2. The sponsor's escrow is `reward + fee`, never `deposited`

The arena's `amountsOf` returns the reward, the fee, the bond, `deposited`
and `paidOut`. `deposited` is the ghost ledger of every wei the trial ever
took in, which includes the agent's bond and the skeptics' stakes. The
sponsor's own escrow is `reward + fee`, the reward the sponsor posted plus
the arena fee it paid on top.

Reporting `deposited` as the sponsor's money would overstate every sponsor's
funding by the bonds in the arena — the same class of error as rendering a
figure nobody read.

### 3. The fee is READ from the chain, never recomputed

The contract computed the fee at post time from `ARENA_FEE_BPS` and stored
it. A reader that recomputed it could disagree with the escrow by a wei, in a
way no test would ever see, in a direction nobody could predict. The receipt
stores what was read.

### 4. `unverifiable` is not `mismatch`

Three verdicts, kept apart:

- **verified** — the chain holds what the programme claims, from that
  sponsor.
- **mismatch** — the chain was read and it says something else.
- **unverifiable** — the chain could not answer: no such trial, an
  unreachable node, a trial with no sponsor.

A node that is down must not be recorded as a sponsor who did not pay. The
two failures are reported differently because they mean different things to
the person reading them, and conflating them would let an outage manufacture
accusations.

The check order is deliberate: the trial exists → the chain could be read →
the trial has a sponsor → the trial's sponsor IS this sponsor → the amount
matches. The fourth check is the one that matters most: without it, one
sponsor's programme could present another sponsor's trial as its own funding.

### 5. Both totals are reported

`verifiedWei` (what the escrow holds) and `claimedWei` (what the programme
says it paid) are returned together. Their difference IS the finding. A
console showing only the verified number hides a dispute; one showing only
the claimed number hides a shortfall.

Only verified receipts count toward the verified total. A receipt that could
not be verified is neither counted as zero (which understates) nor as
present (which overstates).

### 6. Reconciliation is a scheduled job, and it reports what it could not do

The worker runs the reconciliation every ten minutes (ADR-0030). It compares
each claim against the chain and each programme's ledger total against the
chain's confirmed total for that programme's trials.

When the deployment has no chain configured, the sweep reports `ran: false`
with the reason. It does not report "zero drift", which would say "everything
is fine" about a sweep that never looked.

### 7. The chain-truth layer does not depend on the programme scaffolding

The claims table carries `org_id` and a text `program_id`, deliberately not a
foreign key onto `sponsor_programs`. The chain truth must not depend on the
programme store being in the same state of migration: a claim that outlives
a storage rewrite is worth keeping, and a claim that cannot be written is
not. The RLS boundary is the tenant, which exists in every deployment.

## Consequences

- The sponsor's money is verifiable, and the verification is recorded with a
  receipt that says what the chain said and when.
- The API still holds no chain key (ADR-0006): verification is a public
  read over RPC (ADR-0029).
- The programme scaffolding (sponsors, programmes, budget lines) is still
  held in the API process's memory. THAT IS STILL OPEN and is the next piece
  of work on the commercial track: the functions synchronous, so the store
  has to become asynchronous, which is a breaking change to the routes and
  to their tests. The chain-truth layer was built to survive that rewrite.
- The reconciliation is the first component of the reconciliation service
  that mainnet release requires; it currently compares the sponsor ledger
  only, and the evaluation and settlement truths are still to be folded in.
