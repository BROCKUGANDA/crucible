# ADR-0008: In-memory indexer for the demo

- Status: Accepted
- Date: 2026-10-21

## Context

The API serves a read model of the chain: trials, agents, runs, hall rows and
the published books. The external PRD specifies Ponder, Postgres/Neon, BullMQ,
Redis and IPFS/Pinata. This repository uses a `Scribe` that reads logs and
projects them into `Map`s, with an optional cursor file for restarts. There is
no database, queue or pinning service.

## Decision

Keep the in-memory projection for the demo. The API and indexer run in one
process; the read model is rebuilt from the chain on restart. The cursor file is
optional and only prevents a full re-scan. No route writes to a database, and
the API remains a read service.

## Consequences

- A restart replays the chain (cheap on the demo, expensive on a long chain).
- The rate limiter and auth nonces are process-local; neither is a global
  consistency or abuse control behind multiple instances.
- The Hall can be rebuilt from logs; a missed log is a real gap, which is why
  the indexer has cursor persistence, sharding, bloom cross-checks and a reset
  path.
- Production scale (Ponder/Postgres/queues, object storage, IPFS pinning) is a
  new architecture ADR, not a dependency swap.

## Alternatives considered

- **Add Postgres/Ponder now.** Rejected for the demo: it adds a stateful
  service the one-command verification path would have to provision and
  migrate, without changing any product invariant.
- **Pure chain reads per request.** Rejected: every page refresh would become
  an RPC fan-out; the indexer exists to decouple request volume from chain
  reads.

## Evidence

- `packages/indexer/src/model.ts` — the `Map` projection.
- `packages/indexer/src/scribe.ts` — log reading, cursor, reset and backfill.
- `apps/api/src/app.ts` — snapshot routes over `deps.getModel()`.
- `compose.yaml` — anvil, seed, api, keeper, web; no database service.
