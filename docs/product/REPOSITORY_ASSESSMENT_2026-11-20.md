# Repository assessment — Crucible as a flagship evaluation network

**Date:** 2026-11-20 · **Commit assessed:** `7b3477b` (branch `develop`), plus the
telemetry slice landed in `40d3558`.

This is the assessment the master directive asks for before further implementation
(§20, A–H). It was written by inspecting the code, not by reading the audit's
prose back: `CRUCIBLE_AUDIT.md` is a **2026-11-09 snapshot** and most of its
register has since been closed. Where the two disagree, this document names the
code that settles it.

The assessment is deliberately short on adjectives and long on file references, because
the useful claim is "here is the thing that is true", not "this is good".

---

## A. Current product assessment — what Crucible actually does today

**It is a real, working agent proving ground on a local chain.** Not a prototype:
a judge can pull the repository, run `npm run verify:all`, and get a green result.

| Capability | Real state | Evidence |
|---|---|---|
| Agent identity | **Seven-state model, on-chain, tested** | `crucible-contracts/contracts/CrucibleTrials.sol`, 360 Foundry tests |
| Escrow + settlement | **Non-custodial, pull-only, conservation-invariant** | ADR-0002/0003, `test/Invariants.t.sol:170` |
| Authentication | **SIWE with replay protection, one-time nonces** | `apps/api/src/auth.ts` |
| Trial lifecycle | **DRAFT→…→SETTLED state machine with immutable revisions** | `apps/api/src/trial-lifecycle.ts` |
| Public discovery | **Live read model over the chain** | `apps/api/src/app.ts`, `/trials`, `/agents`, `/hall` |
| Argument/break mechanics | **EIP-712 signed, commit/reveal, 2-of-3 Argus committee** | `ArgusCourt.sol`, `apps/juror` |
| Execution | **Sandboxed container runs with resource limits** | `packages/forge-runner` |
| Telemetry | **Durable events; delivery only as of `40d3558`** | `packages/forge-watch`, `packages/agent-security` |
| Enterprise workspace | **API surface exists; no console UI** | `apps/api/src/orgs.ts`, `apps/web` has no `/workspace` route |
| Sponsor console | **In-flight in another session, not merged** | `apps/api/src/sponsor-onboarding.ts` (untracked) |
| Developer platform | **Partial**: `/mcp` server, `@crucible/smith-sdk`, no portal docs | `apps/api/src/mcp.ts` |
| Mainnet | **Gated, not launched** — preflight refuses on unsigned sign-offs | `scripts/mainnet-preflight.mjs` |

**The product shape today is "arena + leaderboard + verification"**, not "evaluation
network". A sponsor cannot commission a program; an enterprise cannot configure an
evaluation without reading backend configuration; a developer's path in is a wallet
connect, not an API key.

## B. Architecture assessment

```
apps/         api (Hono, 63 test files) · web (Next.js, 60 pages) · keeper · funder · juror · fork-host
packages/     forge-watch (telemetry model + outbox)   agent-security (authz, tenancy, queue, workers)
              forge-runner (sandbox)   argus (verification)  smith-sdk (client)  engrams   indexer
              frame  stamp-core  stamp-solana  registry  grader  warden  crypto  cidstore  datasets
crucible-contracts/  18 Solidity contracts + a Solana program (scaffolded)
migrations/   9 SQL files (PostgreSQL + RLS) — the durable record for application data
```

**The boundaries that hold.** The chain is the authority for money and identity;
PostgreSQL is the authority for application data (ADR-0008 keeps the indexer in
memory). The API holds no chain key (ADR-0006). Redis/BullMQ is a delivery layer,
never an authority (ADR-0023). The contracts have no external dependency — only
`forge-std`.

**The boundaries that do not.** `apps/api` is a 111 KB file that mounts 40+ route
groups; it is the point where every new feature lands. `packages/forge-watch` had no
consumer until this session. The API, keeper and funder each hold their own
BullMQ/PG wiring, so "the worker" is currently three products rather than one.

