/**
 * @file workload-contracts.ts — Canonical WorkloadAdapter + RunContext + manifest.
 * Blueprint §2/WP0. One Trial/Run system; workload profiles are adapters,
 * not separate products. Adapter never selects tenant/run/score/reward.
 */

export type WorkloadProfile =
  | "SOFTWARE_ENGINEERING"
  | "STRUCTURED_DATA"
  | "AUTONOMOUS_FINANCE";

export type VerificationStatus = "PASS" | "FAIL" | "ABSTAIN" | "NEEDS_REVIEW" | "INCOMPLETE";

export type RunState =
  | "DRAFT" | "VALIDATED" | "PUBLISHED" | "QUEUED" | "ADMITTED" | "PREPARING"
  | "RUNNING" | "COLLECTING_EVIDENCE" | "VERIFYING" | "SCORING"
  | "PROVISIONAL_RESULT" | "DISPUTE_WINDOW" | "FINAL_RESULT"
  | "REWARD_PENDING" | "RECONCILED"
  | "NEEDS_REVIEW"
  | "REJECTED_TASK" | "CANCELLED" | "FAILED_INFRASTRUCTURE" | "FAILED_PARTICIPANT"
  | "TIMED_OUT" | "RESOURCE_LIMIT_EXCEEDED" | "POLICY_VIOLATION"
  | "EVIDENCE_INCOMPLETE" | "ABSTAINED" | "DISPUTED" | "SUPERSEDED";

export interface RunContext {
  runId: string;
  attemptId: string;
  tenantId: string;
  trialId: string;
  trialRevisionId: string;
  workloadProfile: WorkloadProfile;
  environmentDigest: string;
  deadlineAt: string;
  idempotencyKey: string;
  abortSignal: AbortSignal;
}

export interface ValidationReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface PreparedTask {
  taskDigest: string;
  manifest: ExecutionManifest;
  /**
   * The checks this task requires, when the task decides them.
   *
   * A regression-repair task and a vulnerability-detection task run the same
   * runner but do not mean the same thing by "the security check failed": the
   * first is a defect, the second is a finding a human must confirm. The
   * adapter resolves that at `prepare` time from the *validated* task and
   * carries it through the run, so `verify` does not have to re-read a task it
   * was not given. Absent means the adapter's fixed list.
   */
  requirements?: readonly import("./verification.js").RequiredCheck[];
}

export interface ExecutionResult {
  artifacts: ArtifactRef[];
  logs: string[];
  outcome: "completed" | "failed";
  /**
   * What the runner observed for each check it ran.
   *
   * The runner reports facts; the verifier computes the verdict from them. An
   * absent array means the run produced no evidence, which is
   * `EVIDENCE_INCOMPLETE` — never a pass and never a zero.
   */
  evidence?: CheckEvidenceLike[];
  /**
   * The requirement set this run was prepared under.
   *
   * Travelling on the result rather than being looked up again is what keeps
   * the verdict bound to the task that was actually validated: a verifier that
   * re-resolved the task from a request could score a different contract than
   * the runner executed.
   */
  requirements?: readonly import("./verification.js").RequiredCheck[];
  /** Set when the run could not be evaluated for reasons that are not the participant's. */
  infrastructureFailure?: string | null;
}

/** A runner observation. Structurally identical to `CheckEvidence`. */
export interface CheckEvidenceLike {
  id: string;
  passed: boolean;
  detail: string;
  artifactDigest?: string;
}

export interface VerificationReport {
  status: VerificationStatus;
  checks: CheckResult[];
  /** SHA-256 over the canonical check set; never a placeholder. */
  reportDigest: string;
  verifierVersion: string;
}

export interface CheckResult {
  id: string;
  passed: boolean;
  detail: string;
  required: boolean;
}

export interface Scorecard {
  scorecardId: string;
  rubricVersion: string;
  metrics: Record<string, number>;
  /**
   * The weighted aggregate, or `null` when the report was not scoreable.
   *
   * A null is not a zero: a run whose evidence was incomplete has no score,
   * and rendering 0 for it would invent a measurement that was never made.
   */
  aggregate: number | null;
  createdAt: number;
}

export interface ArtifactRef {
  digest: string;
  kind: string;
  uri: string;
}

export interface ExecutionManifest {
  runId: string;
  attemptId: string;
  tenantId: string;
  trialId: string;
  trialRevisionId: string;
  workloadProfile: WorkloadProfile;
  adapterVersion: string;
  taskDigest: string;
  runnerImageDigest: string;
  evaluatorVersion: string;
  rubricVersion: string;
  startedAt: number;
  endedAt?: number;
  artifactDigests: string[];
  verificationReportDigest?: string;
  scorecardId?: string;
}

export interface WorkloadAdapter<Input = unknown, Output = unknown> {
  profile: WorkloadProfile;
  version: string;
  validateTask(task: unknown): Promise<ValidationReport>;
  prepare(input: Input, context: RunContext): Promise<PreparedTask>;
  execute(prepared: PreparedTask, context: RunContext): Promise<ExecutionResult>;
  verify(result: ExecutionResult, context: RunContext): Promise<VerificationReport>;
  score(report: VerificationReport, rubric: VersionedRubric): Promise<Scorecard>;
  cleanup(context: RunContext): Promise<void>;
}

