# ADR-0030: One worker, one process, no stubbed jobs

**Date:** 2026-11-20  
**Status:** Accepted  
**Related:** ADR-0023 (Production Infrastructure), ADR-0025 (Forge Watch Runtime Monitoring)

## Context

The tree had two candidates for "the background worker", and neither was a
worker.

`apps/api/src/worker.ts` claimed three queues (`evaluations`, `telemetry`,
`maintenance`) and registered processors that returned `{ status:
"scheduled" }`, `{ delivered: true }`, `{ captured: true }`, `{ cleaned: true }`,
`{ reset: true }` and `{ reconciled: true }` — six behaviours that reported
success without doing the thing they named. It was a measurement reporting
empty, which this repository's rules forbid outright.

Two further faults were in the same file:

- **The repeat pattern was broken.** Each maintenance job re-added itself
  with a delay to run again later. BullMQ keeps completed jobs by default, so
  the re-added job carried an id that a completed job already held, the add
  was swallowed, and a job scheduled to run every hour ran exactly once and
  then stopped — silently.
- **Nothing ran it.** The compose `worker` service passed
  `command: node dist/worker.js`, and the API's entrypoint script ignored its
  argument and always started `dist/server.js`. So the "worker" service was a
  second API server, and `worker.ts` was never executed anywhere in the
  deployed stack.

Meanwhile `packages/agent-security/src/telemetry-service.ts` did one real
thing properly — it delivered Forge Watch telemetry — but was named as *the*
telemetry service, so a second scheduling path grew beside the stub one.

## Decision

### 1. There is one worker entrypoint: `apps/api/src/worker.ts`

It starts the telemetry pipeline, registers its scheduled jobs, drains,
reports and shuts down. The reusable parts live in
`packages/agent-security/src/worker-service.ts`; the entrypoint owns the
process.

The compose `worker` service now runs it, and the API's docker entrypoint
switches on an explicit role argument (`api` or `worker`). An unknown role
is an error, not a fallback: a container that silently runs the wrong process
cannot be trusted to be doing what its service name says.

### 2. A job is registered only if it does real work

Every branch of the maintenance consumer performs its work. `outbox-retention`
deletes delivered outbox rows past the retention window; `dead-letter-report`
surfaces the pending dead letters; `funding-reconciliation` compares the
commercial ledger against the chain.

Two plausible jobs were deliberately NOT registered:

- **`quota_reset`.** Quota usage is computed from the events inside the
  current period (the periods are UTC-bounded), so there is no counter to
  reset. A job that increments a metric nobody reads is decoration.
- **`cache_cleanup`.** The Redis cache expires its own keys by TTL. Cleaning
  up expired keys is Redis's job, and doing it again would be theatre.

Removing them is not a reduction in capability: a stub that returns `ok` is
worse than an absent job, because it makes the absence invisible.

### 3. Recurring jobs are scheduled with BullMQ's scheduler, not by re-adding

`queue.scheduleRecurring({ id, everyMs, queueName, jobName })` calls
`upsertJobScheduler`. The schedule lives in Redis, keyed by id, so:

- registering the same id twice UPDATES the schedule instead of adding a
  second one — two instances of the worker, or a restart, are safe;
- the cadence does not depend on a job surviving to re-arm itself, which is
  the mechanism that made the old "hourly" job run once.

The schedules are deliberately left registered when the worker stops: another
instance may still be running, and disarming its cadence on the way out would
be a worse failure than a stale schedule.

### 4. The schedules are armed before the first drain

A service that delivers telemetry but has not armed its housekeeping has
silently lost the housekeeping, and the only sign of that is a table that
grows forever.

### 5. The shutdown drain is a real drain

`stop()` awaits the in-flight pass and THEN runs one more pass. Awaiting the
previous pass alone would deliver nothing: the row that needs delivering is
the one claimed after the last interval tick.

### 6. One service, not two

`packages/agent-security/src/telemetry-service.ts` is removed. Its behaviour
lives in `worker-service.ts`. Two services that both claim to be the worker
is the duplicate source of truth this repository forbids.

## Consequences

- The stub worker module is gone. There is no code path that returns
  "delivered" without delivering.
- The worker actually runs in the deployed stack: `npm run worker:service`
  locally, and the compose `worker` service in production.
- Housekeeping is real and scheduled: the outbox is swept, dead letters are
  surfaced, and the sponsor ledger is reconciled against the chain.
- The worker still refuses to start without a database and a queue, and it
  still touches no money: it reads telemetry, reads the chain and writes
  findings, reports and receipts (ADR-0025).
- The evaluation, telemetry and maintenance queues of the old stub are gone.
  The queue names `evaluation`, `grading`, `indexer`, `settlement`,
  `notification` and `reconciliation` remain declared in `QUEUE_NAMES` for
  callers that enqueue into them; nothing consumes them yet, and that is
  visible rather than pretended.
