# Ledger — 2026-11-20 — flagship evaluation network: baseline + first slice

## Session intent

Directive: turn Crucible into a flagship, commercially usable evaluation network
(public network, enterprise workspace, sponsor console, developer platform,
on-chain settlement, control plane). Main directive §20 requires a verified
assessment (A-H) and then a real implementation slice, not a strategy document.

## What the tree actually held (verified, not read off the audit)

The audit (`CRUCIBLE_AUDIT.md`, 2026-11-09 addendum) is a **stale snapshot**.
Re-inspection at HEAD `7b3477b` (branch `develop`) shows most of its register
was closed afterwards. Verified against code, not prose:

| Audit finding | Reality at HEAD | Evidence |
|---|---|---|
| RUN-H1 "outbox insert-only, no relay" | **partly closed** — `packages/forge-watch/src/outbox.ts` implements a real claims/dispatch/backoff relay, but it is wired **only** in `scripts/live-agent.mjs` (a demo script). `registerForgeWatchWorkers` is called by **no** process. | `grep registerForgeWatchWorkers` → only its definition |
| RUN-M3 "DLQ is a queue-name constant" | **partly closed** — `packages/agent-security/src/queue.ts` has `routeToDeadLetter` + `buildDeadLetterRecord` + tests. But the DLQ is a **Redis** queue: not durable across a flush, no manual replay, no quarantine, no retryable record. | `queue.ts:201`, `test/queue.test.ts:64` |
| AUTHZ-F4 metering tenant safety | closed — `metering-routes.ts` resolves membership server-side | `principalOrDenied()` |
| WEB-M3 global-error wallet graph | closed — `global-error.tsx` imports only `Crack` | — |
| RUN-M6 fork gate advisory | closed — CI now says "SKIPPED, not passed" and writes a step summary | `.github/workflows/ci.yml` |
| MONEY-M1 float ETH budget | closed — the forge brief carries `maxBudgetWei` as a string | `forge/brief/page.tsx` |

Newly observed, not in the audit:

- **MONEY-H2 / APP-F1 — telemetry findings are computed and thrown away.**
  `l0Processor` detects sequence gaps, denied egress, denied tool calls and test
  modifications, returns them as one comma-joined `reason` string, and the
  `forge_watch_findings` table plus `PgEventStore.insertFinding` exist but the
  worker path never calls them. A detected telemetry-integrity problem is
  discarded.
- **APP-F2 — a dead letter is a Redis object, not a durable record.** No
  manual replay, no poison quarantine, no attempt ceiling in the relay: a
  poison message retries forever.
- **APP-F3 — no production process runs the relay or the workers.** Nothing
  in `apps/api`, `apps/keeper`, `apps/funder` or `compose.yaml` claims the
  outbox. `WORKER_MODE=1` appears in `compose.yaml` and is read by **no** code.

## Shared-tree hazard

A **concurrent session** is writing `apps/api/src` during this session
(`sponsor-routes.ts`, `commercial-routes.ts`, `worker.ts` appeared under me
between 00:44 and 01:08). Its `worker.ts` uses `QueueScheduler` (removed in
bullmq v5) and `repeat` (not in `JobsOptions`), so it does not typecheck.
`mcp__deepai-code__list_agents` reports no live peer, and its writes stopped.
**Decision: this session works in `packages/` and `migrations/`, which the other
session is not touching, and does not edit `apps/api/src`.**

Its `apps/api/src/worker.ts` was left alone deliberately: it is a stub whose
workers return `{status:"scheduled"}` without executing anything, and AGENTS.md
forbids a second source of truth beside one that exists. The first slice below
ships the real telemetry service instead, in `packages/agent-security`.

## First implementation slice (this session)

**Durable telemetry delivery: outbox → queue → consumer → durable finding,
with a durable, replayable dead-letter store.**

Files:
- `migrations/0010_forge_watch_dead_letters.sql` — durable DLQ table.
- `packages/forge-watch/src/outbox.ts` — attempt ceiling, poison quarantine,
  acknowledgement stamp on `forge_watch_events.dispatched_at`, retention purge.
- `packages/agent-security/src/forge-watch-workers.ts` — structured findings
  on the processor result; hooks for a findings sink and a durable dead-letter sink.
- `packages/agent-security/src/forge-watch-telemetry.ts` — the pipeline.
- `packages/agent-security/src/telemetry-service.ts` — the runnable service.
- root `package.json` — build order (forge-watch before agent-security) and a
  `telemetry:service` script.

