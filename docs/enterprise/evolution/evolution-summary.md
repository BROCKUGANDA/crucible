# Evolution summary — from the proving ground that exists to the one an enterprise can buy

- **Date:** 2026-10-29
- **Baseline:** `develop` @ `ee4930d` (four slices landed during this pass: `aeb8461`, `ed9cb81`, `9a5c98c`, `447f072`)
- **Evidence owner:** [`DEEP_RESEARCH_Crucible_Enterprise_Readiness.md`](../../../DEEP_RESEARCH_Crucible_Enterprise_Readiness.md) — 98 sources, cited per claim below
- **Build order owner:** [`../roadmap.md`](../roadmap.md) (S1-S5). This file does **not** restate it; it maps new findings onto it.
- **Decision record:** [`../../adr/0019-both-fee-schedules-legible.md`](../../adr/0019-both-fee-schedules-legible.md). No separate `decision-map.md` is written, because ADR-0019 already carries the options, the rejections and the consequences — a second map beside it would be a second source of truth.
- **View source:** [`current-vs-target.dot`](current-vs-target.dot). Node fills are evidence states, not aspirations; every proposed node is `dashed`.

## Why the architecture has to move at all

The product already does the hard, unusual things: settlement pulls rather than pushes, evidence is content-addressed and re-verified against its digest on every read, deterministic checks outrank the model rubric, a grader that crashes is non-voting rather than consenting, and reputation cannot be transferred, sold or minted by anyone but the forge. Those are the properties an enterprise evaluation of an *evaluation platform* is looking for, and they are rarer than any feature on the two briefs' wish lists.

What a security reviewer will not accept is the pattern those strengths sit inside: **the control exists in one layer and is absent at the boundary where money or trust crosses.** The run artifact pins the spec and the suite but names the execution environment with a mutable tag. The sandbox enforces isolation but its degraded path is invisible to the reader deciding a payout. The SIWE session is correctly implemented and consulted by no route. The role model exists as a library and enforces nothing. The committee is real and its size is the parameter the published curves say matters most. One fee law is displayed and the other is a constant in JSON. A register row asserted a label no reader can reach.

That is not a rewrite argument. It is a wiring and attestation argument, and it is why the slices below are ordered by *boundary* rather than by surface.

## Gap map, in slice order

| Slice | Gap between current evidence and target | Validation signal (the thing that must go red) | Reversibility |
|---|---|---|---|
| **S2a** — environment pinning *(new)* | `manifest.ts:114` writes `crucible/verifier:latest` into `imageDigest`; the field's own doc comment forbids tags; `sandbox.ts:313` still claims pinning | resolver unit test against a fake inspector; existing Docker suite's real run; a tag reaching `imageDigest` fails the build | trivially reversible, one module |
| **S2b** — run quality at the decision *(new)* | `runner.ts:171-175` records `degraded`; nothing projects it; an unisolated run renders as a sandboxed one | a degraded run's projection carries the label **sourced from enforcement, not the runner's self-report**; UI test asserts the word | reversible, read-model only |
| **S2** — schedules and consumer API *(existing, now decided)* | one scalar `economics.feeBps` for two laws with different payers, timings and refunds | fee renders ⇒ protocol named; `/arena` printed rate equals `Arena.ARENA_FEE_BPS()/BPS()` read on-chain | additive; keep the scalar as the legacy entry |
| **S3** — adversary simulation | a fixed 3-seat panel sits near the worst point of the published attacker-majority curve; independence is contradicted by the operating court's own survey | model output published *with its assumptions*; COI exclusion as a hard precondition with non-waivable cases, not a scoring penalty | parameter change, prospective-only per ADR-0011 |
| **S4** — organisation and tenancy | no org/tenant/role in the API or the app; `verifySessionToken` called only inside `auth.ts`; owner gate compares a **claimed** address | authorization regression per object and role, CI-gated (ASVS 4.2.1 shape); a wallet that is not the owner cannot read the queue | largest blast radius; nothing ships until the tests ship |
| **S5** — release evidence | no SBOM, no provenance, no image signing; `dependabot` has no `docker` ecosystem while three images float; no measured SLI behind any availability claim | verifier command in CI rather than a claim in a doc; status numbers produced by a query; **no SLA sentence before an SLI exists** | procedural, low risk |
| **S5** — replay | v2 copy promises three agreeing replays; `claims/registry.ts:171` admits "one execution, one hash"; `rerunOnFreshBench` has never run in a container | a re-run produced by a second party reproducing the verdict, or the claim is withdrawn from the copy | copy is reversible; the capability is not cheap |

The two new sub-slices are deliberately carved out of S2 rather than added as a sixth slice: they are the reproducibility half of the same boundary ADR-0017 and ADR-0019 already own, and a manifest field that lies about its environment is the same defect as a fee figure that omits its law — a value presented without the provenance that makes it interpretable.

## Why S2a and S2b go first, before the enterprise features

Sequencing is by dependency, risk, value and validation cost, and here those four point the same way. Replay (S5) is impossible without a pinned environment (S2a), so the expensive promise is gated on the cheap fix. The independent reviewer's question — "was this run actually isolated?" — is unanswered today, and every downstream enterprise control (private datasets, tenant-scoped artifacts, signed audit exports) inherits that ambiguity; so S2b precedes S4 rather than following it. And both are one-module changes with a test each, which is the cheapest available movement on the highest-value boundary.

By contrast S4 is the largest change and the least reversible: introducing tenancy means the authorization tests must arrive with it, because a role model displayed without enforcement is the exact "hiding a button is not security" failure the briefs themselves warn about.

## What remains risky after this plan

- **No pause, no upgrade, no timelock, no multisig.** Every `owner` is `immutable` and the quorum is a `constant`, so changing the committee is a recompile and a fresh deployment. This is a deliberate deletion of privilege (ADR-0011, `CHANGELOG.md`), and it is also the item a buyer's reviewer will call a blocker for real value. It cannot be fixed by the UI or the read model; it is a governance decision about who may stop a protocol, and it needs its own ADR before mainnet, not after.
- **Attestation has a ceiling no slice here raises.** Provenance answers what built an artifact; hardware attestation authenticates a measurement, and enclaves are documented as vulnerable to controlled-channel attacks by the privileged host. "Attested runner" must therefore stay a scoped claim.
- **The register is a mirror of the tree, so it drifts.** Its generator (`compliance-matrix.mjs`) is run by nothing, 51 of 75 v2 gate rows describe nothing that exists, and row 180 proved a status can be set from a plausible sentence. The fix is structural — a `proof` field naming the deciding test, wired into CI — and until then every "Existing" in that file is a claim to re-check, not a fact to rely on.
- **Nothing in this plan makes the market work.** The documented failure of this mechanism class was vote *concentration*, not Sybil; verification cost, not incentive design, is what killed the nearest non-crypto analogue. A panel that is honest, correct and slower than the disputes arriving is still a failed product.
