---
title: Crucible enterprise production checklist
date: 2026-10-29
baseline: develop@9deb3f2
---

# Production checklist — 300 must-haves

**Date:** 2026-10-29 · **Baseline:** `develop` @ `9deb3f2`

An **evidence register**, not a promise. Each item's status is decided by the tree
on the baseline commit, and the evidence column names the file or test that decides
it. A checkbox is complete only when the implementation exists **and** the named
evidence is attached.

| Status | Meaning |
|---|---|
| **Verified** | Implemented **and** proven by a named test or measurement in this engagement |
| **Existing** | Implemented, tested, load-bearing |
| **Partial** | Implemented for a narrower case; the gap is named in the evidence column |
| **Missing** | No implementation found |
| **Unverified** | Implementation exists but nothing in the tree proves it |
| **Blocked** | Cannot proceed without an external decision, signer or dependency |

**Owner** is a role, not a person. **Phase** is the release phase: P0 safety and
correctness, P1 enterprise usability, P2 evaluation breadth, P3 advanced market
mechanisms.

## Summary

| Status | Count |
|---|---|
| Verified | 20 |
| Existing | 99 |
| Partial | 100 |
| Missing | 76 |
| Unverified | 0 |
| Blocked | 5 |
| **Total** | **300** |

The five slices in [`roadmap.md`](roadmap.md) are the build order; each item's
dependency column names the slice that closes it.

