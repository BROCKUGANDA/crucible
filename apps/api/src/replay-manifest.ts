/**
 * @file replay-manifest.ts — Replay manifest system (Phase 2).
 *
 * Every evaluation run captures a reproducibility manifest containing all
 * inputs, configurations, and outputs required for independent replay.
 * Three independent replays are required before a verdict stands as verified.
 */

import { createHash, randomUUID } from "node:crypto";

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
  createdAt: number;
}

export interface ReplayRecord {
  replayId: string;
  manifestId: string;
  replayNumber: number; // 1, 2, or 3
  workerIdentity: string;
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
/* In-memory store                                                    */
/* ------------------------------------------------------------------ */

interface ReplayStore {
  manifests: Map<string, ReplayManifest>;
  replays: Map<string, ReplayRecord>;
}

const store: ReplayStore = {
  manifests: new Map(),
  replays: new Map(),
};

/* ------------------------------------------------------------------ */
/* Manifest operations                                                */
/* ------------------------------------------------------------------ */

export function createReplayManifest(
  input: CreateReplayManifestInput,
): ReplayManifest {
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

  store.manifests.set(manifestId, manifest);
  return manifest;
}

export function getReplayManifest(manifestId: string): ReplayManifest | undefined {
  return store.manifests.get(manifestId);
}

export function listManifestsByTrial(trialId: string): ReplayManifest[] {
  const manifests: ReplayManifest[] = [];
  for (const [, manifest] of store.manifests) {
    if (manifest.trialId === trialId) manifests.push(manifest);
  }
  return manifests;
}

export function listManifestsByRun(runId: string): ReplayManifest[] {
  const manifests: ReplayManifest[] = [];
  for (const [, manifest] of store.manifests) {
    if (manifest.runId === runId) manifests.push(manifest);
  }
  return manifests;
}

/* ------------------------------------------------------------------ */
/* Replay operations                                                  */
/* ------------------------------------------------------------------ */

export function createReplayRecord(
  manifestId: string,
  replayNumber: number,
  workerIdentity: string,
): ReplayRecord {
  const manifest = store.manifests.get(manifestId);
  if (!manifest) {
    throw new Error(`Manifest "${manifestId}" not found`);
  }

  if (replayNumber < 1 || replayNumber > 3) {
    throw new Error("replayNumber must be 1, 2, or 3");
  }

  // Check for duplicate replay number
  for (const [, record] of store.replays) {
    if (record.manifestId === manifestId && record.replayNumber === replayNumber) {
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
    startTimestamp: now,
    status: "PENDING",
    createdAt: now,
  };

  store.replays.set(replayId, record);
  return record;
}

export function completeReplay(
  replayId: string,
  outputHash: string,
): ReplayRecord {
  const record = store.replays.get(replayId);
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

  store.replays.set(replayId, completed);

  // Update manifest reproducibility state
  updateReproducibilityState(record.manifestId);

  return completed;
}

export function failReplay(replayId: string, reason: string): ReplayRecord {
  const record = store.replays.get(replayId);
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

  store.replays.set(replayId, failed);
  updateReproducibilityState(record.manifestId);

  return failed;
}

export function getReplayRecord(replayId: string): ReplayRecord | undefined {
  return store.replays.get(replayId);
}

export function listReplaysByManifest(manifestId: string): ReplayRecord[] {
  const replays: ReplayRecord[] = [];
  for (const [, record] of store.replays) {
    if (record.manifestId === manifestId) replays.push(record);
  }
  return replays.sort((a, b) => a.replayNumber - b.replayNumber);
}

/* ------------------------------------------------------------------ */
/* Reproducibility state computation                                  */
/* ------------------------------------------------------------------ */

function updateReproducibilityState(manifestId: string): void {
  const replays = listReplaysByManifest(manifestId);
  const completed = replays.filter((r) => r.status === "COMPLETED");
  const failed = replays.filter((r) => r.status === "FAILED");

  const manifest = store.manifests.get(manifestId);
  if (!manifest) return;

  let state: ReproducibilityState;

  if (failed.length > 0 && completed.length === 0) {
    state = "FAILED";
  } else if (completed.length >= 3) {
    // Check if all three agree
    const hashes = completed.map((r) => r.outputHash).filter(Boolean) as string[];
    const allAgree = hashes.length > 0 && hashes.every((h) => h === hashes[0]);
    state = allAgree ? "REPRODUCIBLE" : "INCONCLUSIVE";
  } else if (completed.length > 0) {
    state = "PENDING";
  } else {
    state = "PENDING";
  }

  const updated = { ...manifest, reproducibilityState: state };
  store.manifests.set(manifestId, updated);
}

/**
 * Check if a manifest has three agreeing replays.
 */
export function isVerified(manifestId: string): boolean {
  const manifest = store.manifests.get(manifestId);
  if (!manifest) return false;
  return manifest.reproducibilityState === "REPRODUCIBLE";
}

/* ------------------------------------------------------------------ */
/* Store access for testing                                         */
/* ------------------------------------------------------------------ */

export function getReplayStore(): ReplayStore {
  return store;
}

export function resetReplayStore(): void {
  store.manifests.clear();
  store.replays.clear();
}
