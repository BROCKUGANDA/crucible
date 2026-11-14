/**
 * @file trial-lifecycle.ts — Off-chain trial lifecycle state machine (blueprint §3–§4).
 *
 * The contract owns the financial execution states (Open → Assigned → Judging →
 * Challenged → Settled). This module owns the *product* lifecycle that wraps it:
 *
 *   DRAFT → REVIEW → APPROVED → SCHEDULED → ACTIVE → PAUSED/COMPLETED → VERIFIED →
 *   SETTLED → ARCHIVED
 *
 * with DISPUTED and CANCELLED as explicit side states reachable from most states.
 *
 * Published trial edits create a new revision; they cannot retroactively change
 * started runs. The API layer enforces transitions before any on-chain action is
 * requested, so a caller can never produce calldata for a transition the lifecycle
 * forbids.
 *
 * Consistent with ADR-0008: this is an in-memory store until ADR-0023 (PostgreSQL)
 * lands. Transitions are validated here; persistence is deferred.
 *
 * All timestamps are Unix milliseconds.
 */

import type { OrganisationPrincipal } from "@crucible/agent-security";

/* ------------------------------------------------------------------ */
/* Status set                                                         */
/* ------------------------------------------------------------------ */

/** The full blueprint trial lifecycle status set. */
export type TrialLifeStatus =
  | "DRAFT"
  | "REVIEW"
  | "APPROVED"
  | "SCHEDULED"
  | "ACTIVE"
  | "PAUSED"
  | "COMPLETED"
  | "VERIFIED"
  | "SETTLED"
  | "ARCHIVED"
  | "DISPUTED"   // side state
  | "CANCELLED"; // side state

/** The linear main path, in order. Used to reject backward jumps. */
export const LIFECYCLE_ORDER: Record<TrialLifeStatus, number> = {
  DRAFT: 0,
  REVIEW: 1,
  APPROVED: 2,
  SCHEDULED: 3,
  ACTIVE: 4,
  PAUSED: 5,
  COMPLETED: 6,
  VERIFIED: 7,
  SETTLED: 8,
  ARCHIVED: 9,
  // Side states sit outside the linear order; they are reachable from most
  // states but do not advance the main path.
  DISPUTED: -1,
  CANCELLED: -1,
} as const;

/** Whether a status is a side state (not on the main linear path). */
export function isSideState(status: TrialLifeStatus): boolean {
  return status === "DISPUTED" || status === "CANCELLED";
}

/* ------------------------------------------------------------------ */
/* Valid transitions                                                  */
/* ------------------------------------------------------------------ */

/**
 * The allowed next states for each current state. A transition not listed here
 * is rejected at the API layer, before any contract calldata is built.
 *
 * Side-state transitions:
 *   * From any non-terminal state → DISPUTED (a break was filed / challenge opened)
 *   * From any non-terminal state → CANCELLED (sponsor withdraws before settlement)
 *   * DISPUTED → VERIFIED (dispute resolved, agent wins) or SETTLED (dispute resolved, agent loses)
 *   * CANCELLED → ARCHIVED (after cancellation is recorded)
 *
 * Main path:
 *   DRAFT → REVIEW → APPROVED → SCHEDULED → ACTIVE → {PAUSED, COMPLETED}
 *   PAUSED → ACTIVE
 *   ACTIVE → COMPLETED
 *   COMPLETED → VERIFIED → SETTLED → ARCHIVED
 */
export const TRANSITIONS: Record<TrialLifeStatus, TrialLifeStatus[]> = {
  DRAFT: ["REVIEW", "DISPUTED", "CANCELLED"],
  REVIEW: ["APPROVED", "DRAFT", "DISPUTED", "CANCELLED"],
  APPROVED: ["SCHEDULED", "DISPUTED", "CANCELLED"],
  SCHEDULED: ["ACTIVE", "DISPUTED", "CANCELLED"],
  ACTIVE: ["PAUSED", "COMPLETED", "DISPUTED", "CANCELLED"],
  PAUSED: ["ACTIVE", "DISPUTED", "CANCELLED"],
  COMPLETED: ["VERIFIED", "DISPUTED", "CANCELLED"],
  VERIFIED: ["SETTLED", "DISPUTED", "CANCELLED"],
  SETTLED: ["ARCHIVED", "DISPUTED"],
  ARCHIVED: [], // terminal
  DISPUTED: ["VERIFIED", "SETTLED", "CANCELLED"],
  CANCELLED: ["ARCHIVED"], // terminal side state
} as const;