**Duplicated and unused.** `packages/eval` and `packages/grader` overlap; the
`evaluation-spec.ts` / `suites.ts` / `scoring.ts` modules added in the last session
are a **second** specification model next to `packages/datasets`. `scripts/live-agent.mjs`
contains the only outbox-relay wiring in the tree — now superseded by
`packages/agent-security/src/telemetry-service.ts`.

## C. Evaluation assessment — what is genuinely operational

| Piece | State | Note |
|---|---|---|
| Trial specification (versioned, immutable) | **Partial** | `apps/api/src/trial-lifecycle.ts` versions a trial's spec; the *canonical* evaluation spec (suite + agent + environment + judge + scoring) is now `apps/api/src/evaluation-spec.ts` (untracked, another session) |
| Benchmark suite registry | **Partial, unmerged** | `apps/api/src/suites.ts` — versioning and adversarial catalogues exist in another session's working tree |
| Execution | **Working** | `packages/forge-runner`, pinned images, resource limits |
| Telemetry capture | **Working** | `packages/forge-watch` writes events + outbox atomically |
| **Telemetry delivery** | **Working as of `40d3558`** | before that: nothing delivered anything |
| **Findings persistence** | **Working as of `40d3558`** | before that: the monitor detected problems and threw them away |
| Independent replay (3×) | **Scaffold** | `apps/api/src/replay-manifest.ts` (another session, untracked) — the three-agreement rule the decision ledger names as absent |
| Multi-dimensional scoring | **Partial, unmerged** | `apps/api/src/scoring.ts` (another session) — five dimensions, no judge calibration |
| Confidence intervals / statistics | **Partial, unmerged** | same module; no minimum-sample policy |
| Judge calibration & drift | **Missing** | Argus is deterministic (ADR-0005), which is a strength for reproducibility and a limit for semantic judging |
| Adversarial catalogue | **Partial, unmerged** | `suites.ts` defines the catalogue; nothing executes it |
| Dispute evidence | **Partial** | contract-side commit/reveal works; the *evidence bundle* a dispute needs is not assembled |
| Reproducibility manifest | **Partial, unmerged** | `replay-manifest.ts` captures the fields; nothing produces one from a real run |

**The honest summary:** the *mechanics* of evaluation (specify, execute, observe,
sign, judge, settle) are largely real. The *methodology* — pinned suite versions,
three independent replays, confidence, calibration, adversarial coverage — is
scaffolded but not operational. Crucible can currently prove what happened once.
It cannot yet prove that the result would repeat.

## D. Security assessment

**Verified safe at HEAD (re-inspected, not assumed):** SIWE nonces consumed
atomically; tenant membership resolved server-side on metering
(`metering-routes.ts:principalOrDenied`); the global error page imports no wallet
graph; `CSRF` origin check is mounted; the keeper/funder hold no API chain keys;
no chain key exists anywhere under `apps/api/src`.

**Open, from the register, re-confirmed against code:**

| ID | Severity | Finding | Status |
|---|---|---|---|
| ~~RUN-H1~~ | HIGH | Forge Watch outbox had no production relay and no consumer | **Fixed `40d3558`** (this session) |
| ~~RUN-M3~~ | MEDIUM | Forge Watch DLQ was a queue-name constant | **Fixed `40d3558`** — now a durable, replayable PostgreSQL record |
| RUN-M6 | MEDIUM | The fork-test gate is advisory: CI prints "SKIPPED, not passed" and exits 0 when `MAINNET_RPC_URL` is absent | Open — correct as a *message*, still a green tick on a check that did not run |
| AUTHZ-F11 | MEDIUM | STAMP admin routes are session-only in sandbox/manual-review modes (production fails closed) | Open — labelled sandbox |
| WEB-M2 | MEDIUM | `/staking` shows API-chain balances while signing on the connected chain | Open — `WrongNetworkNotice` added, browser verification still pending |
| MONEY-M2 | MEDIUM | `forge/brief` budget reading: the float path was closed, but integer parsing on that route is unverified end-to-end | Open |
| RUN-L\* | LOW | No graceful shutdown in the API; the API binds all interfaces (demo intent) | Open |

