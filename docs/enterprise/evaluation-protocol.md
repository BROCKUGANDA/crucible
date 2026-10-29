# Evaluation protocol

**Date:** 2026-10-29 · **Baseline:** `develop` @ `9deb3f2`

This document specifies how a Crucible evaluation is described, compared and
reported, so that two people reading two scores can tell whether they are
looking at the same experiment. It describes the protocol as it exists, and
separates what is enforced in code from what is specified here.

Version: **protocol v1** (schema `EVAL_MANIFEST_SCHEMA_VERSION = "1.0.0"`,
ADR-0017).

---

## 1. The problem this protocol solves

A score is not a measurement of a model. It is a measurement of a model
*under conditions*, and most of those conditions change faster than the model
does. "Qwen3.6-35B-A3B scored 0.90" is not a fact about Qwen3.6-35B-A3B. It
is a fact about a run of Qwen3.6-35B-A3B against one corpus, under one
rubric, in one harness, at one temperature, priced under one fee schedule,
scored by one evaluator version.

The protocol's job is to make that sentence recoverable. Every evaluation
produces a **manifest** — a content-addressed description of the conditions —
and the manifest's digest is what a result points at.

## 2. The manifest

Implemented: `packages/smith-sdk/src/manifest.ts`. Decided in
[ADR-0017](../adr/0017-evaluation-manifest.md).

### 2.1 Required fields

| Field | Type | Why it is required |
|---|---|---|
| `taskDigest` | `bytes32` | what was asked |
| `suiteDigest` | `bytes32` | what decided the outcome |
| `evaluator` | `{id, version, rubricVersion?, digest?}` | who judged, and under which rubric |
| `model` | `{provider, name, version}` | which model, exactly |
| `environment` | `{imageDigest, networkPolicy?, timeoutMs?, limits?}` | where it ran |
| `seed` | string | every stochastic component's seed |
| `scoring` | `{feeSchedule, feeScheduleVersion, decision, rulesVersion?}` | what decided, and what it was worth |
| `startedAt`, `finishedAt` | ISO-8601 | when |

### 2.2 Optional fields

`datasetDigest` (a task may use no dataset), `agent` (a model-only run has no
scaffold), `sampling` (a deterministic suite needs none), `evaluator.rubricVersion`
(a deterministic suite applies no rubric), `evaluator.digest`.

**The optional set is small on purpose.** Every optional field is one whose
absence is *itself* meaningful: "the tool set was not pinned" and "the tool
set was pinned to nothing" are different evaluations, and the comparator
distinguishes them.

### 2.3 Three rules the builder enforces

1. **No moving aliases.** `model.version` may not end in `latest`, `live`,
   `default`, `preview` or `stable`. This is the same rule the grader applies
   to model cards at gate 504; an alias would let a published evaluation become
   uncomparable the next time the alias moves.
2. **Canonical numbers.** A sampling value is carried as text and must be its
   shortest round-trip form. JCS renders `0.5` and `0.50` identically, so a
   manifest that accepted `0.50` would produce a digest indistinguishable from
   `0.5`.
3. **Sorted sets.** `agent.tools` must be sorted, so two equal tool sets hash
   alike.

### 2.4 The digest

`keccak256` over RFC 8785 canonical JSON — the same discipline as
`computeRunHash`, for the same reason: every party must land on
byte-identical input. All manifest strings are ASCII, which keeps JCS
implementations from diverging on Unicode normalisation.

## 3. Comparison rules

`compareManifests(left, right)` returns the fields that moved, by dotted path.
`manifestsComparable(left, right)` is the boolean gate.

**Comparable** when every one of these agrees: task, dataset, suite,
evaluator (including rubric version), model, agent, environment, seed,
sampling, scoring.

**Not comparable** across any difference in those. Concretely, and these are
the cases that matter:

| Difference | Verdict | Why |
|---|---|---|
| rubric version moved | **incomparable** | the score means something different |
| fee schedule moved | **incomparable** | two schedules are two different games |
| model version moved | incomparable | a different model |
| scaffold moved | incomparable | a different harness |
| temperature moved | incomparable | a different experiment |
| environment image moved | incomparable | a different machine |
| tool set changed | incomparable | different permissions |
| **timestamps only** | **comparable** | a repeat measurement of the same evaluation |

**Two runs of the same manifest are a repeat measurement.** A comparison that
refused them would refuse every variance estimate, every test–retest
agreement figure and every confidence interval the brief asks for.

## 4. Scoring

### 4.1 Deterministic first

The principle is existing and load-bearing (ADR-0005, `contract-spec.md`):
**the deterministic suite re-run outranks the LLM rubric.** The rubric is a
bounded fallback for the case where the suite cannot decide, and
`scoring.decision` records which path produced the outcome:
`deterministic-suite`, `rubric`, or `both`.

### 4.2 The gates a candidate must clear

The grader (`grader/src/scorer.ts`, `frontier.ts`) gates on:

- **false-pass rate** — a candidate that passes tests it should fail is the
  dangerous failure, and it is gated harder than the pass rate itself.
- **p95 latency** — a correct answer too late to use is a failure.
- **test–retest agreement** — a score that does not reproduce is not a score.

And the disqualification **names every gate that fired**. The panel row for
Qwen3.6-35B-A3B in `grader/results/abstention-panel-2026-10-27.jsonl` is the
worked example: 0.90 accuracy, **disqualified** for
`false-pass rate 2.50% > 1.00%; p95 latency 20850ms > 20000ms`. A model that
failed the gate is in the record, marked failed. That is the discipline the
whole protocol rests on.

### 4.3 Statistical reporting the grader already does

From `grader/src/eval/abstention.ts`: 95% **Wilson intervals** on rates,
false-abstention rate, the share of unanswerable probes guessed at confidence
≥ 0.8, a **Brier score**, and the failing trajectories joined to their
claim/evidence payloads.

**Not yet done**, and named as gaps in
[`assessment.md`](assessment.md) §2.1: **paired-difference estimation** (for
candidates sharing task instances), **bootstrap** confidence intervals, and
**inter-rater agreement** between judges beyond the single `kappa` field on a
row. These need the manifest first — a paired comparison across different
manifests is not a paired comparison.

## 5. Contamination controls

| Control | Status | Where |
|---|---|---|
| Deterministic train/dev/holdout splits | **Existing** | `packages/eval/src/splits.ts` (`splitBank`, `splitBankJsonl`, `verifyPartition`); `packages/datasets/src/splits.ts` |
| Holdout content linting | **Existing** | `packages/eval/src/gates.ts` — `lintRagDocs` with `HoldoutFingerprint` matches prompt content against holdout ids |
| Dataset versioning and digest identity | **Existing** | `packages/datasets/src/registry.ts` — `datasetId = sha256(JCS(manifest))`, `verifyDatasetId`, `verifyManifestIntegrity` |
| Grader cannot be edited by the agent | **Existing** | `touchesTests` — a patch touching the suite aborts the run, and fails closed |
| Private holdouts for high-stakes leaderboards | **Partial** | splits exist; no *private, unpublished* holdout set is managed |
| Canary markers in benchmark assets | **Missing** | — |
| Near-duplicate / semantic similarity checks on submitted tasks | **Missing** | `packages/datasets/src/linter.ts` is a **leakage** checker (`checkLeakage`, `pipelineWithLeakageCheck`) — it finds train/dev/holdout contamination, which is a different failure from two submitted tasks being near-duplicates of each other | The near-duplicate detector does not exist. |
| Exposure / contamination disclosure | **Missing** | — |
| Benchmark rotation policy | **Missing** | — |
| Retirement, incident disclosure and replacement procedure | **Missing** | — |

**No claim of perfect prevention.** Split-based leakage control catches a
specific failure — a probe's content matching a holdout's — and nothing more.
An agent that has memorised a benchmark before the split was drawn is not
caught by any of it. That is what the disclosure and rotation controls are
for, and they do not exist yet.

## 6. Task authoring and publication

Existing, from `packages/datasets`: a dataset is a manifest plus
content-addressed shards with `sourceHash`, `license`, `provenance`,
`modality`, a JSON Schema, and a `publisher` address that is **stake-gated**
for admission. `packages/eval/src/gates.ts` adds `lintRagDocs` (holdout
leakage) and `verifyPartition`.

**Missing:** a *task* lifecycle — authoring, validation, dry-run, peer
review, publication, deprecation and migration. The dataset registry is the
closest thing, and it governs *data*, not tasks.

## 7. What the protocol does not yet do

Named plainly, with the slice that closes each:

1. **The runner does not emit a manifest.** The schema exists (ADR-0017) with
   224 tests and nine mutation proofs, and **no code produces one**. Until it
   is wired, a score in this system still cannot be attributed. **This is the
   first thing to build.**
2. **The grader does not consume a manifest.** A candidate's score is not
   yet attached to the conditions that produced it.
3. **The web product does not display one.** There is no manifest view, no
   "these two runs are comparable" indicator, and no comparison guard.
4. **No leaderboard eligibility rules** and no cross-protocol warning.
5. **No contamination disclosure, canary, rotation or retirement.**

## 8. The protocol version

`EVAL_MANIFEST_SCHEMA_VERSION = "1.0.0"` is the schema version. It changes
when the *shape* changes, and a manifest carrying a different schema version
is not comparable to one carrying this one — which `compareManifests`
already reports, because `schemaVersion` is a top-level field that differs.

**Protocol changes are prospective.** A manifest records the protocol version
it was produced under, so a result from an older protocol is never silently
pooled with a newer one.

---

*Related: [`assessment.md`](assessment.md) §2.1,
[`economics-and-incentives.md`](economics-and-incentives.md),
[ADR-0005](../adr/0005-deterministic-evidence-first.md),
[ADR-0017](../adr/0017-evaluation-manifest.md).*