/** States from which a sponsor may initiate cancellation. */
export const CANCELLABLE: ReadonlySet<TrialLifeStatus> = new Set([
  "DRAFT",
  "REVIEW",
  "APPROVED",
  "SCHEDULED",
  "ACTIVE",
  "PAUSED",
  "COMPLETED",
  "VERIFIED",
]);

/** States from which a dispute may be opened. */
export const DISPUTABLE: ReadonlySet<TrialLifeStatus> = new Set([
  "ACTIVE",
  "COMPLETED",
  "VERIFIED",
]);

/* ------------------------------------------------------------------ */
/* Trial record                                                       */
/* ------------------------------------------------------------------ */

export interface TrialRevision {
  /** Monotonically increasing per trial. 1 = first published revision. */
  revision: number;
  /** The status this revision was published under. */
  status: TrialLifeStatus;
  /** When this revision became current. */
  publishedAt: number;
  /** The sponsor-editable fields snapshot for this revision. */
  spec: TrialSpec;
}

/** The sponsor-editable fields of a trial. Changing these after publication
 * creates a new revision; they never retroactively alter started runs. */
export interface TrialSpec {
  title: string;
  objective: string;
  rewardWei: string;
  bondBps: number;
  deadlineSec: number;
  breakWindowSec: number;
  specCID: string | null;
  testsCID: string | null;
  eligibility?: string;
}

export interface TrialRecord {
  id: number;
  sponsor: string; // wallet address that created the trial
  orgId: string | null; // tenant context, resolved server-side
  status: TrialLifeStatus;
  /** The spec as submitted, before anything is published. Not a revision: revisions
   * are published snapshots and numbering starts at the first publication. Consumed by
   * the first accepted transition, which turns it into revision 1. */
  draftSpec: TrialSpec | null;
  currentRevision: TrialRevision | null;
  revisions: TrialRevision[];
  /** Chain state mirror (Open/Assigned/Judging/Challenged/Settled), or null
   * when no on-chain trial exists yet for this record. */
  chainStatus: "Open" | "Assigned" | "Judging" | "Challenged" | "Settled" | null;
  createdAt: number;
  updatedAt: number;
  /** The run hash once a run is submitted; null until then. */
  runHash: string | null;
  /** Whether a run has started (chain Assigned or later). Used to enforce that
   * published revisions cannot retroactively change started runs. */
  runStarted: boolean;
}

/* ------------------------------------------------------------------ */
/* In-memory store                                                    */
/* ------------------------------------------------------------------ */

const STATE_KEY = "__crucible_trial_lifecycle__";
const globalScope = globalThis as unknown as Record<string, unknown>;
type Store = {
  trials: Map<number, TrialRecord>;
  nextId: number;
};
const store: Store =
  (globalScope[STATE_KEY] as Store | undefined) ?? {
    trials: new Map(),
    nextId: 1,
  };
globalScope[STATE_KEY] = store;

export function getTrial(id: number): TrialRecord | null {
  return store.trials.get(id) ?? null;
}

