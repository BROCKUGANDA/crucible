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

## K. The tenancy model is durable (2026-11-20, last) — and what is still in memory

Section J closed the sponsor's ledger. This closes the tenancy model itself:
**who may see what**.

`packages/agent-security/src/org-store.ts` held organisations, memberships,
invitations, workspaces and resource ownership on `globalThis`, and said in
its own header that persistence was deferred. Two things were wrong with that
deferral, and neither was about performance:

- **A restart lost it.** The tables existed since migration 0002 and were
  never written to — which is exactly why the funding claims' foreign keys
  had to be dropped in section J.
- **Two workers could disagree.** The store lives on `globalThis` so a dev
  hot reload does not empty it, and under Octane every worker process has its
  own `globalThis`. An organisation created on worker A was invisible on
  worker B, and a membership check answered differently depending on which
  process answered. That check decides who may read a sponsor's funding
  ledger.

**The store is now a cache over PostgreSQL** (ADR-0033): reads from the cache
(synchronously — `isMemberOf` is on the hot path of every request), writes to
the database **first** and the cache second, and a cache that is refilled at
boot by being **replaced**. The non-durable path is refused while a durable
backing is attached, so "the write only reached the cache" is prevented
rather than documented. The membership constraint was corrected against the
domain: it forbade a member from ever coming back, because it was UNIQUE
over all memberships including revoked ones; it is now a partial unique index
over the live ones.

**Proven:** 15 tests against a real PostgreSQL, including the restart — an
organisation written through the API, the process killed, a new one started,
and it read back — plus five mutations proven red.

**What is still in memory, named rather than left to rot:**

| Model | Where | Why it matters |
|---|---|---|
| Org budgets, audit entries, conflict-of-interest declarations, webhooks, API keys | `packages/agent-security/src/org-{budget,audit,coi,webhook,api-key}.ts` | They hang off an organisation that is now durable; the precondition is met |
| Org-scoped role matrix decisions | `packages/agent-security/src/org-authz.ts` | Derived from memberships, so it follows |
| The application's own state (runs, trials, indexer) | in memory by ADR-0008 | Deliberate, and the indexer is a separate concern |

**The row-level policies are still inert**, and the ADR says so plainly:
PostgreSQL does not apply RLS to a table's owner, and the API connects as the
owner. The policies in migrations 0002–0013 mean something the day the API
connects as a separate, non-owning role **and** the principal is set per
request — a deployment change (two roles: one that owns the schema and
migrates it, one the application connects as), which is the next step of
ADR-0033 and the last piece of the tenant boundary that the database is
currently not enforcing.

## L. The published method (2026-11-20, last) — a score with its method and its limits

Sections I–K closed the money (what the chain holds), the ledger (what the
platform records) and the tenant boundary (who may see it). This section
closes the **claim**: what the platform says when it reports a score.

**The product could not answer three questions about its own scores.**

1. *What was this measured against?* The Studio computed a verdict —
   `REPRODUCIBLE`, `NOT_REPRODUCIBLE`, `INCONCLUSIVE` — and returned it in a
   response body. Nothing recorded it. It could not be published, compared
   with another verdict, or audited later.
2. *What does this score NOT establish?* Nothing said. A score published
   without its limits is a marketing claim; the limits are the difference
   between a measurement and an advertisement.
3. *May these two numbers be compared at all?* Two scores of 0.82 measured
   against different suites are two different numbers, and the product had no
   way to say so — it kept no record of how anything was measured.

**A publication is now a content-addressed method card** (ADR-0034). It
carries the suite version by that version's own digest, the rubric with each
dimension's weight and methodology, the judge, the repetitions and whether
they agreed, the score with its uncertainty — and the **limits, derived from
the measurement** rather than written by hand.

The derivation is the substance. Each limit is the consequence of something a
reader would otherwise have to know to interpret the number: the score
establishes only what the pinned measurement covered; the suite's own
published limitations apply, in its author's words; this dimension carries no
published methodology, so 20% of the score is unexplained; there is no
confidence interval; two of the three required repetitions were run; the
repetitions did not agree. A hand-written limit is a promise; a derived limit
cannot disagree with the data it describes.