**Newly found by this session:**

1. **The delivery key was undeliverable (HIGH, fixed).** BullMQ throws
   `Custom Id cannot contain :` for a custom job id whose colon-separated parts
   are not exactly three. The key `fw:<event>` split into two, so **every
   telemetry delivery would have failed at `queue.add`**. It was invisible
   because nothing had ever delivered anything.
2. **Findings were detected and discarded (HIGH, fixed).** The L0 monitor found
   lost events, denied egress, denied tool calls and test modifications, then
   returned them as a log string. `forge_watch_findings` was structurally
   always empty.
3. **`params/` was deleted from the working tree (HIGH, restored).** Another
   session removed `params/crucible.params.json` and `params/generated/*`
   uncommitted. That file is the source of the frozen 500 bps legacy fee and
   the input to CI's drift gate (`scripts/params-codegen.mjs --check`); with it
   gone, CI would have failed and the fee constant would have vanished from the
   tree. Restored from HEAD; the drift gate is green again.
4. **`apps/api/src/worker.ts` (another session, untracked) does not typecheck.**
   It uses `QueueScheduler`, removed in bullmq v5, and `repeat`, which is not a
   `JobsOptions` key. Its workers also return `{status:"scheduled"}` without
   executing anything — a stub on a runtime path, which this repository's rules
   forbid. It is left alone pending that session's own work; it must not become
   a second worker entrypoint alongside `npm run telemetry:service`.

**Not claimed:** no professional audit, no penetration test, no SOC 2 or ISO
evidence. Uppercase words like *audited*, *secure* and *production-ready* are not
used in this repository without an artifact that says so.

## E. Mainnet assessment — the exact blockers

**Chain reality.** The contracts run on **local Anvil (chain 31337)**. The
decision ledger and the deploy architecture have never approved a mainnet chain:
Base Sepolia appears as a *test* path only, and nothing in the tree authorises
Base Mainnet, Ethereum mainnet, or any other network. **The target EVM mainnet is
an open decision that requires a new ADR** — it is not derivable from the code.

**Randomness is a hard blocker.** The Arena's `randomnessMode` is immutable per
deployment: Mode 0 is a deterministic seed (`keccak256(prevrandao, block.number,
id, round)`) and Mode 1 reverts `RandomnessNotConfigured` (`Arena.sol:694`).
D-17 records Mode 0 as the demo configuration and D-12 requires VRF for production.
**No VRF consumer is wired on either chain.** Deciding the EVM provider (and
verifying its current version and network parameters from official documentation
at deployment time) and the Solana provider (the approved one from the protocol
decision) are both open.

**Treasury and keys.** No multisig is configured, no key inventory exists for
production, and the deployment authority, keeper key and funder key are not
separated by anything but convention in `.env`. ADS-0020 requires an explicit
treasury ADR acceptance that the preflight now checks.

**Other blockers, in the order they bite:**

1. An unrelated violation of the preflight's own sign-off rules: the sign-off
   templates are unsigned **by design** — audit, legal entity, timelock multisig,
   named on-call and genesis cohort are human signatures no agent can supply.
2. Withdrawal rehearsal against a mainnet fork (there is a fork suite; it is
   opt-in and has never run against a production endpoint).
3. Financial reconciliation between chain state, indexer records and the internal
   ledger — no service exists that compares all three.
4. Production RPC with a fallback, plus confirmation and finality policy.
5. An independent contract and application security review.

**External dependencies no agent can supply:** a formed legal entity with counsel,
a funded multisig deployer, real VRF subscriptions, an RPC provider, named
on-call humans, an independent auditor, and a sponsor willing to commit ETH.

## F. Commercial readiness

**No. A sponsor cannot currently commission, fund, administer or receive a
reliable evaluation program.** Concretely:

