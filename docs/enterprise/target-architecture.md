# Target architecture

**Date:** 2026-10-29 · **Baseline:** `develop` @ `9deb3f2`

Where the enterprise platform goes, and — more usefully — **where it does
not**. The brief says to preserve the product; this document records the
target as an extension of the tree that exists, not a replacement of it.

The governing constraint: **the escrow protocol is load-bearing and must not
move.** Every enterprise addition is therefore either beside the protocol or
inside a workspace that already exists, never inside `CrucibleTrials.sol`.

---

## 1. The shape of the target

```
                        ┌──────────────────────────────────────────┐
   enterprise buyer ───▶│  Control plane (new, off-chain)          │
   benchmark author     │  orgs · RBAC · budgets · audit export    │
   reviewer / skeptic   │  manifests · leaderboards · billing      │
                        └───────────────┬──────────────────────────┘
                                        │ reads and writes only through
                                        │ the interfaces below
        ┌───────────────────────────────┼───────────────────────────────┐
        │                               │                               │
        ▼                               ▼                               ▼
┌───────────────┐            ┌────────────────────┐            ┌────────────────┐
│ Evaluation    │            │  Escrow protocol   │            │  Read model    │
│ plane         │            │  (UNCHANGED)       │            │  (extended)    │
│ manifests     │            │  CrucibleTrials    │            │  manifest view │
│ suites        │            │  Arena (dormant)   │            │  comparability │
│ statistics    │            │  work-escrow       │            │  eligibility   │
│ adversary sim │            │  (not compiled)    │            │  usage metering│
└───────┬───────┘            └─────────┬──────────┘            └───────┬────────┘
        │                              │                               │
        └──────────────┬───────────────┴───────────────┬───────────────┘
                       │                               │
              ┌────────▼────────┐             ┌────────▼─────────┐
              │ Worker plane    │             │ Indexer          │
              │ (existing)      │             │ (existing)       │
              │ forge-runner    │             │ in-memory        │
              │ sandbox seal    │             │ ADR-0008         │
              │ argus re-verify │             │ reorg-aware?     │
              └─────────────────┘             └──────────────────┘
```

**The rule that shapes everything:** the control plane never holds a chain
key and never submits a money-moving transaction. It is a read-and-orchestrate
plane. Every write is wallet-signed by a participant (ADR-0006), and every
settlement is a pull payment from the contract (ADR-0003). This is not a
constraint the enterprise work has to work around — it is the property that
makes the product credible to an enterprise buyer, and losing it would cost
more than every feature in this document gains.

## 2. What is built, what is extended, what is new

| Layer | Today | Target |
|---|---|---|
| **Escrow protocol** | `CrucibleTrials.sol`, `AlloyRegistry.sol`, `ReputationBridge.sol`, `VerificationReceipt.sol`; `Arena.sol` + `ArgusCourt.sol` (dormant); `work-escrow` (not compiled) | **Unchanged.** The enterprise product is built around the protocol, not into it. |
| **Evaluation plane** | `packages/smith-sdk` (artifact, run hash), `packages/argus` (deterministic re-verify), `grader/` (shared-corpus scoring, model cards), `packages/eval` (splits, ratings, gates), `packages/datasets` (versioned manifests, holdout splits, leakage lint) | **Extended**: `EvalManifest` (done, ADR-0017), runner emits one, grader consumes one, paired statistics, adversary simulation. |
| **Worker plane** | `packages/forge-runner` (sandbox, egress, tool guard, tiers), `packages/agent-security` (35 controls) | **Extended**: attestation of the isolation actually enforced, image digest pinning, independent replay. |
| **Read model** | `packages/indexer` (in-memory, ADR-0008; `scribe.ts`, `model.ts`, `replica.ts`) | **Extended**: manifest projection, comparability, leaderboard eligibility, usage metering. **Not** replaced with Postgres — see §5. |
| **API** | `apps/api` (Hono, wallet-signed auth, no chain key, rate limiting, replay protection, DLQ) | **Extended**: org/RBAC scope, scoped API keys, signed webhooks, pagination, request IDs, idempotency. |
| **Product surface** | `apps/web` (Next.js, Industrial Forge) | **Extended**: Runs, Compare, Leaderboards, Datasets, Organisation, Billing. |
| **Control plane** | — | **New**: the org/workspace/membership/budget/audit-export model. |
| **Evidence** | CI: 7 jobs; `gitleaks`, `slither`, dependency audit, fork guards; `scripts/audit-gate.mjs` | **Extended**: SBOM per release, coverage floors per contract, backup/restore drill. |

