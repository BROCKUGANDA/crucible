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
}

export interface ExecutionResult {
  artifacts: ArtifactRef[];
  logs: string[];
  outcome: "completed" | "failed";
}

export interface VerificationReport {
  status: VerificationStatus;
  checks: CheckResult[];
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
  aggregate: number;
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
  VERIFYING: ["SCORING", "ABSTAINED", "EVIDENCE_INCOMPLETE"],
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
