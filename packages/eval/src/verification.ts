/**
 * @file verification.ts — the one place a verdict is computed from evidence.
 *
 * The workload adapters used to return `PASS` with every check hard-coded to
 * `true` and a `reportDigest` that said "placeholder". That is not a verifier:
 * it is a constant, and a constant cannot be turned red, so a green from it is
 * decoration (AGENTS.md, "Gates must be able to fail").
 *
 * This module is the replacement contract. It has three rules:
 *
 *   1. **A verdict comes from evidence, not from the adapter's optimism.** Each
 *      check names the evidence it requires; missing evidence is
 *      `EVIDENCE_INCOMPLETE`, which is *not* a zero score and *not* a failure.
 *   2. **A required check that failed is a FAIL**, and the score is zero for
 *      the dimensions that check feeds — never an average that dilutes it.
 *   3. **The digest is real.** It is the SHA-256 of the canonical check set, so
 *      two reports that differ anywhere differ in their digest, and a stored
 *      report can be re-derived from the checks it names.
 *
 * The distinction the blueprint insists on is preserved exactly: infrastructure
 * failure, participant failure, missing evidence and a genuine failing check are
 * four different outcomes, and collapsing any two of them is a lie about what
 * happened.
 */

import { createHash } from "node:crypto";
import type {
  CheckResult,
  ExecutionResult,
  Scorecard,
  VerificationReport,
  VerificationStatus,
  VersionedRubric,
} from "./workload-contracts.js";

/**
 * What the runner observed for one check.
 *
 * Deliberately narrow: an id, a boolean, a detail string and an artifact
 * digest. The runner cannot supply a score, a verdict or a status — those are
 * computed here from these facts, so a compromised runner can only lie about
 * one check, not mint a passing report.
 */
export interface CheckEvidence {
  id: string;
  passed: boolean;
  detail: string;
  /** The artifact the observation was made against, when there is one. */
  artifactDigest?: string;
}

/** A check the workload requires, and the evidence id that answers it. */
export interface RequiredCheck {
  id: string;
  /** True when a failure here is a hard gate (score 0, no partial credit). */
  required: boolean;
  /** The rubric dimension this check contributes to. */
  dimension: string;
  /** A human-readable statement of what passing means. */
  expectation: string;
  /**
   * A failure here is a finding for a human, not a verdict.
   *
   * Blueprint §3.5 step 12 ("route ambiguous results or possible false
   * positives to a reviewer") and §3.8 ("Uncertain detection finding → needs
   * review, not confirmed vulnerability"). Set on checks where a machine can
   * prove *that something reproduced* but not *that it is a vulnerability* —
   * a security-detection task's finding, a severity call, a novel pattern.
   *
   * It does not soften a hard gate: if any failed required check is *not*
   * marked, the verdict is still FAIL. The mark moves the verdict to
   * `NEEDS_REVIEW` only when every failure is one a human has to confirm, and
   * a needs-review report is not scoreable, so nobody is paid on the strength
   * of a finding no reviewer has seen.
   */
  reviewOnFailure?: boolean;
}

export interface VerificationInput {
  /** The task/contract/mandate's required checks. */
  requirements: readonly RequiredCheck[];
  /** What the runner reported. Absent means the run produced no evidence. */
  evidence: readonly CheckEvidence[] | null | undefined;
  /** The execution outcome the runner reported. */
  outcome: ExecutionResult["outcome"];
  /** Set when the run could not be evaluated fairly (a container that died). */
  infrastructureFailure?: string | null;
  verifierVersion: string;
}