**Comparability is keyed on the measurement, with the subject left out**
(`computeMeasurementKey`): the suite version, the protocol, the fixtures, the
environment, the judge, the scoring methodology, the repetition policy and
the randomness configuration — and deliberately not the trial, the agent or
the timestamps. This is the decision the whole comparison surface rests on:

- the **spec digest** cannot be the key, because it includes the agent, so
  it would refuse exactly the comparison the product exists for (two agents
  measured against the same suite);
- the **subject** cannot be the key, for the same reason;
- the **suite digest alone** is not enough, because it ignores the judge and
  the rubric: the same suite scored by two judges is two measurements.

Two cards whose keys match are comparable; two whose keys do not get an
explicit **"not comparable"** with the reason, and the comparison is
recorded. The page never subtracts two numbers that came from different
measurements.

**Durability follows the ADR-0032/0033 pattern.** The card lives in
PostgreSQL (migration 0014), append-only: the address is the digest of the
card's own contents, so publishing the same card twice is the same row and a
published method cannot be edited — any change produces a different address.
The store is chosen once at boot, never per request. Without a database the
API runs on the in-memory store and says so in the boot log and in every
publish response.

**A publication states what the platform measured; the caller may not
state it.** The route refuses a body carrying `score`, `verdict`, `status`,
`limits`, `digest`, `comparabilityKey`, `aggregateBps`, `scoreBps` or
`publishedAt`, by name and whatever the value.

**The Studio now records a measurement** — a replay manifest and one replay
record per replay, including the replays that produced no evidence — so that
the thing it measures can be published.

**Proven:** 15 domain tests, 9 route tests, 8 tests against a real
PostgreSQL, **eight mutations proven red**, and browser verification at the
real URL against the running API and a live database: `/publications` lists
the cards with their repetitions and their limits; `/publications/<id>`
shows the card, with an em dash where nothing is published and never a zero.

**Three defects were found on the way, and they are worth naming because
each would have made the feature a decoration:**

| Defect | Why it mattered here |
|---|---|
| The suite version's "digest" was a principal **object** in the in-memory route, and the PostgreSQL route never wrote the NOT NULL column at all | The comparability key would have compared an object against a string; the durable path could not insert |
| The evaluation spec hashed with a hand-rolled `JSON.stringify` | A second hashing convention beside the repository's canonical JSON hash (gate 629) |
| `runMigrations()` took no lock | Two processes migrating at once deadlocked — and the API migrates on **boot**, so a multi-worker boot could crash-loop |

**What remains, named rather than left to rot:**

- **The replay manifest store is still in process memory** (REPL-D1). A
  measurement can be lost on restart even though its published card
  survives — the card is then a record of something that cannot be
  re-derived. It is the next slice: make the manifest durable, and the
  publication follows it out of the process.
- The Studio's three replays are still three runs of one verifier in one
  process, so "independent" is a claim about the harness and not about the
  infrastructure.
- The org-scoped side models (budgets, audit, conflict-of-interest,
  webhooks, API keys) are still in memory, and the row-level policies are
  still inert.

## M. The dispute's frozen evidence (2026-11-20, last) — and what a bundle says it does not contain

Section L closed the claim (a score with its method and its limits). This
closes the **proceeding**: the evidence a dispute is decided on.

**Nothing froze the evidence.** The chain records who broke a trial, what
they staked and the proof they filed — but the evidence those facts point
to lived in three places that each moved on their own: the disclosure log
(written by whichever process pinned the files), the off-chain stores (the
pinned spec, the replay manifest, the scores — all process memory), and the
content store. A committee that read the evidence on Tuesday and again on
Thursday could read two different sets of facts, and neither read said
which one was the evidence the parties broke the trial over. An omission
was indistinguishable from a completeness.

