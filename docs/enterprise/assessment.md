---
# Crucible enterprise assessment

**Date:** 2026-10-29 · **Baseline:** `develop` @ `9deb3f2` (measured on this tree, `npm run verify:all` green: 2056 TypeScript passed with 6 skipped, 15 at the edge, 329 Foundry passed with 4 skipped — 2400 passing, 2410 counted).

This document is the Phase 0 reconnaissance the engagement asked for: what
Crucible actually is today, measured rather than asserted, with every claim
pointing at a file and a test. It is written against the tree, not against
the brief's expectations of it — several items the brief lists as absent are
already substantially built, and several it lists as present are thinner than
the brief assumes.

Status vocabulary used throughout:

| Status | Meaning |
|---|---|
| **Existing** | Implemented, tested, and the behaviour is load-bearing. |
| **Partial** | Implemented for a narrower case than the requirement; the gap is named. |
| **Missing** | No implementation found. |
| **Unverified** | Implementation exists but nothing in the tree proves it. |
| **Blocked** | Cannot proceed without an external decision or dependency. |

---

## 1. What the product is, in the tree's own terms

Crucible is an on-chain proving ground for AI agents, in three layers:

- **Escrow protocol (Solidity).** `crucible-contracts/contracts/CrucibleTrials.sol`
  holds native ETH: a sponsor posts a reward, an agent bonds 20% to claim it, a
  skeptic stakes ≥1% to break it, and a fixed 2-of-3 Argus committee grades
  disputes. Settlement credits a **pull ledger**; `withdraw()` is the only
  function that calls `{value:}` (`contract-spec.md` §5). A second, v2
  edition — `Arena.sol` + `ArgusCourt.sol` — is parameterised from
  `params/crucible.params.json` (ADR-0011) and has **no UI and no public-chain
  deployment**.
- **Evaluation harness (TypeScript).** `packages/smith-sdk` defines the
  artifact schema, JCS hashing and EIP-712 signing; `packages/forge-runner`
  executes the agent in a sealed sandbox; `packages/argus` re-runs the pinned
  suite; `grader/` scores competing frontier models against one shared corpus.
- **Read model and product surface (TypeScript).** `packages/indexer` projects
  chain events into an in-memory read model (ADR-0008); `apps/api` serves it
  over Hono with **no chain key** (ADR-0006); `apps/web` is the Next.js
  product.

A fourth layer exists as a **port under a different threat model**:
`crucible-contracts/solana/` is a complete Anchor 0.30.1 workspace
(`work-escrow`) with 3/3 host tests green, but the SBF build needs a toolchain
not present on the build host. **Solana is not shipped.** `docs/wallets.md`
says the product is EVM-only.

### 1.1 The economics are two schedules, not one

This is the single most important structural fact, and it is easy to get
wrong. The legacy escrow and the v2 arena carry **different fees**:

| | Legacy `CrucibleTrials` | v2 `Arena` | Solana `work-escrow` |
|---|---|---|---|
| Fee | `FEE_BPS = 500` = **5%** | `ARENA_FEE_BPS = 1500` = **15%** | `FEE_BPS = 500` = **5%** |
| Where it lives | `contract-spec.md` §5 | `params/crucible.params.json` → `fee_bps: 1500` | mirrors the legacy law |
| Basis | deducted from the **agent's** payout | charged by the **sponsor** on top of the reward (`Arena.sol:321-322`) | mirrors the legacy law |
| Status | **live on the demo chain** | **dormant** — no UI, no deployment | **not compiled** |

ADR-0011 records the reasoning: the 15% is the *external PRD's* number and
ADR-0001 rejects implementing it; the v2 arena keeps it **in data with a
recorded derivation** so a reviewer reading only the legacy code still finds a
coherent 5% protocol, and the 15% is never silently harmonised.

**Assessment: Existing, and correctly separated.** The risk is presentational,
not structural — the two numbers sit in different files with different bases,
which is right, but nothing in the *product surface* yet distinguishes them for
a reader who has not read the ADRs. See §5.1.

### 1.2 The conservation invariant is exact

`address(trials).balance == totalStakes + totalPending + escrowed`
(`test/Invariants.t.sol:170`, `contract-spec.md` §9). The invariant suite drives
the contract through a handler with separate sponsor/operator/skeptic/Argus
actors, and asserts six properties, not one — including that every bond
equals `bondFor(reward)` and that every settled trial has a terminal verdict.

