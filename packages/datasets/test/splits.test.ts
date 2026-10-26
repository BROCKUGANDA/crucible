import { describe, expect, it } from "vitest";
import {
  rowBucket,
  bucketToRole,
  assignSplits,
  roleCounts,
  rowsForRole,
  verifyPartition,
  createSplitEngine,
  thresholds,
  TRAIN_LIMIT,
  DEV_LIMIT,
} from "../src/splits.js";

describe("split engine (gate 749)", () => {
  const datasetId = "0x" + "ab".repeat(32);
  const seed = "canonical-seed-v1";

  it("same split key always yields the same bucket", () => {
    const b1 = rowBucket("system-1", datasetId, seed);
    const b2 = rowBucket("system-1", datasetId, seed);
    expect(b1).toBe(b2);
    expect(b1).toBeGreaterThanOrEqual(0);
    expect(b1).toBeLessThan(1000);
  });

  it("datasetId and seed changes change buckets", () => {
    const a = rowBucket("system-1", datasetId, seed);
    const b = rowBucket("system-1", datasetId, "other-seed");
    const c = rowBucket("system-1", "0x" + "cd".repeat(32), seed);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("bucketToRole maps thresholds correctly", () => {
    expect(bucketToRole(0)).toBe("train");
    expect(bucketToRole(TRAIN_LIMIT - 1)).toBe("train");
    expect(bucketToRole(TRAIN_LIMIT)).toBe("dev");
    expect(bucketToRole(DEV_LIMIT - 1)).toBe("dev");
    expect(bucketToRole(DEV_LIMIT)).toBe("holdout");
    expect(bucketToRole(999)).toBe("holdout");
  });

  it("assignSplits groups rows by split key consistently", () => {
    const keys = ["s-1", "s-2", "s-3", "s-1", "s-2"];
    const assignments = assignSplits(keys, datasetId, seed);
    // Same key → same role every time.
    expect(assignments[0].role).toBe(assignments[3].role);
    expect(assignments[1].role).toBe(assignments[4].role);
    // Every assignment has a valid role.
    for (const a of assignments) {
      expect(["train", "dev", "holdout"]).toContain(a.role);
    }
  });

  it("roleCounts sums to total", () => {
    const assignments = assignSplits(["a", "b", "c", "d", "e"], datasetId, seed);
    const counts = roleCounts(assignments);
    expect(counts.train + counts.dev + counts.holdout).toBe(5);
  });

  it("rowsForRole returns only that role's keys", () => {
    const assignments = assignSplits(["a", "b", "c", "d"], datasetId, seed);
    const trainKeys = rowsForRole(assignments, "train");
    for (const key of trainKeys) {
      const a = assignments.find((x) => x.rowId === key);
      expect(a?.role).toBe("train");
    }
  });

  it("verifyPartition accepts clean partitions and rejects duplicates", () => {
    const assignments = assignSplits(["a", "b", "c"], datasetId, seed);
    expect(verifyPartition(assignments, ["a", "b", "c"])).toBe(true);
    expect(verifyPartition(assignments, ["a", "b"])).toBe(false);
    // Duplicate key in assignments → invalid.
    const dup = [...assignments, { ...assignments[0], rowId: "a" }];
    expect(verifyPartition(dup, ["a", "b", "c"])).toBe(false);
  });

  it("createSplitEngine wraps rowBucket/roleFor", () => {
    const engine = createSplitEngine(datasetId, { splitKey: "system_id", seed });
    const key = "system-42";
    const b = engine.bucketFor(key);
    expect(b).toBe(rowBucket(key, datasetId, seed));
    expect(engine.roleFor(key)).toBe(bucketToRole(b));
    const assigned = engine.assign([key]);
    expect(assigned[0].rowId).toBe(key);
    expect(assigned[0].bucket).toBe(b);
    expect(assigned[0].role).toBe(bucketToRole(b));
  });

  it("thresholds uses defaults", () => {
    expect(thresholds({ splitKey: "k", seed: "s" })).toEqual({
      trainLimit: TRAIN_LIMIT,
      devLimit: DEV_LIMIT,
    });
  });
});