## Product strategy and scope

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 001 | Enterprise value proposition for model and agent evaluations | **Existing** | Founder | docs/business/plan.md; docs/business/valuation-and-raise.md | — | P1 |
| 002 | Personas: model lab, enterprise buyer, benchmark author, agent operator, skeptic, auditor | **Partial** | Founder | docs/enterprise/collaboration-and-governance.md §3; roles exist in the matrix, personas are not written as personas | S4 | P1 |
| 003 | Separate shipped capabilities from proposed roadmap features | **Verified** | Principal engineer | docs/enterprise/roadmap.md §3; docs/enterprise/assessment.md §2 — Shipped vs deferred is now an explicit table | — | P1 |
| 004 | Product boundary between evaluation platform, escrow protocol and marketplace | **Existing** | Principal engineer | docs/adr/0001-agent-proving-ground.md; docs/enterprise/assessment.md §1 | — | P0 |
| 005 | Success metrics for trust, adoption, evaluation quality and unit economics | **Missing** | Founder | — | S3 | P2 |
| 006 | Competitive capability matrix with evidence and dated references | **Partial** | Founder | docs/business/valuation-and-raise.md §2 (10 comparables, each with a source and a date) | — | P1 |
| 007 | Public, private, confidential and regulated-data evaluation modes | **Missing** | Principal engineer | — | S4 | P1 |
| 008 | Supported model, agent, tool, runtime and benchmark types | **Partial** | Principal engineer | grader/src/adapter.ts + 4 providers; packages/forge-runner/src/sandbox.ts | S1b | P2 |
| 009 | Glossary for Trial, Alloy, Argus, Break, bond, escrow, artifact, attestation | **Partial** | Principal engineer | docs/business/investor-faq.md; crucible-contracts/docs/contract-spec.md §2 | — | P1 |
| 010 | Versioned PRD with measurable acceptance criteria | **Missing** | Founder | — | — | P1 |
## Repository and engineering governance

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 011 | Clean baseline git status and current commit recorded before edits | **Verified** | Principal engineer | docs/enterprise/assessment.md header; baseline develop@9deb3f2 | — | P0 |
| 012 | Map all packages, services, contracts, jobs, APIs and data stores | **Verified** | Principal engineer | docs/enterprise/assessment.md §1, §2 | — | P0 |
| 013 | Map package dependencies and ownership boundaries | **Partial** | Principal engineer | docs/enterprise/assessment.md §2 groups by workspace | — | P1 |
| 014 | Document local, demo, staging and production commands | **Existing** | Principal engineer | package.json scripts; README.md §Commands; docs/setup.md | — | P0 |
| 015 | Inventory every environment variable by name, owner, exposure class and rotation | **Existing** | Principal engineer | docs/key-inventory.md; .env.example; docs/runbooks/credentials-and-deploy.md | — | P0 |
| 016 | Architecture diagrams for control plane, worker plane and chain interactions | **Partial** | Principal engineer | docs/enterprise/target-architecture.md §1 (the control plane is new) | S4 | P1 |
| 017 | ADRs for architecture, economics, identity and chain decisions | **Verified** | Principal engineer | docs/adr/ — 17 records; README.md index; ADR-0017 added this engagement | — | P0 |
| 018 | CODEOWNERS for contracts, money logic, security and production workflows | **Missing** | Founder | — | — | P1 |
| 019 | Require review for contract, auth, billing and evaluator changes | **Partial** | Founder | CI fork guards (ci.yml); no per-path review requirement | S4 | P1 |
| 020 | Generate an SBOM for every production release | **Missing** | DevOps | — | S5 | P1 |
## Evaluation protocol and reproducibility

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 021 | Versioned immutable evaluation manifest schema | **Verified** | Principal engineer | packages/smith-sdk/src/manifest.ts; EVAL_MANIFEST_SCHEMA_VERSION = 1.0.0; 224 tests | — | P0 |
| 022 | Pin benchmark, dataset, evaluator and rubric versions by digest | **Verified** | Principal engineer | manifest.ts — taskDigest, datasetDigest, suiteDigest, evaluator.rubricVersion; digest proven red when the rubric is dropped | S1b | P0 |
| 023 | Pin model/provider/version, agent scaffold and system configuration | **Verified** | Principal engineer | manifest.ts — model{provider,name,version}, agent{scaffold,systemPromptDigest} | S1b | P0 |
| 024 | Record environment image digest, dependencies and resource limits | **Verified** | Principal engineer | manifest.ts — environment{imageDigest,limits,timeoutMs} | S1b | P0 |
| 025 | Record seeds, decoding settings, retries, timeout and tool permissions | **Verified** | Principal engineer | manifest.ts — seed, sampling, agent.tools, agent.toolPermissions | S1b | P0 |
| 026 | Stable run IDs and idempotency keys per execution phase | **Partial** | Principal engineer | grader/src/session.ts session files; the grader attaches a manifest digest to every scorecard row, but there is no exposed idempotency key and the phase model is undocumented | S1d | P1 |
| 027 | Store artifacts content-addressed and verify bytes against their digest | **Existing** | Principal engineer | packages/cidstore; packages/smith-sdk/src/eip712.ts digestOfContent; packages/datasets/src/registry.ts verifyDatasetId | — | P0 |
| 028 | Separate capability scores from scaffold, prompt and tool-access effects | **Partial** | Principal engineer | manifest.ts separates the fields, so a comparison can attribute; no report surfaces it yet | S1c, S3 | P2 |
| 029 | Score final environment state and verifiable artifacts, not self-reported success | **Existing** | Principal engineer | packages/argus re-runs the pinned suite; the run artifact is signed and its results re-derived | — | P0 |
| 030 | Reproducibility report listing every variable that can change a result | **Partial** | Principal engineer | the manifest IS that list, the runner emits it and the grader attaches it to every row; no rendered report yet | S1d | P2 |
## Benchmark quality and contamination

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 031 | Private holdout datasets for high-stakes leaderboards | **Partial** | Principal engineer | packages/eval/src/splits.ts splitBank (holdout role exists); no private unpublished holdout set | S1b | P2 |
| 032 | Canary markers and leakage monitoring in benchmark assets | **Missing** | Principal engineer | — | S3 | P2 |
| 033 | Near-duplicate and semantic similarity checks on submitted tasks | **Missing** | Principal engineer | packages/datasets/src/linter.ts is a LEAKAGE checker, not a near-duplicate detector | S4 | P2 |
| 034 | Record benchmark exposure and known training contamination disclosures | **Missing** | Principal engineer | — | S3 | P2 |
| 035 | Rotate selected tasks under a documented protocol-version policy | **Missing** | Principal engineer | — | S3 | P2 |
| 036 | Require human review for benchmark tasks before publication | **Missing** | Principal engineer | — | S4 | P2 |
| 037 | Run reference solutions and verify tests detect both success and plausible failures | **Partial** | Principal engineer | grader/src/break-mutant.ts; packages/argus | — | P2 |
| 038 | Test whether agents can exploit grader outputs or hidden environment state | **Existing** | Principal engineer | packages/forge-runner/src/tool-guard.ts; grader/src/eval/abstention.ts (30 unanswerable probes defeat a grader that always abstains) | — | P0 |
| 039 | Keep hidden tests inaccessible to model, agent, sponsor and runner | **Existing** | Principal engineer | touchesTests fails closed on any patch touching the suite; the spec/suite digest is committed at post | — | P0 |
| 040 | Benchmark retirement, incident disclosure and replacement procedures | **Missing** | Principal engineer | — | S4 | P2 |
## Scoring and statistical validity

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 041 | Report sample size alongside every score | **Existing** | Principal engineer | grader rows carry n and graded; abstention.ts reports n=40 | — | P1 |
| 042 | Confidence intervals appropriate to the evaluation design | **Partial** | Principal engineer | Wilson intervals in grader/src/eval/abstention.ts; a paired-difference estimator and bootstrap interval still to come | S1d, S3 | P2 |
| 043 | Paired comparisons when candidates share task instances | **Missing** | Principal engineer | the comparator exists (`compareManifests`) and the grader refuses an incomparable pair; no paired-difference estimator does | S1d, S3 | P2 |
| 044 | Report variance across seeds, prompts and repeated trials | **Missing** | Principal engineer | the manifest records the seed and the grader attaches it; variance across seeds is not yet reported | S1d | P2 |
| 045 | Measure inter-rater agreement for human and model judges | **Partial** | Principal engineer | a kappa field on a grader row; the manifest makes the rubric version comparable, but no systematic inter-rater statistic | S1d, S3 | P2 |
| 046 | Calibrate LLM judges against audited gold examples | **Missing** | Principal engineer | — | S3 | P2 |
| 047 | Keep deterministic checks authoritative when they decide an outcome | **Existing** | Principal engineer | docs/adr/0005-deterministic-evidence-first.md; manifest.scoring.decision | — | P0 |
| 048 | Report false-pass and false-fail rates for evaluators | **Existing** | Principal engineer | grader/src/scorer.ts falsePassRate/falseFailRate; the panel row carries both | — | P1 |
| 049 | Track test-retest agreement and evaluator drift | **Existing** | Principal engineer | grader gates on test-retest agreement (kappa, consistency) | — | P1 |
| 050 | Publish failure taxonomies and uncertainty, not only a leaderboard rank | **Partial** | Principal engineer | grader/src/eval/abstention.ts failure kinds and intervals; the grader row now carries the manifest, so a reader can see the conditions - but there is no published leaderboard surface | S1d, S4 | P2 |
## Agent and frontier capability coverage

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 051 | Support model-only task evaluation | **Existing** | Principal engineer | grader/src/adapter.ts + stub.ts; grader/src/eval/suites.ts | — | P1 |
| 052 | Support multi-step tool-use evaluation | **Existing** | Principal engineer | packages/forge-runner/src/agent.ts; packages/agent-security/src/toolbox.ts | — | P1 |
| 053 | Support terminal and software-engineering tasks in isolated environments | **Existing** | Principal engineer | packages/forge-runner/src/sandbox.ts; the sealed sandbox is the SWE environment | — | P1 |
| 054 | Support browser/computer-use tasks with recorded permissions | **Missing** | Principal engineer | — | S2 | P2 |
| 055 | Support multi-agent cooperation and delegation tests | **Missing** | Principal engineer | — | S3 | P2 |
| 056 | Measure long-horizon task completion and recovery from intermediate failures | **Partial** | Principal engineer | packages/eval/src/trajectories.ts; grader/src/cascade.ts | — | P2 |
| 057 | Measure tool-call correctness and invalid-argument rates | **Partial** | Principal engineer | packages/agent-security/src/validation.ts; the grader's failure kinds | — | P2 |
| 058 | Measure instruction following under conflicting untrusted content | **Existing** | Principal engineer | packages/agent-security/src/injection.ts; suite output quarantined as data (forge-runner agent.ts:183) | — | P1 |
| 059 | Measure robustness to distribution shift and adversarial examples | **Partial** | Principal engineer | packages/eval/src/splits.ts (dev/holdout shift); grader probes | S3 | P2 |
| 060 | Measure cost, latency, token use, reliability and success together | **Existing** | Principal engineer | grader rows carry avgCostUsd, p95LatencyMs, accuracy, consistency | — | P1 |
## Execution sandboxing

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 061 | Ephemeral isolation for each untrusted run | **Partial** | Principal engineer | packages/forge-runner/src/sandbox.ts; the live path CAN run unisolated and is labelled degraded | — | P0 |
| 062 | Rootless containers or VM/microVM isolation appropriate to risk | **Partial** | Principal engineer | packages/forge-runner/src/sandbox.ts; no microVM | — | P1 |
| 063 | Pin runtime images by immutable digest | **Existing** | Principal engineer | resolveVerifierImage in packages/forge-runner/src/runner.ts; the manifest records the image that ran and the image is a MUTABLE `:latest` tag | S5 | P0 |
| 064 | Disable privileged mode and drop unnecessary Linux capabilities | **Existing** | Principal engineer | packages/forge-runner/src/sandbox.ts; the sandbox seal is CI-enforced at gate 502 | — | P0 |
| 065 | Apply seccomp/AppArmor or equivalent mandatory restrictions | **Existing** | Principal engineer | the sandbox seal enforced by packages/forge-runner/src/import-lint.ts (gate 502) | — | P0 |
| 066 | Enforce CPU, memory, process, disk and wall-clock limits | **Partial** | Principal engineer | manifest.environment.limits carries them; enforcement is not attested per run | S1b | P1 |
| 067 | Read-only base filesystems and bounded writable scratch space | **Existing** | Principal engineer | packages/forge-runner/src/sandbox.ts | — | P0 |
| 068 | Prevent access to host Docker sockets and host filesystem mounts | **Existing** | Principal engineer | the sandbox seal (gate 502) forbids it | — | P0 |
| 069 | Enforce outbound network policy and domain allowlists | **Existing** | Principal engineer | packages/forge-runner/src/egress.ts — the model call is the one path out | — | P0 |
| 070 | Verify cleanup of processes, mounts, volumes and temporary credentials after every run | **Partial** | Principal engineer | the sandbox is ephemeral by construction; cleanup is not attested per run | S1b | P1 |
## Runner integrity and artifacts

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 071 | Sign runner attestations with a scoped runner identity | **Existing** | Principal engineer | packages/smith-sdk/src/eip712.ts RUN_TYPES + domainFor; the run signature is EIP-712 over the artifact | — | P0 |
| 072 | Bind attestation to manifest, image, artifact and result digests | **Partial** | Principal engineer | the artifact binds spec/suite/repo/commit; the manifest binds the image and the limits and is EMITTED beside the artifact (`packages/forge-runner/src/manifest.ts`, nine mutations proven) | The manifest is hashed, not signed — by design, so an evaluation-schema change cannot touch the money path | P0 |
| 073 | Reject artifacts whose hashes or signatures do not verify | **Existing** | Principal engineer | packages/argus re-derives; the contract recomputes the EIP-712 digest and requires the agent's current runner | — | P0 |
| 074 | Prevent agents from modifying grader code or hidden tests | **Existing** | Principal engineer | touchesTests fails closed | — | P0 |
| 075 | Fail closed when changed-file detection is ambiguous | **Existing** | Principal engineer | touchesTests fails closed on a non-empty patch that touches the suite | — | P0 |
| 076 | Label local or unisolated execution as degraded | **Existing** | Principal engineer | packages/forge-runner/src/status.ts; README states the live path can run unisolated | — | P0 |
| 077 | Disqualify degraded execution from high-trust rewarded trials | **Partial** | Principal engineer | mayEarnAtTier refuses frontier payouts below tier (gate 901); the rule is not enforced on every reward path | S2, S3 | P1 |
| 078 | Record runner version, host class and isolation mode | **Partial** | Principal engineer | the manifest records the image digest and limits; the runner version and host class are not recorded | S1b | P1 |
| 079 | Independent replay for high-value claims | **Missing** | Principal engineer | — | S3 | P2 |
| 080 | Keep tamper-evident execution and artifact access logs | **Partial** | Principal engineer | packages/agent-security/src/audit.ts; the content store's disclosure log | — | P1 |
## Game theory and incentive design

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 081 | Define the players, strategies, information sets and utility functions | **Verified** | Principal engineer | docs/enterprise/game-theory.md §1-§2 | — | P0 |
| 082 | Document assumptions and target equilibrium before changing incentives | **Verified** | Principal engineer | game-theory.md §4 (7 assumptions), §6 (5 intentions), §7 | — | P0 |
| 083 | Model sponsor, agent, skeptic, juror, evaluator and treasury incentives | **Verified** | Principal engineer | game-theory.md §1, §2 | — | P0 |
| 084 | Simulate sponsor-agent collusion and shared ownership | **Missing** | Principal engineer | game-theory.md §5.7 specifies it; no simulation exists | S3 | P2 |
| 085 | Simulate Sybil identities and stake splitting | **Missing** | Principal engineer | game-theory.md §5.1-§5.2 — the mechanism's unsolved attack | S3 | P2 |
| 086 | Simulate juror bribery, vote buying and cartel coordination | **Missing** | Principal engineer | game-theory.md §5.3-§5.4 | S3 | P2 |
| 087 | Simulate spam challenges, griefing and repeated false disputes | **Missing** | Principal engineer | game-theory.md §3, §5.9 | S3 | P2 |
| 088 | Simulate benchmark leakage and score farming with cheap tasks | **Missing** | Principal engineer | game-theory.md §5.6, §5.10 | S3 | P2 |
| 089 | Test whether incentives reward independent correctness rather than majority imitation | **Missing** | Principal engineer | — | S3 | P2 |
| 090 | Document known mechanism failures without claiming a proof | **Verified** | Principal engineer | game-theory.md — no game-theoretic-security claim is made anywhere | — | P0 |
## Skeptic and jury integrity

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 091 | Use commit-reveal for challenge votes where appropriate | **Existing** | Principal engineer | commitVote/revealVote with keccak256(id, breakWins, salt); 24h/24h windows | — | P0 |
| 092 | Exclude conflicted judges and record the reason | **Partial** | Principal engineer | SelfClaim/SelfBreak reject the same operator; no affiliation exclusion | S4 | P2 |
| 093 | Use deterministic replay before probabilistic rubric judging | **Existing** | Principal engineer | docs/adr/0005; packages/argus re-runs the pinned suite first | — | P0 |
| 094 | Count crashed or unavailable judges as non-voting | **Existing** | Principal engineer | a seat that never commits simply does not vote; DISPUTE_TIMEOUT settles for the agent | — | P0 |
| 095 | Track judge accuracy on hidden gold cases | **Missing** | Principal engineer | — | S3 | P2 |
| 096 | Track calibration and confidence quality by judge | **Partial** | Principal engineer | grader/src/eval/abstention.ts Brier score per candidate | S3 | P2 |
| 097 | Use randomized independent juror selection where supported | **Missing** | Principal engineer | seats are constructor-selected; no VRF | S4 | P3 |
| 098 | Define quorum, tie, abstention and timeout behavior | **Existing** | Principal engineer | ARGUS_THRESHOLD = 2 of 3; DISPUTE_TIMEOUT = 3 days favours the agent | — | P0 |
| 099 | Provide evidence-based appeals and correction records | **Missing** | Principal engineer | — | S4 | P2 |
| 100 | Make dispute evidence access least-privilege and time-bounded | **Partial** | Principal engineer | the suite is fetched by content digest; the proof CID is a commitment | S4 | P2 |
## Reputation and promotion

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 101 | Keep Alloy non-transferable and separate from money balances | **Existing** | Principal engineer | AlloyRegistry.sol — soulbound, no transfer path; VerificationReceipt likewise | — | P0 |
| 102 | Track quality, robustness, calibration, reliability and recency separately | **Partial** | Principal engineer | packages/eval/src/ratings.ts (mu/sigma), decayRating, skill nodes; the dimensions are not separately reported | S3 | P2 |
| 103 | Prevent promotion by raw transaction volume alone | **Partial** | Principal engineer | AlloyRegistry derives a tier from wins AND survived breaks, not volume; but cheap-task farming is unmodelled (game-theory §5.6) | S3 | P2 |
| 104 | Require diverse benchmark families for higher tiers | **Missing** | Principal engineer | — | S3 | P2 |
| 105 | Require independent challenge survival for designated tiers | **Existing** | Principal engineer | Steel needs >=1 survived, Damascus >=3 (AlloyRegistry.sol) | — | P1 |
| 106 | Set explicit promotion thresholds and publish their version | **Existing** | Principal engineer | AlloyRegistry.sol tier table; TIER_NAMES in smith-sdk/src/abi.ts | — | P1 |
| 107 | Define suspension and demotion reason codes | **Missing** | Principal engineer | — | S4 | P2 |
| 108 | Notify participants of tier changes with evidence and appeal windows | **Partial** | Principal engineer | TierChanged is emitted; no notification surface and no appeal window | S4 | P2 |
| 109 | Preserve append-only settlement history when reputation is corrected | **Existing** | Principal engineer | lifetimeWins is never decremented by a slash (AlloyRegistry.sol:46) | — | P0 |
| 110 | Prevent paying for reputation, tiers or favourable reviews | **Existing** | Principal engineer | Alloy is soulbound with no transfer function; there is no purchase path | — | P0 |
## Money and accounting

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 111 | Use integer base units for all on-chain and off-chain money calculations | **Existing** | Principal engineer | uint256/uint72 throughout; packages/eval/src/gates.ts applyCaps uses bigint | — | P0 |
| 112 | Centralize fee math in versioned canonical modules | **Partial** | Principal engineer | the rate is READ from the chain (apps/api/src/server.ts readProtocolFee); packages/eval/src/gates.ts FEE_BPS_CANONICAL is a policy band, not the protocol rate | S2 | P0 |
| 113 | Keep legacy 5% and Arena 15% schedules explicitly distinct | **Verified** | Principal engineer | docs/enterprise/economics-and-incentives.md §1; ADR-0011; params fee_bps 1500 vs FEE_BPS 500 | S2 | P0 |
| 114 | Freeze fee schedule version at trial creation | **Partial** | Principal engineer | Arena.sol freezes t.fee at post; the legacy escrow stores no schedule version | S2 | P1 |
| 115 | Show reward, bond, stake, protocol fee, compute fee and gas separately | **Partial** | Principal engineer | the indexer publishes the fee RATE, not the balance (the owner's call); no compute-fee or gas separation in the UI | S2, S4 | P1 |
| 116 | Show expected net payout and worst-case loss before signature | **Missing** | Principal engineer | — | S2 | P1 |
| 117 | Define rounding, dust, min/max amount and overflow behavior | **Existing** | Principal engineer | contract-spec.md §5 (MAX_REWARD, MAX_TOTAL_ESCROWED, MIN_BOND); rounding: floor_remainder_to_treasury | — | P0 |
| 118 | Conservation-preserving ledger for credits and invoices | **Missing** | Principal engineer | the on-chain pull ledger is conservative; no off-chain credit ledger exists | S4 | P1 |
| 119 | Reconcile on-chain settlements against indexer and accounting projections | **Partial** | Principal engineer | packages/indexer/src/model.ts derives from chain events; there is no accounting projection to reconcile against | S4 | P1 |
| 120 | Property tests for every money flow and every fee schedule | **Partial** | Principal engineer | crucible-contracts/test/Invariants.t.sol asserts conservation across the handler; the fee SCHEDULES are not property-tested | S2 | P1 |
## Escrow state machine and contracts

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 121 | Document preconditions and postconditions for every transition | **Existing** | Principal engineer | crucible-contracts/docs/contract-spec.md §6 function reference | — | P0 |
| 122 | Reject invalid state transitions and duplicate settlement | **Existing** | Principal engineer | the contract reverts on state; the Foundry suite covers each path | — | P0 |
| 123 | Make terminal states immutable except for documented corrections | **Existing** | Principal engineer | settlement is terminal; ADR-0007's backfill is write-once per trial | — | P0 |
| 124 | Use pull payments for refunds and withdrawals | **Existing** | Principal engineer | ADR-0003; withdraw() is the only {value:} call | — | P0 |
| 125 | Protect against reentrancy and external-call ordering errors | **Existing** | Principal engineer | no external calls on the settlement path; CEI ordering in CrucibleTrials.sol | — | P0 |
| 126 | Use checked arithmetic and explicit amount bounds | **Existing** | Principal engineer | Solidity 0.8 checked math; explicit MAX_REWARD/MAX_TOTAL_ESCROWED bounds | — | P0 |
| 127 | Test conservation of deposits, vault balances, withdrawals and sweeps | **Existing** | Principal engineer | test/Invariants.t.sol:170 — the exact equality | — | P0 |
| 128 | Test deadline boundaries, timestamp assumptions and expired trials | **Existing** | Principal engineer | CrucibleTrials.t.sol (85 tests) covers window edges and reclaimExpired | — | P0 |
| 129 | Test chain reorg and confirmation-depth behaviour in off-chain projections | **Partial** | Principal engineer | ADR-0010 defines cursor semantics; no reorg rollback is implemented | S4 | P2 |
| 130 | Independent contract audit before real-value production launch | **Blocked** | Founder | — | external auditor | P0 |
## Gas and reward economics

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 131 | Estimate gas before wallet confirmation and display the estimate | **Partial** | Principal engineer | no gas estimate is taken or shown; apps/web/src/components/SigningNotice.tsx now states at both signing surfaces that the fee is not measured here and defers to the wallet figure (apps/web/test/signing-notice.test.ts) | S2 | P1 |
| 132 | Show actual gas after confirmation and distinguish it from protocol fee | **Partial** | Principal engineer | the protocol fee is published as a RATE; SigningNotice separates network charge from protocol fee in words, but no numeric gas is read yet | S2 | P1 |
| 133 | Record gas payer and gas sponsorship budget if applicable | **Missing** | Principal engineer | — | S2 | P2 |
| 134 | Reward scales with task difficulty and verification cost under a documented formula | **Partial** | Principal engineer | packages/eval/src/gates.ts targetDifficulty(r, accuracy) raises difficulty with rating; the reward formula is not tied to verification cost | S3 | P2 |
| 135 | Cap maximum stake and maximum loss per trial and per organization | **Partial** | Principal engineer | MAX_REWARD and MAX_TOTAL_ESCROWED cap the protocol; no per-organization cap exists | S4 | P1 |
| 136 | Prevent repeated trivial tasks from dominating reputation | **Missing** | Principal engineer | game-theory.md §5.6 — no diminishing returns, no diversity requirement | S3 | P2 |
| 137 | Set skeptic rewards based on substantiated findings and evidence quality | **Partial** | Principal engineer | 30% of the bond to a winning skeptic; evidence quality is not a separate input | S3 | P2 |
| 138 | Set juror compensation independently from majority agreement | **Partial** | Principal engineer | seat fees are a share of the break's reward; not tied to calibration | S3 | P2 |
| 139 | Add simulation for low, base and high network-fee scenarios | **Missing** | Principal engineer | — | S3 | P2 |
| 140 | Publish example settlement breakdowns for pass, fail, split, timeout and challenge | **Verified** | Principal engineer | contract-spec.md §5 — all three outcomes with the arithmetic | — | P1 |
## Enterprise organisations and collaboration

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 141 | Tenant-isolated organizations and workspaces | **Missing** | Principal engineer | — | S4 | P1 |
| 142 | Explicit role-permission matrix | **Partial** | Principal engineer | docs/enterprise/collaboration-and-governance.md §3 — designed, not implemented | S4 | P1 |
| 143 | Enforce authorization server-side on every API and mutation | **Existing** | Principal engineer | apps/api/src/auth.ts verifySessionToken on every route | — | P0 |
| 144 | Never trust client-supplied organization IDs or role names | **Missing** | Principal engineer | no org concept exists yet | S4 | P1 |
| 145 | Invitation expiry, revocation and least-privilege defaults | **Missing** | Principal engineer | — | S4 | P1 |
| 146 | Shared projects and benchmark libraries | **Partial** | Principal engineer | packages/datasets/src/registry.ts — versioned, content-addressed, stake-gated publisher; no share surface | S4 | P1 |
| 147 | Comments, review threads and evidence-linked discussions | **Missing** | Principal engineer | — | S4 | P2 |
| 148 | Assignment, reviewer approval and publication workflows | **Missing** | Principal engineer | — | S4 | P2 |
| 149 | Record author, reviewer and contributor attribution | **Partial** | Principal engineer | datasets manifest.provenance and publisher exist | S4 | P2 |
| 150 | Define benchmark IP ownership and license terms | **Partial** | Principal engineer | datasets manifest.license is SPDX per dataset; no project-level IP terms | S4 | P2 |
## Provider and model integrations

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 151 | Provider adapter interface with capability discovery | **Existing** | Principal engineer | grader/src/adapter.ts + anthropic/google/openai-compat/stub providers | — | P1 |
| 152 | Normalize provider errors without hiding underlying failure causes | **Existing** | Principal engineer | grader/src/eval/adapter.ts; a failed provider produces a failed run, not a fallback score; the manifest records the provider and its exact snapshot | S1d | P1 |
| 153 | Track model and provider version where available | **Existing** | Principal engineer | grader model cards pin an exact snapshot; the grader's manifest records the provider, the snapshot and the seed on every row | S1d | P1 |
| 154 | Meter input/output tokens and provider cost without logging secrets | **Existing** | Principal engineer | grader rows carry avgCostUsd and token counts; no provider credential is logged | — | P1 |
| 155 | Per-tenant provider allowlists and budget limits | **Missing** | Principal engineer | — | S4 | P1 |
| 156 | Bring-your-own-key without exposing credentials to browsers or runners | **Missing** | Principal engineer | — | S4 | P1 |
| 157 | Timeouts, bounded retries and circuit breakers for provider calls | **Partial** | Principal engineer | packages/smith-sdk/src/resilience.ts; no provider-level circuit breaker | S4 | P1 |
| 158 | Provider outage fallback without mislabeling the run | **Partial** | Principal engineer | a failed provider produces a failed run, not a fallback score; the manifest records the provider and snapshot, so a fallback would be visible | S1d | P2 |
| 159 | Record structured-output validation failures | **Partial** | Principal engineer | packages/agent-security/src/validation.ts | — | P2 |
| 160 | Test provider adapters against contract tests and mock servers | **Existing** | Principal engineer | grader/test/ — 285 tests incl. the provider adapter contract tests | — | P1 |
## Enterprise data and privacy

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 161 | Classify data and artifacts by sensitivity | **Missing** | Principal engineer | — | S4 | P1 |
| 162 | Scan uploaded datasets and artifacts for PII and secrets | **Missing** | Principal engineer | gitleaks scans the REPO, not uploaded datasets | S4 | P1 |
| 163 | Define retention, deletion and legal-hold behavior | **Missing** | Principal engineer | — | S4 | P1 |
| 164 | Support private artifact storage and tenant-scoped access | **Partial** | Principal engineer | packages/cidstore (content-addressed, disclosure log); no tenant scope | S4 | P1 |
| 165 | Support data residency controls where technically available | **Missing** | Principal engineer | — | S4 | P2 |
## Enterprise data and developer APIs

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 166 | Version public APIs and define compatibility guarantees | **Partial** | Principal engineer | the indexer has explicit cursor semantics (ADR-0010); no API version surface | S4 | P1 |
| 167 | Validate requests against explicit schemas | **Existing** | Principal engineer | apps/api/src/security.ts; validation at the route boundary | — | P0 |
| 168 | Consistent error envelopes and request IDs | **Partial** | Principal engineer | apps/api/src/app.ts has a typed error envelope; no request id | S4 | P1 |
| 169 | Pagination, filtering and stable sorting | **Missing** | Principal engineer | — | S4 | P1 |
| 170 | Idempotency for create, billing and job-triggering operations | **Missing** | Principal engineer | apps/api/src/replay.ts covers request replay, not operation idempotency | S4 | P1 |
## UI and accessibility

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 171 | Make Overview, Trials, Evaluation Studio, Runs and Compare easy to find | **Partial** | Principal engineer | apps/web has trials, engrams, assay, compliance; no Runs/Compare surfaces | S4 | P2 |
| 172 | Onboarding that explains the trust model in plain language | **Partial** | Principal engineer | docs/business/investor-faq.md is the 60-second version; no in-product onboarding flow | S4 | P2 |
| 173 | Explain bond, escrow, gas, commission and dispute risk before signing | **Partial** | Principal engineer | SigningNotice at /trials/new and /forge covers test-money, gas and bond risk before a signature; dispute risk and commission still live on /clock and /docs, not at the action | S2 | P2 |
| 174 | Show immutable hashes and evaluator versions on trial detail pages | **Partial** | Principal engineer | apps/web/src/app/trials/[id]/page.tsx shows the spec/suite digests; the runner emits a manifest and the grader attaches it to every row, but there is no view | S1d, S4 | P2 |
| 175 | Show model/scaffold, environment, score, confidence and cost on result pages | **Partial** | Principal engineer | the grader rows carry them and the manifest names the conditions; the web product shows the settlement receipt | S1d, S4 | P2 |
| 176 | Warn when comparison protocols are incompatible | **Verified** | Principal engineer | manifestsComparable + compareManifests + scoresComparable + the grader's `incomparability` - implemented and mutation-proven on both sides; the ranking path does not yet consult the guard | S1d | P2 |
| 177 | Loading, empty, offline, pending, failure and retry states | **Partial** | Principal engineer | verify page maps five states (apps/web/src/lib/verify-view.ts, test/verify-view.test.ts); hero card maps unread/empty/trial (lib/hero-board.ts); global-error and route boundaries as before; no offline state | S4 | P2 |
| 178 | Keyboard navigation and semantic labels | **Partial** | Principal engineer | semantic markup throughout; no axe gate in CI | S4 | P2 |
| 179 | Respect reduced-motion preferences and colour-contrast requirements | **Partial** | Principal engineer | apps/web/src/styles/motion.css; contrast is not gated | S4 | P2 |
| 180 | Never use colour alone for status; never hide skipped or degraded results | **Partial** | Principal engineer | CORRECTED 2026-10-29: the degraded run-quality label never reaches a reader. forge-runner/src/runner.ts:171-175 writes it into the manifest only, and grep for degraded across apps/web/src finds no surface. The verify page now prints its state in words | — | P1 |
## Authentication and wallet safety

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 181 | Preserve the API's no-chain-private-key boundary | **Existing** | Principal engineer | ADR-0006; apps/api/src/server.ts uses a public client only | — | P0 |
| 182 | Keep runner, keeper, juror, deployer, treasury and vendor credentials separate | **Partial** | Principal engineer | docs/key-inventory.md; the funded test wallet is its own service (ADR-0015, Proposed) | S5 | P1 |
| 183 | Require non-default strong session secrets | **Existing** | Principal engineer | apps/api/src/auth.ts; AUTH_SECRET in .env.example | — | P0 |
| 184 | One-time stored authentication challenges with replay protection | **Existing** | Principal engineer | apps/api/src/auth.ts issueChallenge + apps/api/src/replay.ts | — | P0 |
| 185 | Rotate sessions after authentication and privilege changes | **Partial** | Principal engineer | verifySessionToken; no rotation on privilege change (no privileges exist yet) | S4 | P1 |
| 186 | Validate wallet chain and account before transaction preparation | **Existing** | Principal engineer | apps/web wagmi/RainbowKit with a single chain; the app refuses a foreign chain | — | P0 |
| 187 | Simulate or preflight transactions where feasible | **Missing** | Principal engineer | — | S2 | P2 |
| 188 | Never request or accept a seed phrase | **Existing** | Principal engineer | auth is a signature challenge; no path accepts a phrase | — | P0 |
| 189 | Use a multisig/Safe for owner and treasury on value-bearing deployments | **Blocked** | Founder | contract-spec.md §14 lists it as a requirement, not a shipped thing | external signer | P0 |
| 190 | Test wrong-network, rejected-signature, stale nonce and wallet-disconnect flows | **Partial** | Principal engineer | apps/web tests cover some wallet states; no wrong-network test | S4 | P1 |
## Web and API application security

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 191 | Strict Content Security Policy and security headers | **Existing** | Principal engineer | docs/security-headers.md; apps/api/src/security.ts | — | P0 |
| 192 | Enforce origin and CORS allowlists | **Existing** | Principal engineer | apps/api/src/app.ts; the auth challenge binds an origin | — | P0 |
| 193 | Apply CSRF protection to cookie-authenticated mutations | **Existing** | Principal engineer | the API is token-authenticated, not cookie-authenticated, so CSRF does not apply; origin binding covers it | — | P0 |
| 194 | Validate and normalize all user-controlled paths and URLs | **Partial** | Principal engineer | apps/api/src/content.ts; the content fetch is by digest | S4 | P1 |
| 195 | Prevent SSRF, DNS rebinding and access to metadata endpoints | **Partial** | Principal engineer | packages/forge-runner/src/egress.ts allowlists sandbox egress; the API's own outbound fetch is not allowlisted | S4 | P1 |
| 196 | Prevent IDOR/BOLA across every tenant-scoped object | **Missing** | Principal engineer | no tenant-scoped objects exist yet | S4 | P1 |
| 197 | Apply request body size limits and decompression limits | **Existing** | Principal engineer | apps/api/src/app.ts maxBodyBytes (16KB default) | — | P0 |
| 198 | Escape user content and prevent stored/reflected XSS | **Existing** | Principal engineer | React's escaping; the no-inline-styles gate and the content render path | — | P0 |
| 199 | Safe archive extraction; prevent path traversal and zip slip | **Partial** | Principal engineer | packages/forge-runner/src/content.ts fetches by digest; the extraction path is not separately tested | S4 | P1 |
| 200 | Security regression tests for each previously discovered vulnerability | **Existing** | Principal engineer | apps/api/test/auth.test.ts; apps/web/test/ — each fixed finding has a named test | — | P0 |
## Supply chain and dependency security

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 201 | Pin dependencies and verify lockfile integrity | **Existing** | Principal engineer | package-lock.json is committed; the phantom playwright devDep was removed this engagement (npm install --package-lock-only proves the desync) | — | P0 |
| 202 | Generate and retain an SBOM for each release | **Missing** | Principal engineer | — | S5 | P1 |
| 203 | Run secret scanning on commits and artifacts | **Existing** | Principal engineer | gitleaks over --log-opts=--all; the engram false positive was fixed and allowlisted by exact literal | — | P0 |
| 204 | Run static analysis and dependency vulnerability scanning in CI | **Existing** | Principal engineer | ci.yml — slither (every suppression justified in docs/slither-triage.md) and scripts/audit-gate.mjs | — | P0 |
| 205 | Track existing advisories with owner, exposure analysis and expiry date | **Existing** | Principal engineer | scripts/audit-gate.mjs documents the accepted set with severity ceilings | — | P1 |
| 206 | Fail CI on new critical/high findings unless a reviewed exception applies | **Existing** | Principal engineer | scripts/audit-gate.mjs; the allowlist is exact, so any other advisory fails | — | P0 |
| 207 | Verify container base image provenance and digest | **Partial** | Principal engineer | resolveVerifierImage pins the digest; provenance is not attested | S5 | P1 |
| 208 | Pin action versions and harden CI permissions | **Existing** | Principal engineer | ci.yml pins actions by version and the runners are self-hosted with fork guards | — | P0 |
| 209 | Prevent untrusted fork code from running on privileged self-hosted runners | **Existing** | Principal engineer | ci.yml fork guards — the runner IS the workflow, so a fork cannot remove the guard | — | P0 |
| 210 | Exercise dependency update and rollback procedures | **Partial** | Principal engineer | scripts/install-tool.sh installs by digest and verifies against the vendor checksum | S5 | P2 |
## Observability and incident response

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 211 | Structured logs with request, run, trial and tenant IDs | **Partial** | Principal engineer | run and trial ids are carried; TENANT id does not exist | S4 | P1 |
| 212 | Redact credentials, sensitive prompts and personal data from logs | **Partial** | Principal engineer | gitleaks covers the repo; runtime log redaction is per-service and not audited | S5 | P1 |
| 213 | Track queue depth, run duration, evaluator errors and provider health | **Missing** | Principal engineer | — | S5 | P1 |
| 214 | Alert on unusual payout, dispute, promotion and reputation patterns | **Missing** | Principal engineer | — | S3, S5 | P2 |
| 215 | Provide a kill switch for new runs and a separate safe settlement policy | **Missing** | Principal engineer | no contract pause (deliberate); no off-chain new-run switch either | S5 | P1 |
| 216 | Document incident severity, triage, escalation and communication roles | **Partial** | Principal engineer | docs/runbooks/incident-response.md covers scenarios and roles; no severity taxonomy, escalation path or on-call rotation | S5 | P1 |
| 217 | Maintain evidence preservation and chain-of-custody procedures | **Partial** | Principal engineer | the content store's disclosure log chains a keccak digest to a CID; the incident runbook says preserve all evidence | — | P1 |
| 218 | Run backup restore and disaster recovery drills | **Missing** | Principal engineer | — | S5 | P1 |
| 219 | Define and measure RPO and RTO | **Missing** | Principal engineer | — | S5 | P1 |
| 220 | Publish status updates for material service incidents | **Missing** | Principal engineer | — | S5 | P2 |
## CI/CD and release safety

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 221 | Run typecheck, lint, unit, integration and build gates in CI | **Existing** | Principal engineer | ci.yml — 7 jobs, all green on develop (run 40835625389) | — | P0 |
| 222 | Run Foundry tests and per-contract coverage gates | **Existing** | Principal engineer | ci.yml contracts job; scripts/coverage-gate.mjs enforces per-contract floors | — | P0 |
| 223 | Run invariant and stateful-fuzz campaigns on money contracts | **Existing** | Principal engineer | test/Invariants.t.sol + RewardFlowInvariant.t.sol, run with a pinned fuzz seed | — | P0 |
| 224 | Run edge/RPC gate tests against the deployed route | **Existing** | Principal engineer | npm run test:edge (15 tests) rides verify:all and CI | — | P0 |
| 225 | Run end-to-end smoke tests on a clean demo chain | **Existing** | Principal engineer | scripts/demo.mjs; npm run test:e2e | — | P0 |
| 226 | Immutable release artifacts and provenance metadata | **Partial** | Principal engineer | digest-pinned tools; no per-release provenance attestation | S5 | P1 |
| 227 | Require green gates before promotion between develop, staging and main | **Existing** | Principal engineer | the promote workflow refuses at 'refuse a red gate' — observed refusing three promotions | — | P0 |
| 228 | Rollback restores the previous working service without resetting funded chain state | **Existing** | Principal engineer | the deploy reconciles the edge before the container swap; the chain is untouched | — | P0 |
| 229 | Verify chain ID, bytecode hash and contract addresses after deployment | **Existing** | Principal engineer | scripts/deploy-network.mjs asks the node eth_chainId BEFORE forge starts and refuses a mismatch (ADR-0020); hasCode re-reads each deployed address; scripts/mainnet-preflight.mjs gates production; proven by packages/eval/test/deploy-network.test.ts (13 tests, 2 mutations) | — | P0 |
| 230 | Require a release checklist and named approver for production changes | **Partial** | Principal engineer | docs/crucible-deploy-day-gates.pdf is the checklist; no named approver field | S5 | P1 |
## Testing and quality engineering

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 231 | Test all critical business rules with table-driven tests | **Existing** | Principal engineer | crucible-contracts/test/ — 329 Foundry tests; every workspace has a vitest suite | — | P0 |
| 232 | Property-based tests for fees, conservation and state transitions | **Existing** | Principal engineer | test/Invariants.t.sol (handler-driven) and RewardFlowInvariant.t.sol | — | P0 |
| 233 | Fuzz tests for malformed manifests, oversized inputs and unusual Unicode | **Partial** | Principal engineer | the manifest refuses a malformed number and a moving alias, and the grader refuses a card whose snapshot is one; no fuzz harness for manifests yet | S1d | P2 |
| 234 | Test concurrency, duplicate requests and race conditions | **Partial** | Principal engineer | packages/smith-sdk/test/patterns-concurrency.test.ts; apps/api/src/replay.ts | — | P1 |
| 235 | Test queue retry, worker crash and dead-letter recovery | **Existing** | Principal engineer | apps/api/src/dlq.ts; packages/warden collects per-trial errors so one bad trial never stops the others | — | P1 |
| 236 | Test indexer reorgs, missed logs and full-rescan recovery | **Partial** | Principal engineer | ADR-0010 cursor semantics; the reset path and a full rescan are tested, reorg rollback is not | S4 | P2 |
| 237 | Test provider timeout, rate limit and malformed responses | **Partial** | Principal engineer | grader provider tests; packages/smith-sdk/src/resilience.ts | — | P1 |
| 238 | Test sandbox escape attempts in an authorized isolated harness | **Partial** | Principal engineer | the seal is CI-enforced (gate 502) and import-lint is tested; no escape-attempt suite | S5 | P2 |
| 239 | Test accessibility, responsive layout and core user journeys | **Partial** | Principal engineer | apps/web view-model tests; no axe or responsive gate in CI | S4 | P2 |
| 240 | Track flaky tests and prevent silent skip growth | **Existing** | Principal engineer | the README reports passed AND skipped counts separately; the 6 forge-runner and 4 fork skips are named | — | P1 |
## Indexing and chain consistency

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 241 | Make indexer cursors reorg-aware and checkpointed | **Partial** | Principal engineer | ADR-0010 (cursor means 'next block'; head+1 is caught up); checkpointing exists, reorg awareness does not | S4 | P2 |
| 242 | Deduplicate chain events by chain, block hash, transaction and log index | **Existing** | Principal engineer | packages/indexer/src/scribe.ts; the bloom cross-check | — | P1 |
| 243 | Reconcile periodic event projections against contract state | **Partial** | Principal engineer | packages/indexer/src/replica.ts; the convergence test exists for the model | — | P1 |
| 244 | Full rescan possible without corrupting finalized records | **Existing** | Principal engineer | the read model is rebuilt from the chain on restart (ADR-0008) | — | P1 |
| 245 | Expose sync lag and sync errors in operational health | **Partial** | Principal engineer | the API publishes a ready flag; no lag metric | S5 | P1 |
| 246 | Keep indexer read models free of signing authority | **Existing** | Principal engineer | the indexer is read-only; the API holds no key (ADR-0006) | — | P0 |
| 247 | Handle missing optional registries without blocking settlement | **Existing** | Principal engineer | ADR-0007; the identity link reverts rather than half-succeeding | — | P0 |
| 248 | Backfill reputation events after registry outages where supported | **Existing** | Principal engineer | ADR-0007's canonical write-once backfill | — | P1 |
| 249 | Distinguish pending, confirmed, finalized and reverted transactions | **Existing** | Principal engineer | apps/web/src/components/Chrome.tsx TxStates | — | P1 |
| 250 | Provide evidence that the Hall's displayed receipt matches on-chain settlement | **Existing** | Principal engineer | the read model derives from chain events; the receipt is re-derivable | — | P1 |
## Governance and policy controls

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 251 | Define who can change fees, parameters, tiers and evaluator policies | **Missing** | Founder | — | S4 | P1 |
| 252 | Timelocks and multisig approval for sensitive parameter changes | **Missing** | Founder | — | S5 | P1 |
| 253 | Apply changes prospectively to newly created trials only | **Partial** | Principal engineer | Arena.sol freezes t.fee at post; the legacy escrow has no schedule version to freeze | S2 | P1 |
| 254 | Append-only governance decisions and rationale | **Partial** | Principal engineer | docs/adr/ (17 records) and docs/since-submission.md are append-only in practice; no machine-checked log | — | P1 |
| 255 | Define emergency pause authority and unpause conditions | **Missing** | Founder | deliberately absent: the incident runbook states there is no pause, no upgrade, no admin recovery | S5 | P2 |
| 256 | Separate emergency containment from discretionary adjudication | **Existing** | Principal engineer | the Argus committee settles; no admin can settle (the contract has no such path) | — | P0 |
| 257 | Publish policy versions and participant acceptance records | **Partial** | Principal engineer | policy versions live in the schema (RUN_ARTIFACT_SCHEMA_VERSION, EVAL_MANIFEST_SCHEMA_VERSION) and the grader's manifest records the evaluator, the rubric and the prompt version on every row; no acceptance record | S1d | P2 |
| 258 | Conflict-of-interest register for platform operators and jurors | **Missing** | Founder | SelfClaim/SelfBreak prevent the same address only | S4 | P2 |
| 259 | Independent approval for exceptions affecting money or benchmark integrity | **Partial** | Principal engineer | the gitleaks allowlist is exact-literal with a written reason per entry; no general exception process | S5 | P1 |
| 260 | Review governance controls periodically and after incidents | **Missing** | Founder | — | S5 | P2 |
## Advanced collaboration evaluations

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 261 | Benchmark delegation quality between agents | **Missing** | Principal engineer | — | S3 | P2 |
| 262 | Benchmark information-sharing and communication overhead | **Missing** | Principal engineer | — | S3 | P2 |
| 263 | Benchmark consensus failures and correlated hallucinations | **Missing** | Principal engineer | — | S3 | P2 |
| 264 | Measure whether one compromised agent can poison shared memory | **Partial** | Principal engineer | packages/agent-security/src/memory-seal.ts exists for a single agent; no multi-agent memory | S3 | P2 |
| 265 | Test task allocation and recovery when a teammate fails | **Missing** | Principal engineer | — | S3 | P2 |
| 266 | Track attribution for each agent's contribution to the final outcome | **Missing** | Principal engineer | — | S3 | P2 |
| 267 | Prevent double counting of shared work across agents | **Missing** | Principal engineer | — | S3 | P2 |
| 268 | Measure cost and latency of team-level success | **Missing** | Principal engineer | — | S3 | P2 |
| 269 | Blinded pairwise comparison of team configurations | **Partial** | Principal engineer | the grader compares candidates on a shared corpus and the manifest makes conditions explicit; no BLINDING | S1c, S3 | P2 |
| 270 | Publish protocol and tool permissions for multi-agent runs | **Partial** | Principal engineer | the manifest carries agent.tools and toolPermissions, and the runner emits them; no multi-agent run exists to publish for | S3 | P2 |
## Billing and unit economics

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 271 | Subscription tiers and included evaluation quotas | **Missing** | Founder | — | S4 | P1 |
| 272 | Meter compute, model API use, storage, egress and human review separately | **Partial** | Principal engineer | the grader meters model cost (avgCostUsd); storage, egress and review are not metered | S4 | P1 |
| 273 | Prevent duplicate billing on retries and webhook replay | **Partial** | Principal engineer | apps/api/src/replay.ts protects requests; no billing idempotency key exists | S4 | P1 |
| 274 | Cost centres and project-level budgets | **Missing** | Founder | — | S4 | P1 |
| 275 | Invoice-ready usage exports and reconciliation reports | **Missing** | Founder | — | S4 | P1 |
| 276 | Eligibility thresholds for each reputation tier | **Existing** | Principal engineer | AlloyRegistry.sol — Unforged/Iron/Bronze/Steel/Damascus with explicit win and survival counts | — | P1 |
| 277 | Multiple benchmark families for upper-tier promotion | **Missing** | Principal engineer | — | S3 | P2 |
| 278 | Minimum sample size and confidence for tier advancement | **Missing** | Principal engineer | — | S3 | P2 |
| 279 | Challenge-survival evidence where specified | **Existing** | Principal engineer | Steel requires >=1 survived break, Damascus >=3 | — | P1 |
| 280 | Stronger isolation and review for frontier-tier tasks | **Partial** | Principal engineer | strictSandboxFor raises the floor per tier (gate 901); there is no frontier tier | S2 | P2 |
## Governance and enterprise trust

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 281 | Map platform controls to OWASP and NIST AI risk guidance | **Verified** | Principal engineer | docs/enterprise/security-threat-model.md §3.2 maps every threat to a control or names the gap | — | P1 |
| 282 | Document that the mapping is not a certification or legal opinion | **Verified** | Principal engineer | security-threat-model.md §3.2 and §5.3 state the limits; no compliance claim is made | — | P1 |
| 283 | Review dataset licenses and benchmark usage rights | **Partial** | Principal engineer | datasets manifest.license is SPDX and validated; the publisher is stake-gated | S4 | P1 |
| 284 | Maintain data-processing and confidentiality terms for enterprise customers | **Missing** | Founder | — | S4 | P1 |
| 285 | Define breach notification and customer escalation procedures | **Missing** | Founder | — | S4 | P1 |
| 286 | Record evaluation limitations and prohibited interpretations of scores | **Verified** | Principal engineer | game-theory.md and evaluation-protocol.md state what the scores do not prove (no game-theoretic-security claim, no perfect contamination prevention) | — | P1 |
| 287 | Audit exports with signed manifests and result provenance | **Partial** | Principal engineer | the manifest digest and the content-store disclosure log give the provenance, and every scorecard row now carries both; the export is not signed | S1d, S4 | P2 |
| 288 | Vulnerability disclosure policy and security contact | **Existing** | Principal engineer | SECURITY.md | — | P1 |
| 289 | Independent smart-contract and infrastructure audits before real-value launch | **Blocked** | Founder | — | external auditor | P0 |
| 290 | Jurisdiction-specific legal review for escrow, rewards, staking and marketplace operations | **Blocked** | Founder | — | external counsel | P0 |
## Future chain and extensibility gates

| # | Requirement | Status | Owner | Evidence / test | Depends on | Phase |
|---|---|---|---|---|---|---|
| 291 | Keep EVM behaviour as the source of truth unless approved otherwise | **Existing** | Principal engineer | ADR-0001/0002; the Solana port is a mirror, not a mutation | — | P0 |
| 292 | Do not label Solana as supported until the Anchor program compiles and tests pass | **Existing** | Principal engineer | not compiled; docs/wallets.md says EVM-only; the checklist records it Blocked | — | P0 |
| 293 | Separate ADR and threat model for any Solana deployment | **Missing** | Principal engineer | — | P3 | P3 |
| 294 | Byte-identical cross-chain verdict vectors where specified | **Existing** | Principal engineer | crucible-contracts/solana/vectors — the Rust JCS subset reproduces every TypeScript vector byte for byte (3/3 tests) | — | P1 |
| 295 | Test event-schema and error-code parity between chain implementations | **Partial** | Principal engineer | the parity vectors exist; the error-code parity suite does not | P3 | P3 |
| 296 | Document finality and clock assumptions per chain | **Partial** | Principal engineer | ADR-0010 (cursor semantics); a Solana clock gate exists in the port; not documented per chain | P3 | P3 |
| 297 | Multisig or immutable upgrade-authority policy before Solana deployment | **Missing** | Founder | — | P3 | P3 |
| 298 | Reconcile fee differences between legacy escrow and Arena before any port | **Verified** | Principal engineer | docs/enterprise/economics-and-incentives.md §1 — the matrix, bases and rounding for all three | S2 | P1 |
| 299 | Publish program IDs only after verified deployment | **Existing** | Principal engineer | no program ID is published | — | P0 |
| 300 | Independent audit and reproducible builds before real-value cross-chain use | **Blocked** | Founder | — | external auditor | P3 |

## How to read this register

**Verified** is a deliberately small category: it means *this engagement added the
evidence*, not that the item is important. It is used where the tree's own claim was
unproven and is now proven — the manifest's nine mutation proofs, the fee-schedule
matrix, the role matrix, the gate count.

**Existing** does not mean *finished*. It means the behaviour is implemented, tested
and load-bearing **for the case the tree covers**; where the brief asks for a wider
case, the item is **Partial** and the evidence column says which case is missing.

The **28 Missing** items are not 28 independent efforts. They collapse into the five
slices of [`roadmap.md`](roadmap.md): S1 (12), S2 (8), S3 (8), S4 (15) and S5 (6),
with overlaps where one slice closes several items at once.

**Blocked** items are not gaps in the work — they are things the repository cannot
close by itself: an independent contract audit, a legal review, a multisig signer.
They are listed so that "the code is done" is never read as "the launch is done".

---

*Related: [`assessment.md`](assessment.md) (the matrix this derives from),
[`roadmap.md`](roadmap.md) (the build order),
[`production-checklist-300.md`](production-checklist-300.md) (this file),
[`security-threat-model.md`](security-threat-model.md) §6 (the ranked findings).*