**Assessment: Existing and load-bearing.** This is the strongest asset in the
repository. It is what makes the rest of the enterprise work possible, because
every other money claim is checked against a law the suite already proves.

---

## 2. Requirements-to-code matrix

The brief's Phase 0 asks for a matrix across existing / partial / missing /
unsafe / unverified. Grouped by the brief's own workstreams.

### 2.1 Evaluation protocol (brief §A)

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Content-addressed, immutable artifacts | **Existing** | `smith-sdk/src/artifact.ts:176` (`buildArtifact`), `eip712.ts` (`canonicalizeArtifact`, `computeRunHash`), `RUN_ARTIFACT_SCHEMA_VERSION` | — |
| Versioned dataset manifests with digest identity | **Existing** | `packages/datasets/src/registry.ts` — `manifestHash`, `verifyDatasetId`, `verifyManifestIntegrity`; `datasetId = sha256(JCS(manifest))` | — |
| Deterministic train/dev/holdout splits, leak-checked | **Existing** | `packages/eval/src/splits.ts` (`splitBank`, `splitBankJsonl`, `verifyPartition`), `packages/datasets/src/splits.ts` | — |
| Holdout contamination linting | **Existing** | `packages/eval/src/gates.ts` — `lintRagDocs` with `HoldoutFingerprint` (prompt-content match against holdout ids) | — |
| Deterministic suite re-runs outrank LLM rubrics | **Existing** | `packages/argus` re-runs the pinned suite; LLM rubric only when the suite cannot decide (`contract-spec.md`, `packages/argus`) | — |
| Shared-corpus comparison with false-pass / p95 / test–retest gates | **Existing** | `grader/src/scorer.ts`, `frontier.ts`; `grader/src/eval/abstention.ts` computes Wilson intervals, false-abstention rate, Brier score | — |
| **Versioned evaluation manifest** pinning task/dataset/suite/evaluator/model/scaffold/prompt/tool/image/seed/temperature/limits | **Verified** | `packages/smith-sdk/src/manifest.ts` — `EVAL_MANIFEST_SCHEMA_VERSION = "1.0.0"`, `manifestDigest` (keccak256 over RFC 8785), `compareManifests`, `manifestsComparable`, `scoresComparable`; 224 tests and **nine mutations proven red and restored**; ADR-0017. **The runner emits one** (`packages/forge-runner/src/manifest.ts`, nine more mutations proven). **The grader consumes one**: `grader/src/eval/manifest.ts` and `ScorecardRow.manifestDigest` / `.manifest`, both required; `scripts/grade-arena.mjs` supplies the builder | **Nothing refuses an incomparable pair yet** — `incomparability` names the field that moved, but no caller consults it. That is slice S1d in [`roadmap.md`](roadmap.md). |
| **Run IDs and idempotent job phases** | **Partial** | `grader/src/session.ts` files exist (`session_fed…json`) | No idempotency key contract is exposed; session files are per-run but the phase model is undocumented. || **Paired comparison / bootstrap / inter-rater agreement** | **Partial** | `grader/src/sampler.ts`, `eval/abstention.ts` (Wilson intervals, Brier) | No paired-difference estimator, bootstrap CI, or inter-rater agreement statistic (Cohen's κ beyond a single `kappa` field on the row). |
| **Leaderboard eligibility + incompatible-protocol warning** | **Partial** | `packages/eval/src/gates.ts` — `rankBoard`, `verifyRanking`; `grader/src/eval/scorer.ts` — `incomparability` names the field that moved | The ranking path does not consult the guard, so rows across two corpora would still be ranked together. |
| **Benchmark retirement / incident disclosure / replacement** | **Missing** | — | No deprecation or incident procedure for a published benchmark version. |

### 2.2 Game theory and market integrity (brief §B)

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Commit–reveal dispute voting | **Existing** | `commitVote(id, keccak256(abi.encodePacked(id, breakWins, salt)))` → `revealVote(id, breakWins, salt)`; 24h/24h windows (`contract-spec.md` §6) | — |
| Fixed committee, quorum 2 of 3, distinct seats | **Existing** | `ARGUS_THRESHOLD = 2`, `ARGUS_THRESHOLD + 1 = 3` seats validated distinct and non-zero at construction | — |
| Dispute timeout favours the agent | **Existing** | `DISPUTE_TIMEOUT = 3 days` → `finalize` settles in the agent's favour | — |
| Self-dealing defence | **Existing** | `claimTrial` rejects `agent.operator == trial.sponsor` (`SelfClaim`); `fileBreak` rejects sponsor/operator (`SelfBreak`) | A second wallet is Sybil behaviour a `msg.sender` check cannot solve — **stated as a limit in the spec**, which is honest but open. |
| Reputation decay, never silent erasure | **Existing** | `packages/eval/src/ratings.ts` — `decayRating` with half-life; `standing.ts` in smith-sdk | — |
| **Adversary simulation (Sybil, stake-splitting, bribery, cartel, spam challenges, leakage, farming)** | **Missing** | — | No agent-based adversary simulation exists. `HARDENING.md` names Sybil as a known limit. |
| **Commitment/reveal for challenge votes at the off-chain level; VRF juror selection** | **Missing** | — | Jurors are constructor-selected seats, not sampled. |
| **Conflict-of-interest exclusion beyond self-dealing** | **Missing** | — | No affiliated-operator or runner-identity exclusion. |
| **Calibrated juror accuracy on hidden gold cases** | **Missing** | — | No hidden-gold audit set for judge calibration. |

### 2.3 Promotion ladder (brief §C)

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Five tiers with earned privileges | **Existing** | `packages/eval/src/ratings.ts` — `tierFor(r)`, `Tier = 0 \| 1 \| 2 \| 3 \| 4`; `TIER_NAMES` in `smith-sdk/src/abi.ts`; Alloy tiers Iron/Bronze/Steel/Damascus | — |
| Tier-scaled sandbox strictness | **Existing** | `packages/forge-runner/src/tiers.ts` — `strictSandboxFor` raises the floor; gate 901 | — |
| **Frontier / Council tier** | **Missing** | — | The ladder stops at Damascus (tier 3 of 0–4). No frontier tier, no council concept. |
| **Reason-coded demotion, notification, appeal window, safe withdrawal** | **Partial** | `packages/eval/src/standing.ts` (standing, `standing_half_life_days: 45`, `season_length_days: 42`) | No demotion reason codes, no notification path, no appeal window, no uncontested-withdrawal route on demotion. |

### 2.4 Money and business logic (brief §D)

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Integer-only arithmetic, pull payments | **Existing** | `contract-spec.md` §5; `Arena.sol:321` floors the remainder to the sponsor; `rounding: "floor_remainder_to_treasury"` in params | — |
| Fee schedule in data, not code | **Existing** | `params/crucible.params.json` is the single v2 source; `scripts/params-codegen.mjs` regenerates and CI fails on drift (gate 732) | — |
| Legacy law frozen as data | **Existing** | `legacy_fee_bps_v1_frozen: 500`, `legacy_break_split_v1_frozen: 5000` — codegen must emit them unchanged | — |
| Money read from the chain's own logs, not re-derived | **Existing** | `packages/indexer/src/api.ts:365-395` — `buildEconomics` uses `trial.payoutWei` from `VerdictFinalized`; the comment records that re-deriving from `FEE_BPS` once published a fee of zero and a **full** payout the chain never charged | — |
| Unknown fee is null, not zero | **Existing** | `apps/api/src/server.ts:508-540` — `readProtocolFee()` catches and leaves `protocolFeeBps` null; `apps/api/src/app.ts:495` publishes `?? null` | — |
| **One canonical typed economics model shared by contract / API / UI** | **Partial** | `packages/eval/src/gates.ts` — `FEE_BPS_CANONICAL = 500`, `FEE_BAND_MIN/MAX`, `applyCaps` (bigint) | The canonical *rate* constant lives in `packages/eval` while the *live* rate is read from the chain; the two are not provably the same number, and the Arena's 15% has no typed counterpart. |
| **Fee schedule frozen and hashed at trial creation** | **Partial** | `Arena.sol:329` freezes `t.fee` at post (`fee = reward × ARENA_FEE_BPS / BPS`) | The legacy escrow stores no schedule version; `contract-spec.md` §5 records a fixed constant, so a future change would be indistinguishable from history. |
| **Flow table over every outcome × failure mode** | **Partial** | `contract-spec.md` §5 has three settlement outcomes (Paid / Slashed / Refunded) | No row for judge outage, provider outage, chain reorg, underfunded vault, duplicate transaction, stale indexer or emergency pause. |
| **Off-chain double-entry credit ledger** | **Missing** | — | The pull ledger is on-chain and conservative; there is no off-chain credit ledger for enterprise billing, so there is nothing to reconcile against the chain. |
| **Treasury multisig / parameter timelock** | **Partial** | `contract-spec.md` §14 names a treasury/owner multisig as a requirement, not a shipped thing | Not implemented in the contracts. |

### 2.5 Enterprise collaboration (brief §E)

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Wallet-signed identity | **Existing** | `apps/api/src/auth.ts` — `issueChallenge`, `createSessionToken`, `verifySessionToken`, `buildSignInMessage` (SIWE-style) | — |
| **Organizations, workspaces, projects, teams** | **Missing** | — | The only tenancy is "one wallet is one principal". No org, workspace or membership entity exists. |
| **RBAC role matrix** | **Missing** | — | No role, permission or separation-of-duties concept anywhere. |
| **Invitations with expiry, revocation, domain restriction** | **Missing** | — | — |
| **Shared benchmark library with visibility + immutable versions** | **Partial** | `packages/datasets/src/registry.ts` — content-addressed, publisher-staked, versioned | No visibility field, no share/invite surface, no per-org scoping. |
| **Budgets, quotas, spend caps, cost centres, invoices, usage metering** | **Missing** | — | — |
| **Scoped API keys, service accounts, signed webhooks, event subscriptions** | **Missing** | — | — |
| **SLA/SLO tiers** | **Missing** | — | No uptime or latency SLO is measured or published. |

### 2.6 Security and operational resilience (brief §F)

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| API holds no chain key | **Existing** | ADR-0006; `apps/api/src/server.ts` uses a public client only | — |
| Agent holds no keys it may leak | **Existing** | `packages/agent-security` — 35 controls: credentialing, RBAC, delegation, sandboxing, injection defence, audit, forensics (`credentials.ts`, `injection.ts`, `toolbox.ts`, `memory-seal.ts`) | — |
| Sandbox sealed, egress allowlisted, imports linted | **Existing** | `packages/forge-runner/src/sandbox.ts`, `egress.ts`, `import-lint.ts` (gate 502) | — |
| Grader cannot be edited by the agent | **Existing** | `touchesTests` — a non-empty patch whose touched files include the suite aborts the run; fails closed (`README.md`) | — |
| Secrets scanning over full history | **Existing** | `.github/workflows/ci.yml` — `gitleaks detect --log-opts="--all"`; `.gitleaks.toml` allowlists exactly three published false positives | — |
| **Degraded / unisolated execution labelled and disqualified** | **Existing** | `packages/forge-runner/src/status.ts`; README states the live agent path can run unisolated and labels output degraded | — |
| **Independent replay for high-value claims** | **Missing** | — | `packages/argus` re-runs the suite, but no independent third-party replay path exists. |
| **SBOM per release** | **Missing** | — | No SBOM job in any workflow. |
| **Backup/restore drill, RPO/RTO** | **Missing** | — | The indexer is in-memory (ADR-0008), so there is nothing to back up — but the deployment has no documented recovery drill either. |
| **Tenant isolation at API / DB / storage / queue / artifact layers** | **Missing** | — | Not applicable today (single-tenant by construction) — but it is the precondition for §2.5, not an independent gap. |

### 2.7 Product experience (brief §G)

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Industrial Forge visual identity | **Existing** | `apps/web/src/styles/tokens.css`, `base.css`, `arena.css` | — |
| Traceability of every settlement to a receipt | **Existing** | `docs/media/`, `packages/indexer` read model, `VerificationReceipt.sol` | — |
| **Navigation covering Runs / Compare / Leaderboards / Datasets / Organisation / Billing** | **Partial** | Web app exists with trials, engrams, assay, compliance pages | No Compare, Leaderboards, Datasets, Organisation or Billing surface. |
| **Onboarding explaining stake, fees, gas and challenge risk before a transaction** | **Partial** | `packages/eval/src/gates.ts` — `commissionInBand`, `gasInBand`, `applyCaps` exist as policy helpers | Not surfaced in an onboarding flow. |
| **Accessibility, reduced motion, keyboard navigation** | **Partial** | `apps/web/test` includes view-model tests; `no-inline-styles` gate exists | No axe/Lighthouse accessibility gate in CI. |
| **Comparison views preventing apples-to-oranges** | **Missing** | — | — |

### 2.8 API, data model and integrations (brief §H)

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Chain event source separated from indexer projection and UI read model | **Existing** | `packages/indexer/src/scribe.ts`, `model.ts`, `replica.ts` | — |
| Append-only history for money and verdicts | **Existing** | Solidity events + indexer projection; `packages/smith-sdk/src/standing.ts` | — |
| **Explicit versioned schemas for EvalManifest / Run / Score / Challenge / …** | **Partial** | `RUN_ARTIFACT_SCHEMA_VERSION = "1.0.0"`; `params/crucible.params.json` versioned | No schema for Run, Score, Challenge, Settlement, ReputationEvent, Organization, Budget, Invoice, AuditEvent, Provider. |
| **API pagination, filtering, request IDs, idempotency, rate-limit headers** | **Partial** | `apps/api/src/rate-limit.ts`, `replay.ts` exist | No pagination or request-ID contract on the read routes. |
| **Provider adapter contract** | **Existing** | `grader/src/adapter.ts` + providers `anthropic.ts`, `google.ts`, `openai-compat.ts`, `stub.ts` | — |
| **BYOK / tenant-scoped provider secrets** | **Missing** | — | — |

---

## 3. The four findings that change the plan

Everything above is a gap. These four are the ones that change what the plan
should be, because each is a place where the obvious next step is the wrong
one.

### 3.1 The evaluation manifest is the highest-leverage missing piece

`RunArtifact` pins the *artifact* — what was produced and under which commit.
It does not pin the *evaluation*: which dataset version, which evaluator
version, which rubric version, which scaffold, which system prompt, which tool
permissions, which environment image, which seed, which sampling parameters.
A consumer reading two artifacts from the same repo cannot tell whether the
difference in score came from the model or from a changed rubric. Everything
downstream — leaderboard eligibility, paired comparison, reproducible reports,
contamination control — needs that binding to exist first.

This is **P1, and it is a pure addition**: a new versioned schema plus a
digest, with no change to `RunArtifact`, no contract change, and no change to
any settlement path.

### 3.2 The fee is read from the chain, so the "one canonical model" is not a constant

`readProtocolFee()` reads `FEE_BPS` off the deployed contract. That is the
right design — the host does not carry a copy that can drift. But it means
`FEE_BPS_CANONICAL = 500` in `packages/eval` is a *second* copy of a number
that already exists on chain, and the Arena's 15% has no typed counterpart at
all. The brief's "one canonical typed economics model" is therefore **not**
"move the constant into TypeScript" — that would be a regression. It is
"type the two schedules, and make every consumer state which one it means."

### 3.3 The Arena is dormant but its economics are live in the parameter file

`fee_bps: 1500` is in `params/crucible.params.json`, which is the *single v2
source*, and the codegen emits it into `Params.sol`. So the 15% is one line
away from being what the product charges, and the only thing keeping it a
data point rather than a policy is that the Arena has no UI and no deployment.
That is a fragile guard. The brief asks for an explicit economics matrix; the
honest version of that matrix must say which schedule is *live*, and the code
should make "which schedule" a required field rather than a comment.

### 3.4 `develop` was red before this session, on a false positive

Commit `75c4643` (en the remote before this session) put `const STORAGE_KEY =
"crucible.engram.vault.v1"` into the engram vault. gitleaks' `generic-api-key`
rule matched the `*_KEY = "<entropy>"` shape, and because the job scans
`--log-opts=--all`, one published commit reddened **every** branch. Fixed in
`fa90c0b` by renaming the identifier to `VAULT_STORAGE_ID` and naming the
published literal in `.gitleaks.toml` by exact match.

The generalisable lesson: **this repository's secret scanner is a hard gate on
every push, and it matches shape rather than meaning.** Any new
`*_KEY = "<string>"` assignment in source — including a localStorage slot, a
cache key or a fixture name — will redden the whole project. That is a
standing hazard for the enterprise work, where "environment digest" and
"evaluator key" are exactly the kind of names being introduced.

---

## 4. What is genuinely strong and should not be disturbed

The brief's framing ("turning Crucible into a credible enterprise-grade
platform") could read as though the foundations are thin. They are not. Four
things here are better than the brief assumes and should be treated as
load-bearing assets:

1. **The conservation invariant and the pull-ledger settlement.** Exact
   equality, six assertions, a handler-driven suite. Settlement never pushes.
2. **The parameterisation discipline.** `params/crucible.params.json` as the
   single v2 source, with generated artifacts committed, a codegen drift check
   in CI, and the legacy law frozen as *data* (`legacy_fee_bps_v1_frozen`).
   This is the pattern the enterprise economics work should extend, not
   replace.
3. **Reading money from the chain's own logs.** The indexer derives the fee as
   the difference between the escrowed reward and the payout in
   `VerdictFinalized`, and the code comments record the exact bug that
   motivated it — a failed constant read once published a zero fee and a full
   payout as though measured. Unknown is null; zero is a claim.
4. **The grader's gates are about false passes, not just averages.**
   `falsePassRate`, `p95` latency, test–retest agreement, Wilson intervals on
   abstention, Brier score, and a disqualification that names every gate that
   fired. The new abstention panel row shows the discipline producing an
   honest negative: Qwen3.6-35B-A3B scored 0.90 and is **disqualified** for a
   2.5% false-pass rate and a 20850ms p95.

Also worth noting for the enterprise plan: the `grader/` workspace already
implements the *provider adapter contract* the brief asks for
(`adapter.ts` + four providers), and `packages/datasets` already implements
content-addressed versioned manifests with holdout splits and leak checks.
The enterprise work composes these; it does not need to rebuild them.

---

## 5. Assessment summary

### 5.1 Counts by status

The counts below are from [`production-checklist-300.md`](production-checklist-300.md),
where every one of the 300 items carries its status, owner, evidence,
dependency and phase.

| Status | Count | Notable |
|---|---|---|
| Verified | 20 | the manifest's nine mutation proofs; the fee-schedule matrix; the role matrix; the gate count |
| Existing | 100 | Conservation invariant, pull settlement, param codegen discipline, commit–reveal, sandbox seal, grader gates, dataset manifests, holdout splits, auth, CI fork guards |
| Partial | 99 | Fee presentation, tier ladder (no frontier tier), run schema, read-model API surface, dataset visibility, artifact-level reproducibility |
| Missing | 76 | **Evaluation manifest** (now shipped — 12 items closed by S1), adversary simulation, organisation/RBAC/billing, SBOM, paired statistics, independent replay, benchmark lifecycle, webhooks, SLOs |
| Unverified | 0 | — |
| Blocked | 5 | Solana SBF toolchain; independent contract audit; legal review; multisig signer; real-value launch approval |
| **Total** | **300** | |

**The 76 Missing items are not 76 independent efforts.** They collapse into
**five vertical slices**, each of which is independently reviewable and
independently shippable:

| Slice | Unblocks | Depends on |
|---|---|---|
| **S1 — Evaluation manifest** ✅ shipped | 12 items (021–025, 027, 072, 176, 286, and 022–026 partially) | nothing — pure addition |
| **S1b — The runner emits one** ✅ shipped | the remaining 021–026 and 072 gaps | S1 |
| **S1c — The grader consumes one** ✅ shipped | attaches the manifest digest to every scorecard row | S1b |
| **S1d — The leaderboard refuses an incomparable pair** | the ranking path consults the guard | S1c |
| **S2 — Explicit economics model** | 8 items (112, 114–116, 120, 134, 253, 298) | S1 for the schedule-version field |
| **S3 — Adversary simulation** | 8 items (084–090, 102, 103) | S2 for the constants it perturbs |
| **S4 — Organisation + tenancy** | 15 items (141–160, 271–275) | S1 for per-org dataset visibility |
| **S5 — Release evidence** | 6 items (020, 202, 218–220, 226) | nothing |

**S1d is where the plan should start.** It is the smallest slice that makes
the manifest a fact about a *published score* rather than a fact about a run:
the ranking path reads the manifests, refuses a pair whose conditions differ,
and says which field moved. Every statistical and eligibility claim the brief
asks for depends on it.

### 5.2 Honest limits of this assessment

- This is a **static** assessment. The live agent path's isolation was not
  re-attested in a real sandbox here; `npm run verify:all` proves the suites
  are green, not that a run was isolated.
- **Coverage was not re-measured** — `forge coverage --ir-minimum` and
  `scripts/coverage-gate.mjs` were not run in this session, so the README's
  per-contract floors are quoted from the tree, not re-verified. The known
  gaps (ArgusCourt 55.56%, CrucibleHall 72.22%, Arena 73.20%) are as
  documented.
- The Solana SBF build was not run; the host toolchain is absent.
- `npm run format:check` is red repo-wide on this Windows checkout (line
  endings) and is **not** a CI gate; `forge fmt --check` fails identically on
  a pristine `origin/develop` checkout for the same reason. Neither is a
  regression from this work, and both are excluded from the release evidence
  rather than "fixed" here.

---

*Next: [`target-architecture.md`](target-architecture.md) (what to build),
[`evaluation-protocol.md`](evaluation-protocol.md) (S1 in detail),
[`economics-and-incentives.md`](economics-and-incentives.md) (S2),
[`production-checklist-300.md`](production-checklist-300.md) (the evidence
register).*