**A dispute now reads a frozen bundle** (ADR-0035). The bundle carries
what the chain said and what the platform measured; it is content-addressed
and append-only, so sealing the same evidence twice is the same bundle and
a bundle cannot be edited. It is durable (migration 0015), the store is
chosen once at boot, and a caller may not bring its own evidence, gaps or
digest.

**The gaps are inside the bundle's own digest.** This is the part that
matters most for a proceeding: the bundle states what it does NOT contain —
the suite not disclosed, no replay manifest, no score, fewer than three
replays, replays that did not agree, a break filed without its proof. A gap
list that could be edited afterwards to look tidier would be a gap list that
lied, so it is inside the address.

**The seal is compared with the break on the chain's clock.** A bundle
sealed after the break may hold evidence the parties never saw, so the
order decides whether a committee is reading the parties' evidence at all.
The comparison is chain-seconds against chain-seconds — the host's wall
clock is a different clock — and when the chain's clock cannot be read the
answer is "unknown", never a guess.

**Proven:** 12 domain tests, 8 route tests, 5 tests against a real
PostgreSQL, **nine mutations proven red** (one of them green on the first
attempt, because the assertion matched a substring another gap also
contained), the end-to-end proof over HTTP against the live chain (trial 1's
real facts, three stated gaps, the same address on a re-seal, a
caller-supplied bundle refused), and browser verification of `/disputes/1`.

**What remains, named rather than left to rot:**

- The off-chain stores the bundle reads are still in process memory
  (REPL-D1): a measurement can be lost on restart even though its bundle
  survives.
- The content store is a host-local directory in this deployment, so the
  bytes behind a CID are available only on the host that pinned them.
- The reviewer queue — who may take which case, how a conflict is declared
  and how an abstention is recorded — is still to come, and it is the
  consumer of these bundles.

## N. The rule behind every score was never checked, and the measurement was in memory (2026-11-20, last)

Sections L and M closed the claim and the proceeding. This closes the
**rule** they both rest on.

**Independence was decorative.** The network quotes one rule above every
score: three *independent* replays of the same pinned task must produce the
same result. The reproducibility state machine counted completed replays
and compared their output hashes; it never looked at who ran them. Worse,
the Studio filled each replay's `workerIdentity` with **the caller's own
label** for the replay — so a caller could satisfy any independence check
by naming its three replays `worker-a`, `worker-b` and `worker-c`, and the
published card quoted the rule while listing those labels as though they
were workers. The Studio itself ran the three replays in one process and
called the result `REPRODUCIBLE`.

**Now.** Independence is decided on the worker, and the worker is derived:
the party the observation came from, as the platform knows it. The
caller's name is kept, shown and never consulted. `REPRODUCIBLE` requires
three agreeing replays from three *different* workers, and the manifest
says which of the two reasons it is not — they disagreed, or they agreed
and did not come from enough workers. The card carries the worker count,
the independence verdict and a derived limit, all inside its digest, so two
cards differing only in independence have different addresses. The Studio's
verdict names became `AGREED` / `NOT_AGREED`, and it reports the
independence separately — because it decides agreement and nothing else,
and because a surface that quietly could not meet the rule would make the
rule decorative.

**The measurement was in memory.** The replay manifest lived in a module
map, so a restart erased it and a card or a bundle described something
that could no longer be re-derived. It is durable now
(`replay_measurements`, migration 0016), the store is chosen once at boot,
the replay API is asynchronous because a write that cannot be awaited cannot
be durable, and a replay record's identity can never be rewritten — only
its status and output may move.

**A collision found on the way, named rather than papered over.** Migration
0008 already defines `replay_manifests` and `replay_records` in a
different, spec-bound shape — every row must name an
`evaluation_spec_id`, carry a `manifest_digest`, and `replay_status` is
CHECKed against a set that excludes `RUNNING` — and **nothing in the
codebase writes them**. The durable store therefore uses its own tables
rather than filling the 0008 ones with invented values to satisfy a NOT
NULL. The divergence is audit row REPL-D2.