export interface VersionedRubric {
  id: string;
  version: string;
  dimensions: { id: string; weight: number }[];
}

// --- State machine -----------------------------------------------------------
const TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["VALIDATED", "REJECTED_TASK", "CANCELLED"],
  VALIDATED: ["PUBLISHED", "REJECTED_TASK", "CANCELLED"],
  PUBLISHED: ["QUEUED", "CANCELLED"],
  QUEUED: ["ADMITTED", "CANCELLED", "FAILED_INFRASTRUCTURE"],
  ADMITTED: ["PREPARING", "CANCELLED"],
  PREPARING: ["RUNNING", "FAILED_INFRASTRUCTURE"],
  RUNNING: ["COLLECTING_EVIDENCE", "TIMED_OUT", "FAILED_INFRASTRUCTURE", "FAILED_PARTICIPANT", "POLICY_VIOLATION", "CANCELLED"],
  COLLECTING_EVIDENCE: ["VERIFYING", "EVIDENCE_INCOMPLETE", "FAILED_INFRASTRUCTURE"],
  // A verdict a machine will not pronounce goes to a reviewer. `SCORING` is
  // deliberately not an edge from here: a needs-review run has no score until
  // a human resolves the finding, which is the whole point of the state.
  VERIFYING: ["SCORING", "NEEDS_REVIEW", "ABSTAINED", "EVIDENCE_INCOMPLETE"],
  // How a review ends: confirmed (provisional result) or refused (superseded).
  NEEDS_REVIEW: ["PROVISIONAL_RESULT", "SUPERSEDED", "FAILED_PARTICIPANT"],
  SCORING: ["PROVISIONAL_RESULT", "FAILED_INFRASTRUCTURE"],
  PROVISIONAL_RESULT: ["DISPUTE_WINDOW", "FINAL_RESULT", "DISPUTED"],
  DISPUTE_WINDOW: ["FINAL_RESULT", "DISPUTED"],
  FINAL_RESULT: ["REWARD_PENDING", "SUPERSEDED"],
  REWARD_PENDING: ["RECONCILED"],
  RECONCILED: [],
  _terminal: [],
};

const TERMINAL = new Set<string>([
  "REJECTED_TASK", "CANCELLED", "FAILED_INFRASTRUCTURE", "FAILED_PARTICIPANT",
  "TIMED_OUT", "RESOURCE_LIMIT_EXCEEDED", "POLICY_VIOLATION", "EVIDENCE_INCOMPLETE",
  "ABSTAINED", "DISPUTED", "SUPERSEDED", "RECONCILED",
]);

export function canTransition(from: RunState, to: RunState): boolean {
  if (TERMINAL.has(from)) return false;
  return (TRANSITIONS[from] ?? []).includes(to as never);
}

export function nextStates(from: RunState): RunState[] {
  return (TRANSITIONS[from] ?? []) as RunState[];
}

export function isTerminal(state: RunState): boolean {
  return TERMINAL.has(state);
}

/** One recorded move. The API keeps these per run and serves them at `/runs/:id/events`. */
export interface RunTransition {
  /** Monotonic per run, from 1. */
  sequence: number;
  from: RunState;
  to: RunState;
  at: number;
  reason?: string;
}

export class RunTransitionError extends Error {
  constructor(
    readonly from: RunState,
    readonly to: RunState,
  ) {
    super(`illegal run transition ${from} -> ${to}`);
    this.name = "RunTransitionError";
  }
}

/**
 * Move one step, or throw.
 *
 * `canTransition` existed since the state machine was written and had no
 * caller, so the machine described a lifecycle nothing enforced: any status
 * could follow any other and the diagram was decoration. This is the caller.
 */
export function assertRunTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new RunTransitionError(from, to);
}

/**
 * The run state a verification status settles into.
 *
 * `PASS` and `FAIL` both reach `SCORING`: a failing participant is a scored
 * outcome, not an unevaluated one. The three non-verdicts each have their own
 * state so an operator can tell "no evidence" from "needs a human" from "the
 * verifier declined" without reading a reason string.
 */
export function runStateForVerification(
  status: "PASS" | "FAIL" | "ABSTAIN" | "NEEDS_REVIEW" | "INCOMPLETE",
): RunState {
  switch (status) {
    case "PASS":
    case "FAIL":
      return "SCORING";
    case "ABSTAIN":
      return "ABSTAINED";
    case "NEEDS_REVIEW":
      return "NEEDS_REVIEW";
    case "INCOMPLETE":
      return "EVIDENCE_INCOMPLETE";
  }
}

/** Manifest must pin run/attempt/tenant/trial/revision + digests. */
export function validateManifest(m: ExecutionManifest): string[] {
  const errs: string[] = [];
  if (!m.runId) errs.push("runId required");
  if (!m.attemptId) errs.push("attemptId required");
  if (!m.tenantId) errs.push("tenantId required");
  if (!m.trialId) errs.push("trialId required");
  if (!m.trialRevisionId) errs.push("trialRevisionId required");
  if (!m.taskDigest) errs.push("taskDigest required");
  if (!m.runnerImageDigest) errs.push("runnerImageDigest required");
  if (!m.evaluatorVersion) errs.push("evaluatorVersion required");
  if (!m.rubricVersion) errs.push("rubricVersion required");
  return errs;
}
