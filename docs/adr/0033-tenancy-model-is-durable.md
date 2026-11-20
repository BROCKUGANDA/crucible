# ADR-0033: The tenancy model is durable, and the store is a cache over it

- **Status:** accepted
- **Date:** 2026-11-20
- **Supersedes:** nothing (extends ADR-0008's single-process assumption for the tenancy model only)
- **Relates to:** ADR-0008 (in-memory indexer), ADR-0023 (PostgreSQL is app data; Redis/BullMQ is delivery only), ADR-0032 (the sponsor's ledger is durable), ADR-0006 (the API holds no chain key)

## Context

`packages/agent-security/src/org-store.ts` held the tenancy model — who may
see what — in process memory, and its own header said so:

> *Persistence is explicitly deferred: no database or queue is introduced
> without a new ADR.*

Two things were wrong with that deferral, and neither was about performance.

**A restart lost it.** The tables existed (migration 0002) and were never
written to: nothing in the repository ever inserted an organisation. The
memberships that the funding claims, the sponsor programmes and the row-level
policies all reference were, in a real deployment, rows that did not exist —
which is why migration 0012 had to drop the foreign keys that could only ever
refuse a legitimate write (ADR-0032).

**Two workers could disagree.** The store is kept on `globalThis` so a
dev-server hot reload does not empty it mid-flow. Under Octane — the
deployment shape this repository ships — every worker process has its own
`globalThis`. So an organisation created on worker A was invisible on worker
B, and a membership check answered "no" on one worker and "yes" on another,
depending on which process answered. The API's tenancy decisions are
money-adjacent: they decide who may read a sponsor's funding ledger.

## Decision

**1. The tenancy model is durable.** Organisations, workspaces, memberships,
invitations and resource ownership are written to PostgreSQL. The store
becomes a **cache over** that backing rather than the store itself:

- **Reads** are answered from the cache, synchronously, because
  `isMemberOf` is on the hot path of every request and must not become a
  database round trip.
- **Writes** go to the database **first** and to the cache **second**. A
  record that is visible in the cache but not in the database is a record a
  restart would lose, and a caller told "created" would have been told a
  lie.
- **The cache is refilled from the database at boot**, and it is *replaced*,
  not merged: a row that is gone from the database is gone from the cache.

**2. The non-durable path is refused while a durable backing is attached.**
The synchronous mutators throw if a backing is configured, with a message
naming the durable alternative. A write that only reaches the cache is
prevented rather than documented — and with no database configured they keep
working exactly as before, which is what the unit tests use.

**3. The membership constraint is corrected.** The old constraint was UNIQUE
over `(org_id, principal_id)` — ANY second membership for a principal in an
organisation, including a revoked one — so a member who was removed and came
back could not be recorded, even though the domain is explicit that
revocation takes effect and a membership can be granted again. It becomes a
partial unique index over the **active** memberships: one live membership per
principal per organisation, with the history kept.

**4. The organisation's author is recorded.** The domain has an author as
well as an owner; the table had only the owner. `organisations.created_by` is
added, and rows that predate it are backfilled from their owner.

## What this does not do

- **The row-level policies are still inert.** PostgreSQL does not apply RLS
  to a table's owner, and the API connects as the owner. The policies in
  migrations 0002–0013 read
  `current_setting('crucible.current_principal_id', true)`, so they mean
  something only when the principal is set for the request AND the API
  connects as a separate, non-owning role. That is the next step of this
  ADR and it is a **deployment** change (two roles: one that owns the schema
  and migrates it, one the application connects as), not a code change. Until
  it lands, the tenant boundary is enforced in the route layer, exactly as it
  was — this ADR makes the *records* durable, not the *enforcement* twice.
- **The org-scoped side models are still in memory**: budgets, audit
  entries, conflict-of-interest declarations, webhooks and API keys. They are
  named in the open list in `HARDENING.md`. They hang off an organisation
  that is now durable, which is the precondition for making them durable too.
- **Nothing here moves money.** The escrow is native ETH, settlement is
  pull-only, and the API holds no chain key (ADR-0006).

## Consequences

- An organisation and its members survive a restart: proven by writing one
  through the API, killing the process, starting a new one and reading it
  back (`tenancy: postgresql — 1 organisation(s), 1 membership(s)`).
- Two processes now agree, because both read the same rows. The cache
  narrows the window between writes, it does not create a second truth.
- The store's read path is unchanged in cost, and the write path now costs a
  round trip. That is the trade, and it is the right one for the records
  that decide who may see money.
- The API says at boot which tenancy it is using, so a deployment does not
  have to be read to find out.