**Proven.** 21 manifest tests, 19 publication tests, 12 studio-route tests,
the decision on its own, 8 tests against a real PostgreSQL, and **nine
mutations proven red** (one green on the first attempt, because the card's
limits masked the mutation; the mutation now removes both and the two
cards' addresses collide, which is what it was about). Repo-wide: 4,233
tests pass, and 1,197 in `apps/api` against a real PostgreSQL.

**What remains, named rather than left to rot:**

- The multi-worker fleet that would make independent replays possible does
  not exist (ADR-0030). Until it does, no surface can claim independent
  reproduction — and none of them says it does.
- The replay's result is still the caller's reported evidence, verified by
  the platform's verifier; the fingerprint is of the evidence, not of an
  independently executed run.
- The 0008 schema and the live store are two models of the same word; the
  reconciliation is named (REPL-D2) and unstarted.

## O. The audit log was not tamper-evident, and the hash was eight characters (2026-11-20, last)

Sections L, M and N closed the claim, the proceeding and the rule. This
closes the **record** they all rest on.

**The organisation audit log claimed to be hash-chained and tamper-evident,
and it was neither.** It asked for `sha256` through `require()` — which
does not exist in an ES module — so the error was swallowed and the chain
was linked with a 31-multiplier rolling hash, **eight hex characters
long**. A chain that is tamper-evident only because nobody read the code
is not tamper-evident.

**And the chain broke on its own redaction.** The write-time hash covered
the RAW metadata while the entry stored the REDACTED metadata. The
redaction list covers any key containing "key", so an ordinary
`api_key:create` entry produced a hash that no longer matched what was
stored, and `verifyChain` reported the chain as **tampered after an
entirely innocent write**. The raw metadata inside the hash was also a
digest of a secret, which is an oracle for that secret. Both were
reproduced against the built package before the fix.

**Now (ADR-0037).** The entry hash is `hashCanonical` — the repository's
one hashing door — over exactly what is stored: a real sha256 over
canonical JSON (so it depends on the content, not on the key order), over
the REDACTED metadata (so the redaction cannot break the chain and no
secret reaches a digest). The chain is durable (`org_audit_entries`,
migration 0017), ordered by a sequence rather than by the clock, and it
**continues across a restart**: the head is the last row in the table, so
a chain that restarted at "genesis" cannot orphan the entries before it.
The append is serialised with an advisory lock and checks the link inside
the transaction, so two writers cannot both link to the same head and
fork the chain — and a forked chain verifies as broken, which is exactly
what a tamper must look like.

**Proven.** The audit tests, eight tests against a real PostgreSQL (the
chain continues across a restart; two writers cannot fork it; a row
changed directly in the database is detected), and **six mutations proven
red** — two of which were green on the first attempt and had to be made
honest before they proved anything.

**What remains, named rather than left to rot:**

- Budgets, conflict-of-interest declarations, webhooks and API keys are
  still in process memory. The audit trail is durable; the things it
  audits are not.
- The row-level-security policy on the audit table follows the
  organisation tables' pattern, and — like theirs — it only bites for a
  connection that does not own the table. The role split is still to come.

## P. The conflict register is a record now (2026-11-20, last)

Sections L–O closed the claim, the proceeding, the rule, the record and
the hash. This closes the **register that decides who may judge whom**.

The conflict-of-interest register records the affiliations between
principals and organisations, model providers, cloud accounts and other
economic interests. It is consulted before an Argus seat is assigned and
before a reviewer grades a submission from an affiliated principal, and a
match produces a reviewable risk signal — not a determination of
collusion.

It was in process memory, and so was the audit record of each declaration
(§O). A conflict declared on Monday and forgotten by Tuesday — because the
process restarted — is a conflict that stopped being checked on Tuesday,
and the two failures compounded.

**Now (ADR-0038).** `org_coi_entries` (migration 0018); the store is
chosen once at boot; a **withdrawal is not a deletion** (the fact that a
conflict was declared and then withdrawn is part of the history a reviewer
may need); the durable store says the same things the in-memory store
says; and the interest key stays **derived**, so two declarations of the
same interest cannot be recorded in two spellings and then fail to match.

**Proven.** The register's tests and eight against a real PostgreSQL (a
declaration survives a fresh read; the conflict is still found after a
restart; a duplicate is refused in the same words; a withdrawal leaves the
entry in place but stops it counting), and **four mutations proven red** —
one of them green on the first attempt because the anchor no longer matched
the code, so the mutation was skipping its own test rather than passing
it.

