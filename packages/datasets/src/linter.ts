// SPDX-License-Identifier: UNLICENSED
/**
 * Gate 751 — Leakage linter.
 *
 * Dataset admission gate: probes must not leak across train/dev/holdout split
 * boundaries. Near-duplicate rows (near-identical text content) must not appear
 * in more than one split, otherwise a model could train on near-exact copies of
 * its held-out evaluation probes.
 *
 * Detection tiers:
 *   1. Exact-duplicate hash — identical row text across splits = hard reject
 *   2. Near-duplicate similarity — normalized text similarity >= threshold
 *      (default 0.95 Jaccard on shingled word n-grams) = hard reject
 *
 * Fail-closed: any violation blocks dataset registration. No silent tolerance.
 */

import { sha256 } from "@crucible/crypto";
import type { CanonicalRow } from "./canonical.js";
import type { SplitAssignment } from "./splits.js";

/** Leakage detection result. */
export interface LeakageResult {
  clean: boolean;
  violations: LeakageViolation[];
  rowsScanned: number;
  pairsChecked: string[];
}

/** A single leakage violation: same row content appearing in two splits. */
export interface LeakageViolation {
  rowId: string;
  splitA: string;
  splitB: string;
  similarity: number;
  matchType: "exact" | "near";
}

/** Leakage linter configuration. */
export interface LeakageLinterConfig {
  similarityThreshold: number;
  shingleSize: number;
  splitPairs: [string, string][];
}

export const DEFAULT_LEAKAGE_CONFIG: LeakageLinterConfig = {
  similarityThreshold: 0.95,
  shingleSize: 3,
  splitPairs: [
    ["train", "dev"],
    ["train", "holdout"],
    ["dev", "holdout"],
  ],
};

function normalizeRowFields(fields: Record<string, unknown>): string {
  return Object.values(fields)
    .map((v) => String(v))
    .join(" ")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shingleText(text: string, shingleSize: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const shingles: string[] = [];
  for (let i = 0; i <= words.length - shingleSize; i++) {
    shingles.push(words.slice(i, i + shingleSize).join(" "));
  }
  return shingles;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 1.0;
  return intersection.size / union.size;
}

export function checkLeakage(
  assignments: SplitAssignment[],
  rows: CanonicalRow[],
  config: LeakageLinterConfig = DEFAULT_LEAKAGE_CONFIG,
): LeakageResult {
  const violations: LeakageViolation[] = [];
  const splitPairs = config.splitPairs ?? DEFAULT_LEAKAGE_CONFIG.splitPairs;

  const rowsBySplit: Record<string, CanonicalRow[]> = {};
  for (const row of rows) {
    const assignment = assignments.find((a) => a.rowId === row.rowId);
    if (!assignment) continue;
    const split = assignment.role;
    if (!rowsBySplit[split]) rowsBySplit[split] = [];
    rowsBySplit[split].push(row);
  }

  for (const [splitA, splitB] of splitPairs) {
    const rowsA = rowsBySplit[splitA] ?? [];
    const rowsB = rowsBySplit[splitB] ?? [];

    for (const rowA of rowsA) {
      for (const rowB of rowsB) {
        if (rowA.rowId === rowB.rowId) continue;

        const textA = normalizeRowFields(rowA.fields);
        const textB = normalizeRowFields(rowB.fields);

        let similarity: number;
        let matchType: "exact" | "near";

        if (textA === textB) {
          similarity = 1.0;
          matchType = "exact";
        } else {
          const shinglesA = new Set(shingleText(textA, config.shingleSize));
          const shinglesB = new Set(shingleText(textB, config.shingleSize));
          similarity = jaccardSimilarity(shinglesA, shinglesB);
          matchType = "near";
        }

        if (similarity >= config.similarityThreshold) {
          violations.push({
            rowId: rowA.rowId,
            splitA,
            splitB,
            similarity,
            matchType,
          });
        }
      }
    }
  }

  return {
    violations,
    rowsScanned: rows.length,
    pairsChecked: splitPairs.map(([a, b]) => `${a}-${b}`),
    clean: violations.length === 0,
  };
}

export function pipelineWithLeakageCheck(
  result: { dataset: { datasetId: string } },
  assignments: SplitAssignment[],
  rows: CanonicalRow[],
  config: LeakageLinterConfig = DEFAULT_LEAKAGE_CONFIG,
): { dataset: { datasetId: string }; leakage: LeakageResult } {
  const leakage = checkLeakage(assignments, rows, config);
  if (!leakage.clean) {
    throw new Error(
      `Dataset leakage detected: ${leakage.violations.length} cross-split duplicate(s) found. ` +
        `Violations: ${leakage.violations.map((v) => `${v.rowId} (${v.splitA}↔${v.splitB}, ${(v.similarity * 100).toFixed(1)}% ${v.matchType})`).join(", ")}`,
    );
  }
  return { dataset: result.dataset, leakage };
}
