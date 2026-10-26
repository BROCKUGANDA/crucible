import { describe, expect, it } from "vitest";
import { checkLeakage, pipelineWithLeakageCheck } from "../src/linter.js";
import type { CanonicalRow } from "../src/canonical.js";
import type { SplitAssignment } from "../src/splits.js";

function row(id: string, fields: Record<string, unknown>): CanonicalRow {
  return { rowId: id, fields, modality: [] };
}

function assignment(id: string, split: "train" | "dev" | "holdout"): SplitAssignment {
  return { rowId: id, bucket: 0, role: split };
}

describe("leakage linter debug (gate 751)", () => {
  it("debug exact duplicate detection", () => {
    const assignments: SplitAssignment[] = [
      assignment("r1", "train"),
      assignment("r2", "train"),
      assignment("r4", "dev"),
      assignment("r5", "dev"),
    ];
    const rows = [
      row("r1", { x: "the quick brown fox", y: "1" }),
      row("r2", { x: "jumps over the lazy dog", y: "0" }),
      row("r4", { x: "the quick brown fox", y: "1" }),
      row("r5", { x: "hello world", y: "1" }),
    ];
    
    console.log("Assignments:", JSON.stringify(assignments));
    console.log("Rows:", rows.map(r => ({ id: r.rowId, fields: r.fields })));
    
    const result = checkLeakage(assignments, rows);
    console.log("Result:", JSON.stringify({ clean: result.clean, violations: result.violations.map(v => ({ rowId: v.rowId, splitA: v.splitA, splitB: v.splitB, similarity: v.similarity, matchType: v.matchType })) }));
    
    expect(result.clean).toBe(false);
    expect(result.violations.length).toBe(1);
  });
});
