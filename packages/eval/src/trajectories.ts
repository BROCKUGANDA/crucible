/**
 * Gate 727 — Trajectories export.
 *
 * Export JSONL training records — one per probe — carrying everything a trainer
 * needs to reconstruct the grading signal without touching the holdout bank:
 *   probe_id, input, output, per-weight score breakdown, verdict, model,
 *   manifest hash.
 *
 * No wall-clock fields (gate 633-style determinism: recorded seeds are
 * non-security determinism seeds, stored beside the runs they seeded).
 */

import { sha256, hashCanonical } from "@crucible/crypto";

export interface TrajectoryRecord {
  probeId: string;
  input: string;
  output: string;
  verdict: "PASS" | "VOID" | "FAIL";
  score: number;
  detail: string;
  modelId: string;
  modelManifestHash: string;
  promptVersion: string;
  weights: Record<string, number>;
  replayStatus: "matched" | "mismatched" | "not-run";
  usageAudited: boolean;
  seed: string; // recorded determinism seed (non-security)
}

/** Hash of a model manifest, used to bind the trajectory to the exact model bytes. */
export function manifestHash(manifest: unknown): string {
  return sha256(hashCanonical(manifest));
}

/** Convert a per-probe runner result into a JSONL training record. */
export function trajectoryFromResult(
  probeId: string,
  input: string,
  output: string,
  verdict: "PASS" | "VOID" | "FAIL",
  score: number,
  detail: string,
  modelId: string,
  manifest: unknown,
  promptVersion: string,
  weights: Record<string, number>,
  replayStatus: "matched" | "mismatched" | "not-run",
  usageAudited: boolean,
  seed: string,
): TrajectoryRecord {
  return {
    probeId,
    input,
    output,
    verdict,
    score,
    detail,
    modelId,
    modelManifestHash: manifestHash(manifest),
    promptVersion,
    weights,
    replayStatus,
    usageAudited,
    seed,
  };
}

/** Serialize a trajectory record as one JSONL line (canonical JCS ordering). */
export function trajectoryToJsonl(record: TrajectoryRecord): string {
  return hashCanonical(record);
}

/** Parse a JSONL line back into a trajectory record. */
export function trajectoryFromJsonl(line: string): TrajectoryRecord {
  return JSON.parse(line) as TrajectoryRecord;
}

/** Export an array of trajectories to JSONL text (one record per line). */
export function exportJsonl(records: TrajectoryRecord[]): string {
  return records.map((r) => trajectoryToJsonl(r)).join("\n") + (records.length ? "\n" : "");
}

/** Parse JSONL text into trajectory records, skipping blank lines. */
export function parseJsonl(text: string): TrajectoryRecord[] {
  const records: TrajectoryRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    records.push(trajectoryFromJsonl(trimmed));
  }
  return records;
}
