# ADR-0032: The sponsor's ledger is durable; the organisation model is not (yet)

- **Status:** accepted
- **Date:** 2026-11-20
- **Supersedes:** nothing
- **Relates to:** ADR-0008 (in-memory indexer, single-process deployment), ADR-0006 (the API holds no chain key), ADR-0011 (the arena's generated parameters)

## Context

The sponsor console shows two ledgers side by side: what the platform's own
ledger claims, and what the escrow on the chain holds. The point of showing
both is that their difference is the finding. That only works if the first of
the two survives a restart.

It did not. Three pieces of state were in process memory:

| State | Where it lived | After a restart |
|---|---|---|
| The sponsor's own record (name, wallet, contact, onboarding steps) | `apps/api/src/sponsor-onboarding.ts`, a `Map` | gone |
| The programme and its eight budget counters | the same `Map` | gone |
| The budget's own ledger of movements | the same `Map` | gone |

Meanwhile the funding claims and receipts — the chain truth — were durable in
PostgreSQL, with a foreign key to a programme that no longer existed, and a
foreign key to an organisation that had never existed.

Measured against a real PostgreSQL 17, not inferred:

```
insert or update on table "sponsor_funding_claims" violates foreign key
constraint "sponsor_funding_claims_org_id_fkey"
```

**Nothing in this repository ever inserts an organisation.** The tenancy
model is deliberately in process memory: `packages/agent-security/src/org-store.ts`
says so in its own header — *"Persistence is explicitly deferred: no database
or queue is introduced without a new ADR."* ADR-0008 made the same choice for
the indexer.

So the funding claims path — the heart of "a sponsor's funding is a chain
fact" — could not record a claim in any real deployment, and the
organisation table's foreign key was the reason.

## Decision

**1. The sponsor's ledger moves to PostgreSQL.** Sponsors, programmes,
budget counters and the budget's own ledger are durable, through a
`SponsorStore` interface with two implementations: the in-memory one (the
default, and what the tests use) and the PostgreSQL one (what a deployment
with `DATABASE_URL` gets, chosen once at boot in `apps/api/src/server.ts`).
The domain rules stay in the domain module; only the records move.

**2. The foreign keys to `organisations` are dropped** (`sponsor_funding_claims`
and `sponsor_programs`). The tenant boundary does not move: it is enforced in
the route, against the in-memory membership model that is the actual source of
truth today (`isMemberOf`), and the row-level policies in the migrations
still carry the same rule for the day the organisation model becomes durable.
What is removed is a constraint that could only ever refuse a legitimate
write.

**3. The organisation model stays in memory, and that is now a named gap**
rather than an accident. It is recorded in `CRUCIBLE_AUDIT.md` as
AUTHZ-D1 and in `HARDENING.md` as open. Making it durable is the next ADR,
and it needs the migration runner, the revocation list and the RLS policies
to agree on one tenancy model — it is not a side effect of this slice.

**4. `paid` is cumulative, and `withdrawn` is cumulative.** A withdrawal
does not reduce `paid`: it is part of it. The old behaviour (a withdrawal
decrementing `paid`) contradicted the invariant this module publishes —
`validateBudgetConsistency` requires `paid >= withdrawn`, and a balance that
shrinks as fast as it is withdrawn can never satisfy it. Two withdrawals of
60 against a paid total of 100 are now refused, because the second of them
would pay out more than was paid.

**5. A ledger has an order.** `budget_entries` and `sponsor_funding_receipts`
carry a `BIGSERIAL` `seq`, and the ledger is read by `seq`. Two movements
written in the same millisecond (a deposit writes two entries) previously
sorted by a random id, so the order changed every run.

## Consequences

- A sponsor, a programme and its budget survive a restart. Proven by
  writing them through the API, killing the process, starting a new one, and
  reading them back.
- The API says at boot which ledger it is using: *"sponsor ledger:
  postgresql (survives a restart)"* or, without a database, *"sponsor ledger:
  in memory — sponsors, programmes and budgets are lost on restart"*. A
  deployment does not have to be read to find out.
- The budget movements happen in a transaction with a row lock, so two
  concurrent movements cannot both read "payable = 1 ETH" and both write
  "payable = 0".
- Wei leaves the API as decimal strings. `JSON.stringify` throws on a
  `bigint` rather than rounding it, which had made the programme routes fail
  outright; the serializers are now explicit about every wei they carry.
- The organisation model is still in memory. A multi-process deployment would
  have two processes with two views of the tenancy model, and that is the
  next thing to fix, not this one.

## What this does not claim

- The organisation model is not durable, and the row-level policies in the
  migrations are inert until it is.
- The budget's ledger is append-only but not signed: it records what the
  platform did, not what the chain confirmed. The chain truth is the
  funding receipts (ADR-0031).
- Nothing here moves money. The escrow remains native ETH, the settlement
  remains pull-only, and the API still holds no chain key (ADR-0006).
