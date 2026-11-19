/**
 * @file pipeline.ts — the Phase 2 pipeline lifecycle (§4.4).
 *
 * The document lists a lifecycle and twelve failure states and says two things
 * about it that are rules rather than vocabulary:
 *
 *   1. "A failed pipeline must not publish partial output to the final
 *      destination unless the task contract explicitly defines safe
 *      partial-commit semantics."
 *   2. `VERIFIED` sits between `RECONCILING` and `PUBLISHED_OUTPUT`, so a
 *      pipeline that has not reconciled cannot publish.
 *
 * Both of those are enforced here, in the state machine, rather than in a
 * comment on the adapter: `STAGING_OUTPUT -> PUBLISHED_OUTPUT` is not a legal
 * edge, and no failure state has an edge to `PUBLISHED_OUTPUT` at all. A caller
 * that wants to publish after a failure has to construct the transition and get
 * refused, which is the point.
 *
 * The failure states are states, not an error code beside a state. `AUTH_FAILED`
 * is where a pipeline *is*; a run that failed at `EXTRACTING` and a run that
 * failed at `VALIDATING` are different operational facts even when both are
 * "red", and collapsing them into `FAILED` loses the only information a repair
 * needs.
 */

export const PIPELINE_STATES = [
  "SOURCE_REGISTERED",
  "SOURCE_SNAPSHOT_PINNED",
  "CONTRACT_DRAFTED",
  "CONTRACT_VALIDATED",
  "MAPPING_APPROVED",
  "PIPELINE_PUBLISHED",
  "RUN_QUEUED",
  "EXTRACTING",
  "TRANSFORMING",
  "VALIDATING",
  "STAGING_OUTPUT",
  "RECONCILING",
  "VERIFIED",
  "PUBLISHED_OUTPUT",
] as const;

export type PipelineState = (typeof PIPELINE_STATES)[number];

export const PIPELINE_FAILURE_STATES = [
  "SOURCE_UNAVAILABLE",
  "AUTH_FAILED",
  "RATE_LIMITED",
  "SCHEMA_DRIFT",
  "CONTRACT_VIOLATION",
  "QUALITY_CHECK_FAILED",
  "RECONCILIATION_FAILED",
  "DUPLICATE_WRITE",
  "PARTIAL_OUTPUT",
  "PII_POLICY_VIOLATION",
  "LINEAGE_INCOMPLETE",
  "INFRASTRUCTURE_FAILURE",
] as const;

export type PipelineFailureState = (typeof PIPELINE_FAILURE_STATES)[number];

export type PipelineStatus = PipelineState | PipelineFailureState;

/**
 * The forward edges, plus the failures reachable from each stage.
 *
 * The failure edges are deliberately narrow: `PII_POLICY_VIOLATION` cannot come
 * from `EXTRACTING` (nothing has been classified yet), and `DUPLICATE_WRITE`
 * cannot come from `VALIDATING` (nothing has been written). A failure state that
 * any stage can reach is a failure state nobody can act on.
 */
