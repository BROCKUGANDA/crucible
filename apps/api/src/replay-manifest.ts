/**
 * @file replay-manifest.ts — Replay manifest system (Phase 2).
 *
 * Every evaluation run captures a reproducibility manifest containing all
 * inputs, configurations, and outputs required for independent replay.
 * Three independent replays are required before a verdict stands as verified.
 */

import { createHash, randomUUID } from "node:crypto";
import { REQUIRED_REPLAYS, REQUIRED_REPLAY_WORKERS } from "./replay-policy.js";
import { currentReplayStore } from "./replay-store.js";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type ReplayStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "INCONCLUSIVE" | "REVIEW_REQUIRED";
export type ReproducibilityState = "REPRODUCIBLE" | "PENDING" | "FAILED" | "INCONCLUSIVE" | "REVIEW_REQUIRED";

export interface ReplayManifest {
  manifestId: string;
  trialId: string;
  runId: string;
  specDigest: string;
  suiteVersion: string;
  agentId: string;
  agentVersion?: string;
  modelId?: string;
  runtimeImageDigest: string;
  executionConfig: Record<string, unknown>;
  judgeVersion: string;
  randomnessSeed?: string;
  randomnessProvenance?: string;
  environmentFingerprint: string;
  artifactHashes: Record<string, string>;
  startTimestamp: number;
  finishTimestamp?: number;
  workerIdentity: string;
  executionTraceRefs?: string[];
  status: ReplayStatus;
  reproducibilityState: ReproducibilityState;
  /**
   * WHY the state is what it is, derived from the replays.
   *
   * "INCONCLUSIVE" alone is a shrug. This says which of the two
   * possibilities it is: the replays disagreed, or they agreed but did not
   * come from enough different workers. A reader should not have to guess
   * which.
   */
  reproducibilityNote?: string;
  createdAt: number;
}

export interface ReplayRecord {
  replayId: string;
  manifestId: string;
  replayNumber: number; // 1, 2, or 3
  /**
   * WHO RAN THIS REPLAY.
   *
   * Not a name the caller chose. The independence rule is only as good as
   * this field, and a caller that names its three replays "worker-a",
   * "worker-b" and "worker-c" would satisfy any check that reads a label.
   * The platform derives it — the worker that executed the replay — and a
   * caller's name for the replay is kept beside it as `label`, which is
   * shown and never used for the rule.
   */
  workerIdentity: string;
  /** The name the caller gave this replay. A name, not an identity. */
  label?: string;
  startTimestamp: number;
  finishTimestamp?: number;
  outputHash?: string;
  status: ReplayStatus;
  differences?: Record<string, unknown>;
  createdAt: number;
}

export interface CreateReplayManifestInput {
  trialId: string;
  runId: string;
  specDigest: string;
  suiteVersion: string;
  agentId: string;
  agentVersion?: string;
  modelId?: string;
  runtimeImageDigest: string;
  executionConfig: Record<string, unknown>;
  judgeVersion: string;
  randomnessSeed?: string;
  randomnessProvenance?: string;
  environmentFingerprint: string;
  artifactHashes: Record<string, string>;
  workerIdentity: string;
  executionTraceRefs?: string[];
}

/* ------------------------------------------------------------------ */
/* The store                                                           */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Manifest operations                                                */
/* ------------------------------------------------------------------ */