## 3. The five slices, in order

Each is independently reviewable, independently shippable, and has a release
gate. `assessment.md` §5.1 derives these from the gap count; this is the
build order and the gate for each.

### S1 — Evaluation manifest ✅ **shipped** (ADR-0017)

The binding that makes a score mean something. Schema, digest, comparison
rules, 224 tests, nine mutation proofs.

**Gate:** `npm run test --workspace @crucible/smith` green, `tsc --noEmit`
clean, CI green, and — for the *wiring* that follows — the runner emits a
manifest whose digest a third party can recompute from the run's inputs.

**Still to do:** the runner does not emit one. That is S1b, and it is the
single highest-value line of work remaining.

### S1b — Runner emits the manifest

`packages/forge-runner` writes an `EvalManifest` next to the artifact and
publishes its digest. Nothing on chain changes; the manifest is content-
addressed and fetchable the way a spec is.

**Gate:** a run's manifest digest is reproducible from the run's inputs by a
party that holds only those inputs, proven by a test that recomputes it.

### S2 — Explicit economics model

Not a constant: **two typed schedules** (legacy 5%, arena 15%), each with id,
version, rate, base, rounding, payer and receiver, and a consumer API that
makes the schedule a required argument. The *rates* stay where they are — on
the chain, or in `params/crucible.params.json`. The typed schedules reference
them.

**Why this and not "move the fee into TypeScript":** the API reads `FEE_BPS`
off the deployed contract on purpose, so the host does not carry a copy that
can drift. Promoting a constant would reintroduce the drift that design
removes — and the code comments record the exact bug that motivated it (a
failed read once published a zero fee and a full payout as measured).

**Gate:** every fee display and every fee computation states its schedule;
the legacy and arena schedules cannot be confused by a caller; the existing
indexer and API tests still pass unchanged.

### S3 — Adversary simulation

Agent-based simulation of the mechanism against: Sybil identities, stake
splitting, juror bribery, sponsor–agent collusion, evaluator collusion,
cartel formation, spam challenges, benchmark leakage, score farming with
cheap tasks, and wash activity.

**Gate:** the simulation runs against the *real* constants read from
`params/crucible.params.json` and the chain's own `FEE_BPS`, so a change to a
constant changes the outcome. Published assumptions and a documented
equilibrium intuition — **not** a claim of game-theoretic security.

**This slice precedes any pricing change.** Changing a stake or fee constant
before simulating it is how the mechanism breaks.

### S4 — Organisation and tenancy

Orgs, workspaces, memberships, roles with a permission matrix, invitations
with expiry and revocation, per-org budgets and quotas, per-org dataset
visibility, audit export.

**Gate:** tenant isolation proven at the API, storage, artifact and queue
layers by tests that use two orgs and assert one cannot see the other.

**Note the precondition:** S4 introduces a multi-tenant world. The indexer is
in-memory and single-tenant by construction (ADR-0008), which is why S4 also
has to decide whether the indexer stays per-deployment or becomes
org-partitioned. That decision is part of S4's ADR, not this document.

### S5 — Release evidence

SBOM per release, backup/restore drill with measured RPO/RTO, SLO dashboards
for the measured uptime, and the kill-switch runbook.

**Gate:** a drill that actually restores, with the measured numbers written
down — not a policy saying it would work.

## 4. Data model

The brief asks for explicit, versioned schemas. What exists and what is
added:

