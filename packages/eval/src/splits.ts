/**
 * Gate 726 — Deterministic train/dev/holdout splits.
 *
 * Contamination rule (hard): the bank used for on-chain verdicts is NEVER a
 * training set. Split banks: train.json, dev.json, holdout.json (holdout =
 * the verdict bank). Split by sha256(probe_id) mod 100 thresholds —
 * reproducible, order-independent.
 *
 * @crucible/crypto is the one crypto door (gate 625): sha256 routes through it.
 */

import { sha256 } from "@crucible/crypto";

export type Split = "train" | "dev" | "holdout";

/** Thresholds: train < 60, dev < 85, holdout = rest (mod 100). */
const TRAIN_LIMIT = 60;
const DEV_LIMIT = 85;

export interface ProbeRecord {
  probeId: string;
  prompt: string;
  expectedVerdict: "PASS" | "VOID" | "FAIL";
  family?: string;
  checkerId?: string;
  [key: string]: unknown;
}

export interface SplitResult {
  train: ProbeRecord[];
  dev: ProbeRecord[];
  holdout: ProbeRecord[];
}

/**
 * Deterministic split by content hash of the probe id. Same probe always lands
 * in the same split; order-independent; reproducible across runs and processes.
 */
export function splitBank(probes: ProbeRecord[]): SplitResult {
  const train: ProbeRecord[] = [];
  const dev: ProbeRecord[] = [];
  const holdout: ProbeRecord[] = [];

  // Sort by probeId so the split is order-independent.
  const ordered = [...probes].sort((a, b) => a.probeId.localeCompare(b.probeId));

  for (const probe of ordered) {
    const digest = sha256(probe.probeId);
    // Take first 8 hex chars = 32 bits; mod 100 gives a uniform bucket.
    const bucket = parseInt(digest.slice(0, 8), 16) % 100;
    if (bucket < TRAIN_LIMIT) {
      train.push(probe);
    } else if (bucket < DEV_LIMIT) {
      dev.push(probe);
    } else {
      holdout.push(probe);
    }
  }

  return { train, dev, holdout };
}

/** Split a bank loaded as JSONL lines (one probe object per line). */
export function splitBankJsonl(lines: string[]): SplitResult {
  const probes: ProbeRecord[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    probes.push(JSON.parse(trimmed) as ProbeRecord);
  }
  return splitBank(probes);
}

/** Verify a split is a partition: every probe appears exactly once. */
export function verifyPartition(
  original: ProbeRecord[],
  split: SplitResult,
): boolean {
  const all = [...split.train, ...split.dev, ...split.holdout];
  if (all.length !== original.length) return false;
  const ids = new Set(original.map((p) => p.probeId));
  for (const p of all) {
    if (!ids.has(p.probeId)) return false;
    ids.delete(p.probeId);
  }
  return ids.size === 0;
}

/** The holdout split is the verdict bank — never trained on (gate 726). */
export function isHoldout(probeId: string): boolean {
  const digest = sha256(probeId);
  const bucket = parseInt(digest.slice(0, 8), 16) % 100;
  return bucket >= DEV_LIMIT;
}