**What remains, named rather than left to rot:**

- **Nothing yet calls the register from a route.** The register is durable;
  the reviewer surface that would consult it — the seat assignment, the
  review queue, the conflict declaration and the abstention — is still to
  come, and it is the next piece of product work.
- Budgets and quotas, webhook endpoints, and API keys (with their
  revocations) are still in process memory.

## Q. The reviewer surface (2026-11-20, last) — a conflict that changes nothing is a decoration

The conflict register (P) and the audit chain (O) were both durable, and both
had **no consumer**: a declaration could be recorded and then change no
decision anywhere in the platform. A conflict of interest that changes no
behaviour is a decoration, and the register's whole reason for existing — the
check — was the thing that was never run.

**Now (ADR-0039).** A review queue, at `/reviews`, over the real chain:

- **The cases are chain-derived.** A trial whose status is `judging` or
  `challenged` — the windows in which the evidence exists and the chain has
  not settled it. A settled trial is not a case, *even one that was once
  disputed*: `disputeOpenedAt` says a dispute was opened at some point and
  stays set after the trial settles, and reading it as "the dispute is still
  open" would put every settled trial back on the queue.
- **The reviewer's own state is durable** (`review_claims`,
  `review_abstentions`, migration 0019), and one case has one holder: the
  uniqueness is on the case, not on the pair.
- **A conflict bars a reviewer from a case.** It is not a warning: the case
  is not offered, a direct claim is refused with the reason, and declaring a
  conflict releases the reviewer's claim. The sponsor is not a principal in
  the register, so the bar asks two questions — a shared interest, and a
  declared interest *in* the sponsor.

**Proven.** Thirteen API tests and nine against a real PostgreSQL (a claim
survives a fresh read; a second reviewer cannot take a held case; the same
reviewer can re-claim; an abstention keeps the reviewer's own words), **ten
mutations proven red**, and a browser proof at the real URL against the
running API and the live chain: two real cases on it, the reward in ETH with
"test ETH worth nothing on this chain" beside it, an em dash for the sponsor
that has not disclosed its suite, and — after the click — "You hold this
case", read back from a claim made **before the API was restarted**.

**Three defects the browser proof found that the tests did not.**

1. The page fetched the queue once, at mount, and never read it again: a
   reviewer who took a case watched the button stay on "Working…" and could
   not tell a refusal from a success. The page now reads the queue with the
   actions' refresh token.
2. The audit entry's id was derived from the action alone, while the chain is
   append-only with a unique id: the **second** claim of the same case
   collided with the first and the API answered **HTTP 500** instead of a
   sentence. An entry is an event, so it gets its own id — and a reviewer who
   already holds a case is refused with `already-yours` and a reason.
3. The settled-trial reading above, which the chain's own status fixed.

**What remains, named rather than left to rot:**

- **A hold has no timeout.** A reviewer who takes a case and then stops
  leaves it held: a timeout would push work back onto the queue with no way
  for the platform to know whether the reviewer was slow or gone, and
  inventing one would silently withdraw work from a reviewer who was, in
  fact, working.
- **The review verdict itself is not modelled.** What exists is the queue,
  the hold, the abstention and the conflict.
- The seat assignment is still unscreened by the register: the Argus draw
  happens on-chain (`ArgusCourt.conflictOf`) and the platform's role in it
  is still to be decided.
- Budgets and quotas, webhook endpoints, and API keys are still in process
  memory (AUTHZ-D1).