export function listTrials(): TrialRecord[] {
  return [...store.trials.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function listTrialsBySponsor(sponsor: string): TrialRecord[] {
  return [...store.trials.values()].filter(
    (t) => t.sponsor.toLowerCase() === sponsor.toLowerCase(),
  );
}

export function resetStoreForTests(): void {
  store.trials.clear();
  store.nextId = 1;
}

/* ------------------------------------------------------------------ */
/* Transition validation                                              */
/* ------------------------------------------------------------------ */

export interface TransitionContext {
  /** The principal requesting the transition, resolved from SIWE session. */
  principal: OrganisationPrincipal | null;
  /**
   * The caller's address, taken from the verified SIWE session. This is the
   * authorization identity for sponsor-gated transitions; a value supplied in
   * the request body is never authority.
   */
  walletAddress: string | null;
}

/** Why a transition was rejected. */
export interface TransitionRejection {
  allowed: false;
  reason: string;
  code: "not-authenticated" | "not-sponsor" | "not-org-member" | "invalid-transition" | "run-already-started" | "terminal-state";
}

/** Why a transition was accepted. */
export interface TransitionAcceptance {
  allowed: true;
  nextStatus: TrialLifeStatus;
  newRevision: boolean; // whether this transition publishes a new revision
}

export type TransitionDecision = TransitionAcceptance | TransitionRejection;

/**
 * Validate a requested state transition against the lifecycle rules and the
 * caller's authorization.
 *
 * Rules enforced:
 *   1. The target state must be in TRANSITIONS[current].
 *   2. Terminal states (ARCHIVED, CANCELLED) have no outgoing transitions.
 *   3. Every transition is sponsor-gated: the recorded sponsor drives the trial's
 *      lifecycle, and the check binds to the caller's verified session address,
 *      never to a request-supplied value.
 *   4. Once a run has started, published revisions cannot change started runs
 *      (enforced by revisioning, not by blocking the transition itself).
 *   5. DISPUTED requires a break to have been filed (chain Challenged).
 *   6. VERIFIED requires Argus verification (chain Settled with verdict).
 *   7. SETTLED requires chain finalization.
 */
export function validateTransition(
  trial: TrialRecord,
  to: TrialLifeStatus,
  ctx: TransitionContext,
): TransitionDecision {
  const from = trial.status;

  // Terminal states accept no transitions.
  if (from === "ARCHIVED" || from === "CANCELLED") {
    return {
      allowed: false,
      reason: `trial ${trial.id} is in terminal state ${from}; no further transitions`,
      code: "terminal-state",
    };
  }

  // The target must be a listed next state.
  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) {
    return {
      allowed: false,
      reason: `transition ${from} → ${to} is not permitted; allowed: [${allowed.join(", ")}]`,
      code: "invalid-transition",
    };
  }

  // Sponsor-gated: every transition. The authorization identity is the caller's
  // verified session address; chain-gated targets are additionally restricted below.
  if (!ctx.walletAddress || !ctx.principal) {
    return {
      allowed: false,
      reason: "transition requires SIWE-authenticated sponsor",
      code: "not-authenticated",
    };
  }
  if (trial.sponsor.toLowerCase() !== ctx.walletAddress.toLowerCase()) {
    return {
      allowed: false,
      reason: `only the trial sponsor (${trial.sponsor}) may transition this trial`,
      code: "not-sponsor",
    };
  }

  // DISPUTED requires the chain to be in Challenged (a break was filed).
  if (to === "DISPUTED" && trial.chainStatus !== "Challenged") {
    return {
      allowed: false,
      reason: "dispute can only be opened when the chain trial is Challenged",
      code: "invalid-transition",
    };
  }

  // VERIFIED requires chain Settled with a verdict (Argus has finalized).
  if (to === "VERIFIED" && trial.chainStatus !== "Settled") {
    return {
      allowed: false,
      reason: "verified requires the chain trial to be Settled",
      code: "invalid-transition",
    };
  }

  // SETTLED requires chain finalization.
  if (to === "SETTLED" && trial.chainStatus !== "Settled") {
    return {
      allowed: false,
      reason: "settled requires the chain trial to be Settled",
      code: "invalid-transition",
    };
  }

  // Once a run has started, a sponsor cannot use a revision to change the run.
  // The transition itself is allowed, but the spec edit that accompanies it is
  // gated elsewhere (see validateRevisionEdit).
  if (to === "REVIEW" && trial.runStarted && trial.currentRevision) {
    // Allowed: moving back to REVIEW for re-editing, but the new revision
    // cannot alter the already-started run. This is enforced by the revision
    // immutability rule at edit time.
  }

  const newRevision =
    to === "APPROVED" || to === "SCHEDULED" || to === "ACTIVE";

  return {
    allowed: true,
    nextStatus: to,
    newRevision,
  };
}

/**
 * Validate a spec edit against the immutability rule: once a run has started,
 * a published revision's spec fields that affect the run (reward, bond, deadline,
 * break window) cannot be changed. Non-run-affecting fields (title, objective,
 * eligibility) may still be updated in a new revision.
 */
export type RevisionEditDecision =
  | {
      allowed: true;
      /** The fields that may be changed in the new revision. */
      editable: (keyof TrialSpec)[];
    }
  | {
      allowed: false;
      reason: string;
      code: "run-immutable-field" | "not-published";
    };

export function validateRevisionEdit(
  trial: TrialRecord,
  proposed: Partial<TrialSpec>,
): RevisionEditDecision {
  if (trial.status !== "APPROVED" && trial.status !== "SCHEDULED" && trial.status !== "ACTIVE") {
    return {
      allowed: false,
      reason: "revision edits are only allowed on published trials (APPROVED, SCHEDULED, ACTIVE)",
      code: "not-published",
    };
  }

  if (!trial.runStarted) {
    // No run has started: all fields are editable.
    return {
      allowed: true,
      editable: [
        "title",
        "objective",
        "rewardWei",
        "bondBps",
        "deadlineSec",
        "breakWindowSec",
        "specCID",
        "testsCID",
        "eligibility",
      ],
    };
  }

  // A run has started: run-affecting fields are immutable.
  const runAffecting: (keyof TrialSpec)[] = [
    "rewardWei",
    "bondBps",
    "deadlineSec",
    "breakWindowSec",
  ];
  const immutableRequested = runAffecting.filter(
    (f) => proposed[f] !== undefined &&
      trial.currentRevision?.spec[f] !== undefined &&
      String(proposed[f]) !== String(trial.currentRevision.spec[f]),
  );

  if (immutableRequested.length > 0) {
    return {
      allowed: false,
      reason: `cannot change run-affecting fields after a run has started: [${immutableRequested.join(", ")}]`,
      code: "run-immutable-field",
    };
  }

  return {
    allowed: true,
    editable: [
      "title",
      "objective",
      "specCID",
      "testsCID",
      "eligibility",
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Record creation and transition application                         */
/* ------------------------------------------------------------------ */

export interface CreateTrialInput {
  sponsor: string;
  orgId: string | null;
  spec: TrialSpec;
}

export function createTrial(input: CreateTrialInput): TrialRecord {
  const now = Date.now();
  const id = store.nextId++;
  // The submitted spec is kept as `draftSpec`, not as a revision: revisions are
  // published snapshots and numbering starts at the first publication. It used to be
  // dropped on the floor here, and the first accepted transition then rebuilt the
  // revision from an all-zeros fallback — so every title, objective and reward a
  // sponsor submitted was silently discarded. Nothing caught it because the revision
  // route rejects DRAFT trials, leaving creation as the only place a spec could ever
  // be supplied, and the create test asserted everything except the spec.
  const record: TrialRecord = {
    id,
    sponsor: input.sponsor,
    orgId: input.orgId,
    status: "DRAFT",
    draftSpec: { ...input.spec },
    currentRevision: null,
    revisions: [],
    chainStatus: null,
    createdAt: now,
    updatedAt: now,
    runHash: null,
    runStarted: false,
  };
  store.trials.set(id, record);
  return record;
}

/** Apply an approved transition, mutating the record and returning it. */
export function applyTransition(
  trial: TrialRecord,
  decision: TransitionAcceptance,
): TrialRecord {
  trial.status = decision.nextStatus;
  trial.updatedAt = Date.now();

  if (decision.newRevision && trial.status !== "DISPUTED" && trial.status !== "CANCELLED") {
    const revision: TrialRevision = {
      revision: (trial.currentRevision?.revision ?? 0) + 1,
      status: trial.status,
      publishedAt: trial.updatedAt,
      spec: {
        ...(trial.currentRevision?.spec ?? trial.draftSpec ?? {
          title: "",
          objective: "",
          rewardWei: "0",
          bondBps: 0,
          deadlineSec: 0,
          breakWindowSec: 0,
          specCID: null,
          testsCID: null,
        }),
      },
    };
    trial.revisions.push(revision);
    trial.currentRevision = revision;
    // The draft has been published; later revisions branch from it.
    trial.draftSpec = null;
  }

  store.trials.set(trial.id, trial);
  return trial;
}

/** Record that a run has started on-chain (chain Assigned or later). */
export function markRunStarted(id: number, runHash: string): TrialRecord | null {
  const trial = store.trials.get(id);
  if (!trial) return null;
  trial.runStarted = true;
  trial.runHash = runHash;
  trial.updatedAt = Date.now();
  store.trials.set(id, trial);
  return trial;
}

/** Record the chain's state for a trial (Open/Assigned/Judging/Challenged/Settled). */
export function syncChainStatus(
  id: number,
  chainStatus: TrialRecord["chainStatus"],
): TrialRecord | null {
  const trial = store.trials.get(id);
  if (!trial) return null;
  trial.chainStatus = chainStatus;
  trial.updatedAt = Date.now();
  store.trials.set(id, trial);
  return trial;
}

/** Persist a mutated trial record back to the store. Used by revision edits. */
export function persistTrial(trial: TrialRecord): void {
  store.trials.set(trial.id, trial);
}