| Entity | Today | Target |
|---|---|---|
| `Trial` | `contract-spec.md` §4.1 — 16 packed fields under `via_ir` | unchanged |
| `RunArtifact` | `RUN_ARTIFACT_SCHEMA_VERSION = "1.0.0"` | unchanged (signed) |
| **`EvalManifest`** | **new** — `EVAL_MANIFEST_SCHEMA_VERSION = "1.0.0"` | S1 ✅ / S1b |
| `DatasetManifest` | `packages/datasets` — `datasetId = sha256(JCS(manifest))` | add visibility + org scope (S4) |
| `Score` | grader row in `grader/results/*.jsonl` — schema implicit | explicit versioned schema + manifest digest |
| `Challenge` | chain events | explicit schema |
| `Settlement` | chain events | explicit schema |
| `ReputationEvent` | chain events | explicit schema |
| `Organization`, `Membership`, `Budget`, `Invoice`, `AuditEvent`, `Provider` | — | new (S4) |

**The two versioned schemas that exist are both content-addressed.** That is
the pattern to extend, not a convention to invent: `datasetId = sha256(JCS(manifest))`
and `manifestDigest = keccak256(JCS(manifest))`. Both put the identity in
the bytes rather than in a label, so a "version 2" that changed its content
would be a different id, not a misleading one.

## 5. What the target deliberately does not do

**It does not replace the in-memory indexer.** ADR-0008 chose in-memory
deliberately, and the brief's own constraint is to preserve working
behaviour. A Postgres indexer is a *scale* answer, and nothing in the
evidence says scale is the binding constraint — one live deployment, one
chain, 4 settled trials on the demo. If S4's tenancy work forces a
persistent indexer, that is a **new ADR with a migration plan**, because it
changes the deployment's failure modes (a lost index is currently a
re-scan-from-genesis, not data loss — and losing that property is a
regression, not an improvement).

**It does not touch `CrucibleTrials.sol`.** No new field, no new fee, no new
settlement path, no pause function. The brief's own rule — "do not change
deployed contract semantics ... without an ADR and migration plan" — plus the
fact that the contract's `Trial` is 16 packed fields under `via_ir` and
adding one re-triggers the stack-too-deep constraint. Any contract change is
its own slice with its own ADR and its own test plan.

**It does not add a token.** ADR-0001 and ADR-0002: native ETH, no ERC-20, no
sale, no bridge. The brief's economics section does not ask for one either,
and the pitch deck's own moat list names "No token" as moat #5.

**It does not unify the two fee schedules.** See
[`economics-and-incentives.md`](economics-and-incentives.md) §1.

**It does not ship Solana.** `work-escrow` has 3/3 host tests green but has
never been SBF-compiled, the toolchain is not on the build host, and
`docs/wallets.md` says the product is EVM-only. Solana is a separate
application with its own ADR and threat model — the brief agrees, and lists
it as P3 behind an independent audit and an explicit product decision.

## 6. Sequencing and the release gates

```
Gate 0  Baseline and containment      ✅ done (this engagement)
        gitleaks red on develop fixed; Cargo.lock staleness fixed;
        the chip actually mounted; test counts measured and recorded

Gate 1  Economic integrity            → S2
        two typed schedules; every fee display states its schedule

Gate 2  Evaluation integrity           → S1b, S3
        runner emits manifests; paired statistics; adversary simulation

Gate 3  Enterprise collaboration       → S4
        tenant isolation proven; RBAC; audit export; budget controls

Gate 4  Incentive integrity            → pricing proposal (after S3)
        published assumptions; independent review; no claim of formal proof

Gate 5  Frontier launch                → S5 + audits
        independent contract and infrastructure audits; DR drill; SLO
        evidence; explicit approval for real-value exposure
```

The brief's Gate 0 ("reproduce the existing demo, classify current gaps,
isolate unsafe execution paths, fix critical/high exposures") is what this
engagement's first slice did. Gates 1–3 are the next three slices.

---

*Related: [`assessment.md`](assessment.md),
[`evaluation-protocol.md`](evaluation-protocol.md),
[`economics-and-incentives.md`](economics-and-incentives.md),
[`security-threat-model.md`](security-threat-model.md),
[`roadmap.md`](roadmap.md).*