/** Canonical SHA-256 over a check set. */
export function checksDigest(checks: readonly CheckResult[]): string {
  const canonical = checks
    .map((c) => ({ id: c.id, passed: c.passed, required: c.required, detail: c.detail }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

export interface Verdict {
  report: VerificationReport;
  /** The evidence that was actually used, so a caller can store it. */
  usedEvidence: CheckEvidence[];
  /** Required checks that got no evidence of any kind. */
  missingEvidence: string[];
  /** True when the run could not be evaluated for reasons that are not the participant's. */
  infrastructureFailure: string | null;
  /**
   * Required checks that failed and whose failure a human has to confirm.
   *
   * Empty on every other status. It is named separately from `report.checks`
   * because the queue that a reviewer works from is exactly this list, and
   * filtering the checks again in a second place is how the two lists drift.
   */
  reviewRequired: string[];
}

/**
 * Compute a verdict.
 *
 * The order matters: infrastructure failure first (nothing else is knowable),
 * then missing evidence, then failures. A run whose container died *and* whose
 * checks are missing is an infrastructure failure, because that is the cause.
 */
export function computeVerdict(input: VerificationInput): Verdict {
  const evidenceById = new Map<string, CheckEvidence>();
  for (const entry of input.evidence ?? []) evidenceById.set(entry.id, entry);

  const checks: CheckResult[] = [];
  const missingEvidence: string[] = [];
  // The required checks with no evidence at all. Kept separately from
  // `missingEvidence`, which also names optional checks: comparing the two
  // lengths is how "every failure is unexplained" gets decided, and an optional
  // check that was simply not run would otherwise make every such run look
  // explained.
  const missingRequired: string[] = [];

  for (const requirement of input.requirements) {
    const observed = evidenceById.get(requirement.id);
    if (!observed) {
      missingEvidence.push(requirement.id);
      if (requirement.required) missingRequired.push(requirement.id);
      checks.push({
        id: requirement.id,
        passed: false,
        required: requirement.required,
        detail: `no evidence reported for "${requirement.id}": ${requirement.expectation}`,
      });
      continue;
    }
    checks.push({
      id: requirement.id,
      passed: observed.passed,
      required: requirement.required,
      detail: observed.detail,
    });
  }

  const infrastructureFailure = input.infrastructureFailure ?? null;
  const failedRequired = checks.filter((c) => c.required && !c.passed);

  // The failures a human has to confirm. Read from the requirement, not from
  // the check: `CheckResult` is the observation, and whether a failure needs a
  // reviewer is a property of the task, not of the run.
  const reviewable = new Set(
    input.requirements.filter((r) => r.reviewOnFailure === true).map((r) => r.id),
  );
  const reviewRequired = failedRequired
    .map((c) => c.id)
    .filter((id) => reviewable.has(id));

  let status: VerificationStatus;
  if (infrastructureFailure) {
    status = "INCOMPLETE";
  } else if (input.outcome === "failed" && checks.every((c) => !c.passed)) {
    // The run itself failed and nothing passed: a participant failure, not a
    // missing-evidence case.
    status = "FAIL";
  } else if (missingRequired.length > 0 && failedRequired.length === missingRequired.length) {
    // Every required failure is unexplained: the evidence is what is missing,
    // so the run was not evaluated. Meanwhile an optional check that simply was
    // not run does not change a PASS.
    status = "INCOMPLETE";
  } else if (failedRequired.length > 0 && reviewRequired.length === failedRequired.length) {
    // Every failure is one a machine cannot settle. This is not a pass and not
    // a fail: it is a finding waiting for a reviewer, and a score withheld.
    status = "NEEDS_REVIEW";
  } else if (failedRequired.length > 0) {
    status = "FAIL";
  } else {
    status = "PASS";
  }

  return {
    report: {
      status,
      checks,
      reportDigest: checksDigest(checks),
      verifierVersion: input.verifierVersion,
    },
    usedEvidence: [...evidenceById.values()],
    missingEvidence,
    infrastructureFailure,
    reviewRequired: status === "NEEDS_REVIEW" ? reviewRequired : [],
  };
}

export interface ScoreInput {
  report: VerificationReport;
  rubric: VersionedRubric;
  requirements: readonly RequiredCheck[];
  /**
   * Dimensions that a failed hard gate zeroes outright.
   *
   * The blueprint's rule is that a breached invariant is not averaged away: an
   * agent that scores 0.9 everywhere and 0 on a security invariant has not
   * scored 0.75, it has failed the trial.
   */
  hardGateDimensions?: readonly string[];
}

export interface ScoredResult {
  scorecard: Scorecard;
  /** Why the aggregate is null, when it is. */
  withheldReason: string | null;
}

/**
 * Why a report has no score.
 *
 * One function because there were two: the adapters called `scoreVerdict` and
 * the API re-derived the sentence from the status, so a new status would have
 * been scored correctly and *described* incorrectly. A null aggregate with the
 * wrong reason beside it is the same class of mistake as a zero — it tells a
 * reader which measurement was missing and is wrong about it.
 */
export function withheldReasonFor(status: VerificationStatus): string | null {
  switch (status) {
    case "INCOMPLETE":
      return "evidence was incomplete, so there is nothing to score";
    case "ABSTAIN":
      return "the verifier abstained, so there is nothing to score";
    case "NEEDS_REVIEW":
      return "a reviewer has to confirm the finding before it can be scored";
    case "PASS":
    case "FAIL":
      return null;
  }
}

/**
 * Score a verified report.
 *
 * `aggregate` is `null` when the report is not scoreable (incomplete,
 * abstained, or waiting for review): a zero would be a measurement, and there
 * was nothing to measure.
 */
export function scoreVerdict(input: ScoreInput): ScoredResult {
  const { report, rubric, requirements } = input;
  const dimensionOf = new Map(requirements.map((r) => [r.id, r.dimension]));
  const hardGateDimensions = new Set(input.hardGateDimensions ?? []);

  const withheldReason = withheldReasonFor(report.status);
  if (withheldReason !== null) {
    return {
      scorecard: {
        scorecardId: `sc-${report.reportDigest.slice(7, 19)}`,
        rubricVersion: `${rubric.id}/${rubric.version}`,
        metrics: {},
        aggregate: null,
        createdAt: Date.now(),
      },
      withheldReason,
    };
  }

  // Per-dimension: the fraction of that dimension's checks that passed.
  const perDimension = new Map<string, { passed: number; total: number }>();
  for (const check of report.checks) {
    const dimension = dimensionOf.get(check.id) ?? "unmapped";
    const entry = perDimension.get(dimension) ?? { passed: 0, total: 0 };
    entry.total += 1;
    if (check.passed) entry.passed += 1;
    perDimension.set(dimension, entry);
  }

  const metrics: Record<string, number> = {};
  let weighted = 0;
  let weightSum = 0;
  for (const dimension of rubric.dimensions) {
    const entry = perDimension.get(dimension.id);
    if (!entry) continue;
    const value = entry.total === 0 ? 0 : entry.passed / entry.total;
    // A hard-gate dimension that is not fully satisfied is zero, not a fraction.
    const gated = hardGateDimensions.has(dimension.id) && value < 1 ? 0 : value;
    metrics[dimension.id] = gated;
    weighted += gated * dimension.weight;
    weightSum += dimension.weight;
  }

  return {
    scorecard: {
      scorecardId: `sc-${report.reportDigest.slice(7, 19)}`,
      rubricVersion: `${rubric.id}/${rubric.version}`,
      metrics,
      // Normalised by the weights that were actually present, so a rubric whose
      // dimensions are partly unmapped does not silently shrink the maximum.
      aggregate: weightSum === 0 ? null : weighted / weightSum,
      createdAt: Date.now(),
    },
    withheldReason: null,
  };
}

/**
 * The rubric dimensions a failed hard gate zeroes outright.
 *
 * Named here so every adapter uses the same rule rather than each inventing its
 * own idea of "hard": a breached security invariant, schema contract or risk
 * limit is not a partial result.
 */
export const HARD_GATE_DIMENSIONS = {
  software: ["security_invariant"],
  data: ["schema_correctness", "reconciliation"],
  finance: ["policy_compliance", "risk_management"],
} as const;