export async function createReplayManifest(
  input: CreateReplayManifestInput,
): Promise<ReplayManifest> {
  const errors: string[] = [];

  if (!input.trialId) errors.push("trialId is required");
  if (!input.runId) errors.push("runId is required");
  if (!input.specDigest) errors.push("specDigest is required");
  if (!input.suiteVersion) errors.push("suiteVersion is required");
  if (!input.agentId) errors.push("agentId is required");
  if (!input.runtimeImageDigest) errors.push("runtimeImageDigest is required");
  if (!input.judgeVersion) errors.push("judgeVersion is required");
  if (!input.environmentFingerprint) errors.push("environmentFingerprint is required");
  if (!input.workerIdentity) errors.push("workerIdentity is required");

  if (errors.length > 0) {
    throw new Error(`Invalid manifest input: ${errors.join("; ")}`);
  }

  const now = Date.now();
  const manifestId = randomUUID();

  const manifest: ReplayManifest = {
    manifestId,
    trialId: input.trialId,
    runId: input.runId,
    specDigest: input.specDigest,
    suiteVersion: input.suiteVersion,
    agentId: input.agentId,
    agentVersion: input.agentVersion,
    modelId: input.modelId,
    runtimeImageDigest: input.runtimeImageDigest,
    executionConfig: input.executionConfig,
    judgeVersion: input.judgeVersion,
    randomnessSeed: input.randomnessSeed,
    randomnessProvenance: input.randomnessProvenance,
    environmentFingerprint: input.environmentFingerprint,
    artifactHashes: input.artifactHashes,
    startTimestamp: now,
    workerIdentity: input.workerIdentity,
    executionTraceRefs: input.executionTraceRefs,
    status: "PENDING",
    reproducibilityState: "PENDING",
    createdAt: now,
  };

  await currentReplayStore().putManifest(manifest);
  return manifest;
}

export async function getReplayManifest(manifestId: string): Promise<ReplayManifest | undefined> {
  return currentReplayStore().getManifest(manifestId);
}

export async function listManifestsByTrial(trialId: string): Promise<ReplayManifest[]> {
  return currentReplayStore().listManifestsByTrial(trialId);
}

export async function listManifestsByRun(runId: string): Promise<ReplayManifest[]> {
  return currentReplayStore().listManifestsByRun(runId);
}

/* ------------------------------------------------------------------ */
/* Replay operations                                                  */
/* ------------------------------------------------------------------ */

export async function createReplayRecord(
  manifestId: string,
  replayNumber: number,
  workerIdentity: string,
  label?: string,
): Promise<ReplayRecord> {
  const manifest = await currentReplayStore().getManifest(manifestId);
  if (!manifest) {
    throw new Error(`Manifest "${manifestId}" not found`);
  }

  if (replayNumber < 1 || replayNumber > REQUIRED_REPLAYS) {
    // The bound is the RULE's number, not a number written down here: a
    // second place to change the rule is a second place to get it wrong.
    throw new Error(`replayNumber must be 1, ${REQUIRED_REPLAYS}`);
  }

  // Check for duplicate replay number
  const existing = await currentReplayStore().listReplaysByManifest(manifestId);
  for (const record of existing) {
    if (record.replayNumber === replayNumber) {
      throw new Error(`Replay ${replayNumber} already exists for manifest "${manifestId}"`);
    }
  }

  const now = Date.now();
  const replayId = randomUUID();

  const record: ReplayRecord = {
    replayId,
    manifestId,
    replayNumber,
    workerIdentity,
    label,
    startTimestamp: now,
    status: "PENDING",
    createdAt: now,
  };

  await currentReplayStore().putReplay(record);
  return record;
}

export async function completeReplay(
  replayId: string,
  outputHash: string,
): Promise<ReplayRecord> {
  const record = await currentReplayStore().getReplay(replayId);
  if (!record) {
    throw new Error(`Replay "${replayId}" not found`);
  }

  const now = Date.now();
  const completed = {
    ...record,
    outputHash,
    finishTimestamp: now,
    status: "COMPLETED" as const,
  };

  await currentReplayStore().putReplay(completed);

  // Update manifest reproducibility state
  await updateReproducibilityState(record.manifestId);

  return completed;
}

