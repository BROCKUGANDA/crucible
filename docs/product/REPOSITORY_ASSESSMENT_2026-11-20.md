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

**Duplicated and unused — corrected.** This section first claimed that
`packages/datasets` and `apps/api/src/evaluation-spec.ts` were two models of the same
thing. **They are not**, and the claim was wrong in a way worth correcting rather than
quietly dropping:

- `packages/datasets` is a **training-data** package: dataset manifests, shards,
  connectors, and a split engine over dataset rows, bucketed per 1000.
- `packages/eval`'s `splits.ts` is a **probe-bank** split engine, bucketed per 100,
  and it IS used (`promote.ts`, `train.ts`).

The duplication that was real, and has been collapsed, was inside `apps/api`
itself, where the evaluation specification and the scoring engine each carried their
own copy of the dimension names, the default weights and the replay count
(`ScoringDimension.name` as its own union, `VALID_DIMENSIONS` as its own set, and
`independentReplays: 3` written out twice). That is now one model:
`scoring.ts` owns the dimensions and their weights, `replay-policy.ts` owns the
three-replay rule, and `evaluation-spec.ts` is built from both
(`apps/api/test/spec-model-collapse.test.ts` fails if a second copy reappears).

Separately, and still open: **no file imports `@crucible/datasets`.** It is built by
`build:libs` and nothing uses it. It is a second split engine with different
semantics from the one that is used. Deleting a package is not this session's call,
so it is recorded as an open item with the two options, not silently merged.

## C. Evaluation assessment — what is genuinely operational

| Piece | State | Note |
|---|---|---|
| Trial specification (versioned, immutable) | **Partial** | `apps/api/src/trial-lifecycle.ts` versions a trial's spec; the *canonical* evaluation spec (suite + agent + environment + judge + scoring) is now `apps/api/src/evaluation-spec.ts` (untracked, another session) |
| Benchmark suite registry | **Partial, unmerged** | `apps/api/src/suites.ts` — versioning and adversarial catalogues exist in another session's working tree |
| Execution | **Working** | `packages/forge-runner`, pinned images, resource limits |
| Telemetry capture | **Working** | `packages/forge-watch` writes events + outbox atomically |
| **Telemetry delivery** | **Working as of `40d3558`** | before that: nothing delivered anything |
| **Findings persistence** | **Working as of `40d3558`** | before that: the monitor detected problems and threw them away |
| Independent replay (3×) | **Operational at the decision** | `POST /v1/studio/reproducibility` runs the pinned task three times through the real verifier and compares the EVIDENCE; agreement is `REPRODUCIBLE`, disagreement is `NOT_REPRODUCIBLE`, and "no evidence in one of the three" is `INCONCLUSIVE` |
| Multi-dimensional scoring | **Partial** | `apps/api/src/scoring.ts` (merged) — five dimensions with one canonical weight table; no judge calibration |
| Confidence intervals / statistics | **Partial** | same module; no minimum-sample policy |
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

Three commits, in order:

**`40d3558` — durable telemetry delivery.** The pipeline, the service, the attempt
ceiling, the durable dead letter, structured findings, the acknowledgement, and
the BullMQ job-id bug that would have made every delivery fail. Full detail and
the six mutation proofs are in `HARDENING.md` under "Telemetry delivery slice —
2026-11-20".

**`e341a5e` — one worker, and a sponsor's money as a chain fact.** The stub worker
(`apps/api/src/worker.ts`) returned six success-shaped answers without doing the
work, its repeat pattern ran "hourly" jobs exactly once, and the compose worker
service actually started a second API server. There is now one worker, with real
schedules. And a sponsor's funding is verified against the arena's own views over
public RPC: the sponsor's escrow is `reward + fee` read from the chain, never
`deposited`; the fee is read, never recomputed; an unreadable chain is
`unverifiable`, never `mismatch`. ADRs 0029, 0030 and 0031.

**`0c85816` — the three surfaces.** The Evaluation Studio (three replays, a verdict
computed by the server, and an explicit refusal to treat agreement about ABSENCE as
reproducibility), the sponsor console (the ledger and the escrow side by side), and
the API reference — which the API writes about itself, with a drift gate that found
thirty-one undocumented error codes on the day it was written.

**What it does not claim:** no operator UI for the dead-letter queue; no metrics
endpoint (the backlog is logged); no scheduled retention sweep; the end-to-end
case needs `REDIS_URL` and is SKIPPED in CI, which provides neither Redis nor
PostgreSQL — it was run manually here, against a local `redis-server`. The sponsor
programme scaffolding is still held in the API's memory, so the console's programme
list does not survive a restart; the funding truth (the part that must not be a
claim) is durable and chain-verified, and was built to survive that rewrite.

## I. Verification session (later, 2026-11-20) — browser proof and a money bug

The three surfaces shipped in section H were verified the way this repository says
they must be verified: in a browser at the real URL, against a real chain.

**The stack.** Anvil on `127.0.0.1:8555`; the arena deployed with
`forge script script/Demo.s.sol:Demo --rpc-url http://127.0.0.1:8555 --broadcast`
(CrucibleTrials `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0`, AlloyRegistry
`0xe7f1725E7734CE288f8367e1Bb143E90bb3F0512`, Arena
`0x0B306BF915C4d645ff596e518fAf3F9669b97016`); the API on `:8787` against those
addresses; the site on `:3210` against the API. The `forge script` run also
compiles `script/`, which `forge test` does not — the deploy path is therefore
proved to build, not only to test.