Verification run before this slice: `npm run typecheck --workspace @crucible/api`
clean; `npm test --workspace @crucible/api` → **1047 passed, 6 skipped, 0 failed**.
(`monitoring.test.ts` failed twice under the full-suite load and passed in
isolation; root cause is a per-case timeout that charged the ~12s cold import of
`app.ts` to the assertion, so an aborted request kept running and recorded its
metric into the *next* case's counter — the file's own comment records this
artifact from an earlier pass. Fixed by hoisting the import into a `beforeAll`
with its own budget, not by weakening the assertions.)

## Next steps

1. Get this slice green: forge-watch + agent-security suites, then the full
   `npm run verify:all`.
2. Reconcile with the concurrent session's `apps/api/src/worker.ts`: one worker
   entrypoint, not two.
3. `docs/since-submission.md` dated row; audit register rows for RUN-H1/RUN-M3.

---

## Session end (2026-11-20, ~02:40)

### Shipped and committed

- `40d3558` — feat(telemetry): Forge Watch telemetry is actually delivered now.
- `e69f363` — docs(product): the repository assessment the flagship directive asks for
  (`docs/product/REPOSITORY_ASSESSMENT_2026-11-20.md`, sections A-H).

### Files changed (all committed)

- `packages/forge-watch/src/{outbox,dead-letter,dispatch,index}.ts`
- `packages/forge-watch/test/{outbox,dead-letter,dispatch}.test.ts`
- `packages/agent-security/src/{forge-watch-workers,forge-watch-telemetry,telemetry-service,queue,index}.ts`
- `packages/agent-security/test/{forge-watch-workers,forge-watch-telemetry,forge-watch-telemetry.e2e}.test.ts`
- `packages/agent-security/package.json`, `package.json` (build order + `telemetry:service`), `package-lock.json`
- `migrations/0010_forge_watch_dead_letters.sql`
- `apps/api/test/monitoring.test.ts`, `CRUCIBLE_AUDIT.md`, `HARDENING.md`, `docs/since-submission.md`

### Measurements (this session, this tree)

- `npm run typecheck` → 0 errors (every workspace).
- `npm test` → green; **4108 TypeScript tests** passed.
- `npm run test:edge` → 25/25.
- `crucible-contracts`: `forge test` → **360 passed, 0 failed** (4 fork skips); `forge build --sizes` compiles `script/`.
- `apps/api` → 1047 passed, 6 skipped.
- End-to-end (real local `redis-server` on 6399, real BullMQ worker): 2 passed; repeatable across two consecutive runs.
- Six mutations applied and each turned the tree red before revert (finding sink in the
  registration, attempt ceiling, dead-letter upsert, purge status restriction, quarantine
  dead-letter write, acknowledgement in the registration).

### Recovered from another session's accident

`params/crucible.params.json` and `params/generated/*` had been deleted from the working
tree (uncommitted) by a concurrent session. That file is the frozen 500 bps legacy fee
and CI's drift-gate input. Restored from HEAD; `node scripts/params-codegen.mjs --check`
is green again. `live.html`, `mutate.sh` and `worklog.md` remain deleted by that
session — deliberately left alone.

### Open, and owned by nobody else yet

- `apps/api/src/worker.ts` (another session, untracked) does not typecheck: `QueueScheduler`
  was removed in bullmq v5 and `repeat` is not a `JobsOptions` key. Its workers return
  `{status:"scheduled"}` without executing anything. **It must not become a second worker
  entrypoint alongside `npm run telemetry:service`** — one process should claim every queue.
- No operator UI for the dead-letter queue; no metrics endpoint; no scheduled retention
  sweep. CI provides neither Redis nor PostgreSQL, so the e2e case is SKIPPED in CI
  (HARDENING open item 2 already carries the unmeasured wiring proposal).

### Next steps, in order

1. Reconcile the two worker entrypoints (mine in `packages/agent-security`, theirs in
   `apps/api/src/worker.ts`) — one process, one queue-claiming service.
2. Merge the untracked evaluation-integrity work (suite registry, scoring, replay
   manifest) and the sponsor/commercial work, and collapse the duplicate specification
   model (`packages/datasets` vs `apps/api/src/evaluation-spec.ts`) into one.
3. Make funding a chain fact (verified escrow receipt) before the sponsor console exists —
   otherwise "fully distributed" can be reported for a program that paid nothing.
4. Only then: the VRF consumer, the treasury ADR, and the pilot.

### Question left for the operator

Whether the target EVM mainnet is still undecided. The tree has never approved one
(Anvil 31337 only; Base Sepolia appears as a test path), and choosing it needs an ADR
before any VRF subscription or multisig is funded.
