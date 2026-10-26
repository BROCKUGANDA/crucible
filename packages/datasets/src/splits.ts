/**
 * Gate 749 — Deterministic split engine.
 *
 * Splits are derived, never stored. The manifest declares a canonical split key
 * (e.g. `system_id`, `subject_id`) so rows are grouped, not shuffled — that's the
 * anti-leakage baseline. The split is a pure function:
 *   bucket = sha256(split_key || datasetId || seed) mod 1000
 * thresholds → train/dev/holdout.
 *
 * Seed and split-function version are pinned in the manifest. Anyone recomputes
 * the same split forever; there is nothing to trust, only to verify.
 */

import { sha256 } from "@crucible/crypto";
import type { DatasetManifest } from "./registry.js";

/** Split roles. */
export type SplitRole = "train" | "dev" | "holdout";

/** Thresholds (per-1000 buckets): train < 600, dev < 850, holdout = rest. */
export const TRAIN_LIMIT = 600;
export const DEV_LIMIT = 850;

/** The split-function version pinned in manifests. Changing this requires a new manifest version. */
export const SPLIT_FUNCTION_VERSION = 1;

/** A single row's split assignment. */
export interface SplitAssignment {
  rowId: string;
  bucket: number; // 0..999
  role: SplitRole;
}

/**
 * Compute the bucket for a row: sha256(split_key || datasetId || seed) mod 1000.
 * Deterministic, order-independent, reproducible across runs and processes.
 */
export function rowBucket(
  splitKey: string,
  datasetId: string,
  seed: string,
): number {
  const input = `${splitKey}|${datasetId}|${seed}|${SPLIT_FUNCTION_VERSION}`;
  const digest = sha256(input);
  // First 8 hex chars = 32 bits; mod 1000 gives a uniform bucket.
  return parseInt(digest.slice(0, 8), 16) % 1000;
}

/** Assign a split role from a bucket. */
export function bucketToRole(bucket: number): SplitRole {
  if (bucket < TRAIN_LIMIT) return "train";
  if (bucket < DEV_LIMIT) return "dev";
  return "holdout";
}

/**
 * Assign split roles to a set of rows. Each row is identified by its split-key
 * value (e.g. system_id). All rows sharing the same split key get the same role
 * — groups are never split across train/dev/holdout.
 */
export function assignSplits(
  splitKeys: string[],
  datasetId: string,
  seed: string,
): SplitAssignment[] {
  return splitKeys.map((key) => {
    const bucket = rowBucket(key, datasetId, seed);
    return { rowId: key, bucket, role: bucketToRole(bucket) };
  });
}

/** Count rows per role. */
export function roleCounts(assignments: SplitAssignment[]): {
  train: number;
  dev: number;
  holdout: number;
} {
  const counts = { train: 0, dev: 0, holdout: 0 };
  for (const a of assignments) {
    counts[a.role] += 1;
  }
  return counts;
}

/** Extract the row keys assigned to a given role. */
export function rowsForRole(
  assignments: SplitAssignment[],
  role: SplitRole,
): string[] {
  return assignments
    .filter((a) => a.role === role)
    .map((a) => a.rowId)
    .sort();
}

/**
 * Verify that a split assignment set is a clean partition: every row appears
 * exactly once, and no row key appears in two roles.
 */
export function verifyPartition(
  assignments: SplitAssignment[],
  expectedKeys: string[],
): boolean {
  const assignedKeys = assignments.map((a) => a.rowId).sort();
  const expected = [...expectedKeys].sort();
  if (assignedKeys.length !== expected.length) return false;
  for (let i = 0; i < assignedKeys.length; i++) {
    if (assignedKeys[i] !== expected[i]) return false;
  }
  // No role duplication: each key has exactly one assignment.
  const seen = new Set<string>();
  for (const a of assignments) {
    if (seen.has(a.rowId)) return false;
    seen.add(a.rowId);
  }
  return true;
}

/** A manifest-declared split configuration. */
export interface SplitConfig {
  /** The field name used as the split key (e.g. "system_id"). */
  splitKey: string;
  /** The seed pinned in the manifest. */
  seed: string;
  /** Train threshold (per-1000). Default 600. */
  trainLimit?: number;
  /** Dev threshold (per-1000). Default 850. */
  devLimit?: number;
}

export interface SplitEngine {
  datasetId: string;
  config: SplitConfig;
  /** Assign roles to rows keyed by split-key value. */
  assign(splitKeys: string[]): SplitAssignment[];
  /** The bucket for a single split-key value. */
  bucketFor(splitKey: string): number;
  /** The role for a single split-key value. */
  roleFor(splitKey: string): SplitRole;
}

/** Build a split engine from a manifest's split config. */
export function createSplitEngine(
  datasetId: string,
  config: SplitConfig,
): SplitEngine {
  const trainLimit = config.trainLimit ?? TRAIN_LIMIT;
  const devLimit = config.devLimit ?? DEV_LIMIT;
  return {
    datasetId,
    config,
    assign: (splitKeys) => assignSplits(splitKeys, datasetId, config.seed),
    bucketFor: (splitKey) => rowBucket(splitKey, datasetId, config.seed),
    roleFor: (splitKey) => bucketToRole(rowBucket(splitKey, datasetId, config.seed)),
  };
}

/** Train/split/holdout thresholds from a SplitConfig. */
export function thresholds(config: SplitConfig): {
  trainLimit: number;
  devLimit: number;
} {
  return { trainLimit: config.trainLimit ?? TRAIN_LIMIT, devLimit: config.devLimit ?? DEV_LIMIT };
}