**What the browser showed.** The reference page renders the live contract — the
pagination rules, the rate limit, the two auth schemes, the webhook signature and
every error code, read from the running API. The Studio and the console render
their honest signed-out states. The Studio's full path was then driven against the
live API with a real signed session: three agreeing replays produce
`REPRODUCIBLE`, one disagreeing replay produces `NOT_REPRODUCIBLE`, and three
replays that produced no evidence at all produce `INCONCLUSIVE`.

**The funding truth, against the live chain.** Trial 1 of the deployed arena is
posted by `0x976EA74026E726554dB657fA54763abd0C3a0aa9` with reward `0.5 ETH`, fee
`0.075 ETH` and deposited `0.675 ETH` — the extra `0.1` is the agent's bond, which
is not the sponsor's money. An honest claim of `reward + fee` is `verified`; a
claim of the reward alone is a `mismatch` naming both numbers; another wallet's
address on that trial is a `mismatch`; an unreachable node is `unverifiable`.
**The fee in that arithmetic is the arena's `ARENA_FEE_BPS = 1500`, paid by the
sponsor on top of the reward.** The frozen `FEE_BPS = 500` is the *legacy* escrow's
own fee on a different contract, and the two must not be read as one number.

**A money bug, found by looking rather than by reasoning.** The console's "the
ledger claims" column summed the chain's receipts with each receipt's claimed
amount dropped on the way in, so a programme with a 1.15 ETH claim reported **0
ETH** next to "the escrow holds 1.15 ETH". The summary now comes from the claims
and the receipts separately, and an unchecked claim is its own column rather than a
contradiction. Four mutations are proven red. **The fourth was green on its first
attempt** because the anchor matched an identical line in a different function —
a mutation that cannot fail proves nothing, and one that fails for the wrong
reason proves less than one that fails for the right one. That correction is in
`HARDENING.md` with the rest.

**Also found by the browser, and fixed.** The "couldn't reach the chain" panel was
shown when it was the *API* that was unreachable, on three pages that read the
API; it says "the host" there now and keeps "the chain" for chain pages.

**Measured after this session:** `npm run typecheck` clean; `npm test` green —
**4,171** TypeScript tests passed; the edge suite **25/25**; `forge script` compiles
and deploys. **Not claimed:** no operator UI for the dead-letter queue; the
sponsor programme scaffolding is still in the API's memory; the Studio's three
replays are three runs of one verifier in one process, not three independent
workers; the browser was Edge headless against a local chain, not a public
deployment.

## J. The durable ledger (2026-11-20, last) — and what a real database found

This slice stood up **PostgreSQL 17 on the build box** and asked the shipped
code to write to it. Four findings, none of which a unit test or a fake pool
could have produced.

**1. A sponsor's funding claim could not be recorded in any real deployment.**
`sponsor_funding_claims.org_id REFERENCES organisations(id)`, and nothing in
the repository ever inserts an organisation — the tenancy model is process
memory by design (`packages/agent-security/src/org-store.ts`). Every claim
died at the foreign key:

```
insert or update on table "sponsor_funding_claims" violates foreign key constraint "sponsor_funding_claims_org_id_fkey"
```

The chain-fact path could not record a claim. The constraint is dropped in
migration `0012`; the tenant boundary is enforced in the route against the
membership model that is the real source of truth today, and the row-level
policies are kept for the day that model becomes durable.

**2. The sponsor's ledger was process memory.** Sponsors, programmes, the
eight budget counters and the budget's own ledger were `Map`s: a restart lost
every programme, and the durable claims hung off programmes that no longer
existed. They now live in PostgreSQL behind a `SponsorStore` interface; the
domain rules stay where they were and the tests still run without a
database. Proven by writing a sponsor, a programme, a movement and its ledger
entries through the API, killing the process, starting a new one, and reading
all of it back.

**3. The programme and budget-entry routes were failing outright.**
`JSON.stringify` throws on a `bigint`, and both routes returned domain
objects holding wei as `bigint`. The console's programme list was never
rendered. Every wei now leaves as a decimal string, through explicit
serializers.

**4. A ledger with no order, and an invariant its own code broke.**
`budget_entries` had no insertion order — two movements in the same
millisecond sorted by a random id, different every run — and
`recordWithdrawal` decremented `paid` while `validateBudgetConsistency`
requires `paid >= withdrawn`. Both are fixed: the ledger carries a
`BIGSERIAL` `seq` and is read by it, and `paid` and `withdrawn` are both
cumulative.

**Measured after this slice:** `npm run typecheck` clean; `npm test` green —
**4,171** TypeScript tests passed (the 12 new durable-ledger tests need a
database and are SKIPPED without one, as the Redis-backed cases already are);
with a real PostgreSQL the API workspace is **1,121 passed, 0 failed**; edge
**25/25**.

**What is still open, named rather than left to rot:** the organisation and
membership model is still in process memory (audit AUTHZ-D1) — a
multi-process deployment would hold two views of who may see what, and it is
the next ADR. There is no operator UI for the dead-letter queue; the Studio's
three replays are still three runs of one verifier in one process; and the
budget's ledger records what the platform did, not what the chain confirmed —
the chain truth is the receipts (ADR-0031).
