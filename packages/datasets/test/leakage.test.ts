import { describe, expect, it } from "vitest";
import {
  checkLeakage,
  pipelineWithLeakageCheck,
  DEFAULT_LEAKAGE_CONFIG,
  type LeakageLinterConfig,
  type CanonicalRow,
  type SplitAssignment,
} from "../src/index.js";

function row(id: string, fields: Record<string, unknown>): CanonicalRow {
  return { rowId: id, fields, modality: [] };
}

function assignment(id: string, split: "train" | "dev" | "holdout"): SplitAssignment {
  return { rowId: id, bucket: 0, role: split };
}

describe("leakage linter (gate 751)", () => {
  it("detects exact duplicates across train/dev splits", () => {
    const assignments: SplitAssignment[] = [
      assignment("r1", "train"),
      assignment("r2", "train"),
      assignment("r4", "dev"),
      assignment("r5", "dev"),
    ];
    const rows = [
      row("r1", { x: "the quick brown fox", y: "1" }),
      row("r2", { x: "jumps over the lazy dog", y: "0" }),
      row("r4", { x: "the quick brown fox", y: "1" }), // exact duplicate of r1
      row("r5", { x: "hello world", y: "1" }),
    ];
    const result = checkLeakage(assignments, rows);
    expect(result.clean).toBe(false);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0].rowId).toBe("r1");
    expect(result.violations[0].splitA).toBe("train");
    expect(result.violations[0].splitB).toBe("dev");
    expect(result.violations[0].similarity).toBe(1.0);
    expect(result.violations[0].matchType).toBe("exact");
  });

  it("detects near-duplicates across train/holdout splits", () => {
    const assignments: SplitAssignment[] = [
      assignment("r1", "train"),
      assignment("r2", "train"),
      assignment("r6", "holdout"),
    ];
    const rows = [
      row("r1", { x: "the quick brown fox jumps", y: "1" }),
      row("r2", { x: "jumps over the lazy dog", y: "0" }),
      row("r6", { x: "the quick brown fox jumps over", y: "1" }),
    ];
    const result = checkLeakage(assignments, rows, {
      ...DEFAULT_LEAKAGE_CONFIG,
      similarityThreshold: 0.5,
    });
    expect(result.clean).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    const violation = result.violations.find((v) => v.rowId === "r1");
    expect(violation).toBeDefined();
    expect(violation!.matchType).toBe("near");
    expect(violation!.similarity).toBeGreaterThanOrEqual(0.5);
  });

  it("passes when no duplicates across splits", () => {
    const assignments: SplitAssignment[] = [
      assignment("r1", "train"),
      assignment("r2", "dev"),
    ];
    const cleanRows = [
      row("r1", { x: "the quick brown fox", y: "1" }),
      row("r2", { x: "jumps over the lazy dog", y: "0" }),
    ];
    const result = checkLeakage(assignments, cleanRows);
    expect(result.clean).toBe(true);
    expect(result.violations.length).toBe(0);
  });

  it("pipelineWithLeakageCheck throws on leakage", () => {
    const assignments: SplitAssignment[] = [
      assignment("r1", "train"),
      assignment("r4", "dev"),
    ];
    const result = { dataset: { datasetId: "ds-leaky" } };
    expect(() =>
      pipelineWithLeakageCheck(result, assignments, [
        row("r1", { x: "the quick brown fox", y: "1" }),
        row("r4", { x: "the quick brown fox", y: "1" }),
      ])
    ).toThrow(/leakage detected/i);
  });

  it("pipelineWithLeakageCheck passes when clean", () => {
    const assignments: SplitAssignment[] = [
      assignment("r1", "train"),
      assignment("r2", "dev"),
    ];
    const result = { dataset: { datasetId: "ds-clean" } };
    const outcome = pipelineWithLeakageCheck(result, assignments, [
      row("r1", { x: "the quick brown fox", y: "1" }),
      row("r2", { x: "jumps over the lazy dog", y: "0" }),
    ]);
    expect(outcome.leakage.clean).toBe(true);
    expect(outcome.dataset.datasetId).toBe("ds-clean");
  });

  it("default config threshold is 0.95", () => {
    expect(DEFAULT_LEAKAGE_CONFIG.similarityThreshold).toBe(0.95);
    expect(DEFAULT_LEAKAGE_CONFIG.shingleSize).toBe(3);
    expect(DEFAULT_LEAKAGE_CONFIG.splitPairs).toEqual([
      ["train", "dev"],
      ["train", "holdout"],
      ["dev", "holdout"],
    ]);
  });

  it("custom config threshold is respected", () => {
    const assignments: SplitAssignment[] = [
      assignment("r1", "train"),
      assignment("r6", "holdout"),
    ];
    // With threshold 1.0, only exact duplicates count
    const resultStrict = checkLeakage(assignments, [
      row("r1", { x: "the quick brown fox", y: "1" }),
      row("r6", { x: "the quick brown fox jumps", y: "1" }),
    ], {
      ...DEFAULT_LEAKAGE_CONFIG,
      similarityThreshold: 1.0,
    });
    expect(resultStrict.clean).toBe(true); // "the quick brown fox" != "the quick brown fox jumps"

    // With threshold 0.5, near-duplicates are caught
    // "the quick brown fox jumps" vs "the quick brown fox jumps over": share 3/4 shingles = 0.75
    const resultLenient = checkLeakage(assignments, [
      row("r1", { x: "the quick brown fox jumps", y: "1" }),
      row("r6", { x: "the quick brown fox jumps over", y: "1" }),
    ], {
      ...DEFAULT_LEAKAGE_CONFIG,
      similarityThreshold: 0.5,
    });
    expect(resultLenient.clean).toBe(false); // similarity 0.75 >= 0.5
  });
});