| Capability | State |
|---|---|
| Sponsor onboarding | **In-flight, unmerged** (`apps/api/src/sponsor-onboarding.ts`) |
| Program creation with budget cap | **In flight** — budget fields exist; the accounting is not reconciled against the chain |
| Funding verification | **Missing** — nothing proves a sponsor deposited ETH |
| Three-truth separation | **Partial** — budget states are modelled; a payment is still an API claim, not a chain fact |
| Billing and metering | **Partial** — `metering.ts` counts usage; tier entitlements and overages are not enforced |
| Sponsor reporting | **Missing** |
| Pilot administration | **Missing** |

The deepest problem is not missing UI. It is that **a sponsor-provided payment and
an evaluation result are both API claims today**, and the repository's own law
separates them. The funding side must become a chain fact (an escrow deposit with
a verifiable receipt) before the console can tell the truth — otherwise a sponsor
can read "fully distributed" for a program that paid nothing, which is the exact
gap the ledger already recorded for `completeClaim`.

## G. Implementation roadmap

Ordered by dependency and by what each unblocks.

**P0 — make the claims true (in progress)**

| # | Item | Depends on | Acceptance |
|---|---|---|---|
| P0.1 | Durable telemetry delivery, findings, quorum dead-letter | — | **Shipped `40d3558`** |
| P0.2 | Merge the evaluation-integrity work (suite registry, scoring, replay manifest) with the sponsor/commercial work, and reconcile the two specification models (`packages/datasets` vs `apps/api/src/evaluation-spec.ts`) | one session's tree | one canonical spec, one registry, no duplicate model |
| P0.3 | Reconciled worker entrypoint: one BullMQ worker service, not `apps/api/src/worker.ts` plus `telemetry-service.ts` | P0.1 | one process claims every queue; the stub worker is gone |
| P0.4 | Funded-trial funding becomes a chain fact: escrow receipt, verified deposit, three-truth budget reconciliation | P0.2 | a sponsor's "committed" equals a verifiable on-chain deposit; reconciliation detects drift |

**P1 — the sponsor pilot (P0.4 is the precondition)**

1. Sponsor console: program brief, budget lifecycle, participant eligibility, reporting — over the reconciled budget, not over an API claim.
2. Evaluation Studio: a guided path from suite → agent → environment → repetitions → scoring, with a dry run.
3. Methodological publication: suite versions, rubric versions, judge configuration, and the limits of each published score.
4. Three independent replays, wired to the replay manifest, with the agreement rule the decision ledger names.
5. Dispute evidence bundle: what a reviewer sees, assembled and immutable.

**P2 — the product surface**

Comparison studio (with an explicit "not comparable" verdict), agent directory with
verified history, evidence inspector, trial timeline, reviewer queue with conflict
declaration and abstention, developer portal (auth guide, webhooks, rate limits,
error catalogue, pagination, versioning).

**P3 — mainnet**

Chain-environment ADRs, VRF consumer and callback tests, treasury multisig and key
inventory, withdrawal rehearsal, reconciliation service, monitoring and alerts,
release evidence archive. **P3 does not begin before P1's pilot produces evidence
and an independent review has been commissioned.**

**Complexity estimate (engineer-days, one senior engineer, excluding external
sign-offs):** P0.2–P0.4 ≈ 25–35; P1 ≈ 40–60; P2 ≈ 60–90; P3 ≈ 40–70 plus the
external dependencies above.

## H. What this session shipped

`40d3558` — **durable telemetry delivery.** The pipeline, the service, the attempt
ceiling, the durable dead letter, structured findings, the acknowledgement, and
the BullMQ job-id bug that would have made every delivery fail. Full detail and
the six mutation proofs are in `HARDENING.md` under "Telemetry delivery slice —
2026-11-20".

**What it does not claim:** no operator UI for the dead-letter queue; no metrics
endpoint (the backlog is logged); no scheduled retention sweep; the end-to-end
case needs `REDIS_URL` and is SKIPPED in CI, which provides neither Redis nor
PostgreSQL — it was run manually here, against a local `redis-server`.