const PIPELINE_TRANSITIONS: Record<PipelineState, readonly PipelineStatus[]> = {
  SOURCE_REGISTERED: ["SOURCE_SNAPSHOT_PINNED", "SOURCE_UNAVAILABLE", "AUTH_FAILED"],
  SOURCE_SNAPSHOT_PINNED: ["CONTRACT_DRAFTED", "SOURCE_UNAVAILABLE"],
  CONTRACT_DRAFTED: ["CONTRACT_VALIDATED", "CONTRACT_VIOLATION"],
  CONTRACT_VALIDATED: ["MAPPING_APPROVED", "SCHEMA_DRIFT", "CONTRACT_VIOLATION"],
  MAPPING_APPROVED: ["PIPELINE_PUBLISHED", "CONTRACT_VIOLATION"],
  PIPELINE_PUBLISHED: ["RUN_QUEUED"],
  RUN_QUEUED: ["EXTRACTING", "INFRASTRUCTURE_FAILURE"],
  EXTRACTING: ["TRANSFORMING", "AUTH_FAILED", "RATE_LIMITED", "SOURCE_UNAVAILABLE", "INFRASTRUCTURE_FAILURE"],
  TRANSFORMING: [
    "VALIDATING",
    "SCHEMA_DRIFT",
    "CONTRACT_VIOLATION",
    "INFRASTRUCTURE_FAILURE",
  ],
  VALIDATING: [
    "STAGING_OUTPUT",
    "QUALITY_CHECK_FAILED",
    "PII_POLICY_VIOLATION",
    "LINEAGE_INCOMPLETE",
    "INFRASTRUCTURE_FAILURE",
  ],
  STAGING_OUTPUT: [
    "RECONCILING",
    "DUPLICATE_WRITE",
    "PARTIAL_OUTPUT",
    "INFRASTRUCTURE_FAILURE",
  ],
  RECONCILING: [
    "VERIFIED",
    "RECONCILIATION_FAILED",
    "QUALITY_CHECK_FAILED",
    "INFRASTRUCTURE_FAILURE",
  ],
  // The only edge into PUBLISHED_OUTPUT in the whole machine.
  VERIFIED: ["PUBLISHED_OUTPUT", "INFRASTRUCTURE_FAILURE"],
  // Terminal. A published output is re-run through a new pipeline run, not
  // mutated in place: there is no edge back to STAGING_OUTPUT.
  PUBLISHED_OUTPUT: [],
};

const FAILURE_SET = new Set<string>(PIPELINE_FAILURE_STATES);

export function isPipelineFailure(state: string): state is PipelineFailureState {
  return FAILURE_SET.has(state);
}

/** A failure state is terminal: the repair is a new run, not a longer one. */
export function isTerminalPipelineState(state: string): boolean {
  return state === "PUBLISHED_OUTPUT" || isPipelineFailure(state);
}

export function canTransitionPipeline(from: PipelineStatus, to: PipelineStatus): boolean {
  if (isPipelineFailure(from) || from === "PUBLISHED_OUTPUT") return false;
  return (PIPELINE_TRANSITIONS[from] ?? []).includes(to);
}

export function nextPipelineStates(from: PipelineStatus): PipelineStatus[] {
  if (isPipelineFailure(from) || from === "PUBLISHED_OUTPUT") return [];
  return [...PIPELINE_TRANSITIONS[from]];
}

export class PipelineTransitionError extends Error {
  constructor(
    readonly from: PipelineStatus,
    readonly to: PipelineStatus,
  ) {
    super(
      to === "PUBLISHED_OUTPUT"
        ? "a pipeline may not publish before it has staged, reconciled and verified its output"
        : `illegal pipeline transition ${from} -> ${to}`,
    );
    this.name = "PipelineTransitionError";
  }
}

/**
 * Move one step, or throw.
 *
 * The message for the one transition the blueprint names explicitly is spelled
 * out: an operator who tried to publish straight from staging should read why
 * the staging step exists, not "illegal transition".
 */
export function assertPipelineTransition(from: PipelineStatus, to: PipelineStatus): void {
  if (!canTransitionPipeline(from, to)) throw new PipelineTransitionError(from, to);
}

export interface PipelineStep {
  from: PipelineStatus;
  to: PipelineStatus;
  /** Why the step happened; carried into the run event. */
  reason?: string;
}

/**
 * The failure a stage can report, or a refusal.
 *
 * `failPipeline` exists so a caller cannot invent `AUTH_FAILED` at a stage that
 * never authenticated anything. It returns the failure state rather than
 * throwing when the edge is legal, and throws when it is not.
 */
export function failPipeline(from: PipelineState, failure: PipelineFailureState): PipelineStep {
  if (!canTransitionPipeline(from, failure)) {
    throw new PipelineTransitionError(from, failure);
  }
  return { from, to: failure };
}

/**
 * Whether a run may be marked published.
 *
 * Belt and braces: the state machine already has one edge in, but a caller that
 * stores state as a string can ask this directly, and an answer of `false` is
 * cheaper to explain than a thrown transition.
 */
export function canPublishOutput(state: PipelineStatus): boolean {
  return state === "VERIFIED";
}