export async function failReplay(replayId: string, reason: string): Promise<ReplayRecord> {
  const record = await currentReplayStore().getReplay(replayId);
  if (!record) {
    throw new Error(`Replay "${replayId}" not found`);
  }

  const now = Date.now();
  const failed = {
    ...record,
    finishTimestamp: now,
    status: "FAILED" as const,
    differences: { reason },
  };

  await currentReplayStore().putReplay(failed);
  await updateReproducibilityState(record.manifestId);

  return failed;
}

export async function getReplayRecord(replayId: string): Promise<ReplayRecord | undefined> {
  return currentReplayStore().getReplay(replayId);
}

export async function listReplaysByManifest(manifestId: string): Promise<ReplayRecord[]> {
  return currentReplayStore().listReplaysByManifest(manifestId);
}

/* ------------------------------------------------------------------ */
/* Reproducibility state computation                                  */
/* ------------------------------------------------------------------ */

async function updateReproducibilityState(manifestId: string): Promise<void> {
  const replays = await listReplaysByManifest(manifestId);
  const completed = replays.filter((r) => r.status === "COMPLETED");
  const failed = replays.filter((r) => r.status === "FAILED");

  const manifest = await currentReplayStore().getManifest(manifestId);
  if (!manifest) return;

  let state: ReproducibilityState;
  let note: string | undefined;

  if (failed.length > 0 && completed.length === 0) {
    state = "FAILED";
    note = `${failed.length} of ${replays.length} replays failed and none completed.`;
  } else if (completed.length >= REQUIRED_REPLAYS) {
    // Two separate questions, and the answer to the second one decides
    // whether the first one means anything: did the replays AGREE, and did
    // they come from enough DIFFERENT workers?
    const hashes = completed.map((r) => r.outputHash).filter(Boolean) as string[];
    const allAgree = hashes.length > 0 && hashes.every((h) => h === hashes[0]);
    const workers = independentWorkerCount(completed);
    if (!allAgree) {
      state = "INCONCLUSIVE";
      note =
        `the ${completed.length} completed replays did not produce the same result, ` +
        `so the result does not follow from the task.`;
    } else if (workers < REQUIRED_REPLAY_WORKERS) {
      state = "INCONCLUSIVE";
      note =
        `the ${completed.length} completed replays agreed, but they came from ` +
        `${workers} worker${workers === 1 ? "" : "s"}; the rule needs ` +
        `${REQUIRED_REPLAY_WORKERS} different workers, because one worker can be ` +
        `wrong the same way three times.`;
    } else {
      state = "REPRODUCIBLE";
      note =
        `${completed.length} replays from ${workers} different workers produced the ` +
        `same result.`;
    }
  } else {
    state = "PENDING";
    note =
      `${completed.length} of the ${REQUIRED_REPLAYS} replays the rule needs have completed.`;
  }

  const updated = { ...manifest, reproducibilityState: state, reproducibilityNote: note };
  await currentReplayStore().putManifest(updated);
}

/**
 * How many DIFFERENT workers the completed replays came from.
 *
 * This is the number the independence rule is decided on. The replays'
 * labels are not consulted: a label is a name the caller chose, and a rule
 * that a caller can satisfy by naming things differently is not a rule.
 */
export function independentWorkerCount(replays: ReplayRecord[]): number {
  const workers = new Set<string>();
  for (const replay of replays) {
    if (replay.status === "COMPLETED") workers.add(replay.workerIdentity);
  }
  return workers.size;
}

/**
 * Check if a manifest has three agreeing replays.
 */
export async function isVerified(manifestId: string): Promise<boolean> {
  const manifest = await currentReplayStore().getManifest(manifestId);
  if (!manifest) return false;
  return manifest.reproducibilityState === "REPRODUCIBLE";
}

/* ------------------------------------------------------------------ */
/* Store access for testing                                         */
/* ------------------------------------------------------------------ */

/**
 * Empty the store.
 *
 * Only a test may do this, and only to start from a known state.
 */
export async function resetReplayStore(): Promise<void> {
  await currentReplayStore().reset();
}
