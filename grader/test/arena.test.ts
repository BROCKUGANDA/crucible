import { describe, expect, it } from "vitest";
import { Arena } from "../src/eval/arena.js";
import { StubModelAdapter } from "../src/eval/adapters/stub.js";
import { corpusEpochOf } from "../src/eval/scorer.js";
import { smokeSet, suiteEpoch } from "../src/eval/suites.js";
import type { Artifact } from "../src/eval/types.js";

const SMOKE_EPOCH = suiteEpoch(smokeSet());

describe("Arena", () => {
  it("runs smoke × model matrix and emits JSONL scorecard rows", async () => {
    const arena = new Arena();
    const adapter = new StubModelAdapter("v1");

    const scorecard = await arena.runSmoke(
      [adapter],
      { smoke: smokeSet },
      1,
      { maxFalsePassRate: 0.01, maxP95LatencyMs: 20_000 },
    );

    expect(scorecard.rows.length).toBeGreaterThan(0);
    const row = scorecard.rows[0];
    expect(row.modelId).toBe("stub");
    expect(row.suite).toBe("smoke");
    expect(row.n).toBe(200);
    expect(row.n).toBeGreaterThan(0);
    expect(typeof row.falsePassRate).toBe("number");
    expect(typeof row.falseFailRate).toBe("number");
    expect(typeof row.kappa).toBe("number");
    expect(typeof row.accuracy).toBe("number");
    expect(scorecard.generatedAt).toBeGreaterThan(0);
  });

  /**
   * The row has to name the exam it scored. Computed here from the same generator the arena calls,
   * not copied as a literal — a hardcoded epoch would stay green over an arena that hashed a
   * constant, or hashed nothing and defaulted the field.
   */
  it("stamps each row with the epoch of the corpus it actually graded", async () => {
    const arena = new Arena();
    const scorecard = await arena.runSmoke(
      [new StubModelAdapter("v1")],
      { smoke: smokeSet },
      1,
      { maxFalsePassRate: 0.01, maxP95LatencyMs: 20_000 },
    );

    expect(SMOKE_EPOCH).toMatch(/^[0-9a-f]{64}$/);
    for (const row of scorecard.rows) {
      expect(row.suiteEpoch).toBe(SMOKE_EPOCH);
    }
    expect(scorecard.corpusEpoch).toBe(corpusEpochOf(scorecard.rows));
  });

  it("scorecard rows serialize to valid JSONL", async () => {
    const arena = new Arena();
    const adapter = new StubModelAdapter("v1");

    const scorecard = await arena.runSmoke([adapter], { smoke: smokeSet }, 1, {
      maxFalsePassRate: 0.01,
      maxP95LatencyMs: 20_000,
    });

    for (const row of scorecard.rows) {
      const line = JSON.stringify(row);
      const obj = JSON.parse(line);
      expect(obj.modelId).toBe(row.modelId);
      expect(obj.suite).toBe(row.suite);
      expect(obj.suiteEpoch).toBe(row.suiteEpoch);
      expect(typeof obj.falsePassRate).toBe("number");
    }
  });

  it("honors the eval cache — repeated run does not re-grade", async () => {
    const arena = new Arena();
    const adapter = new StubModelAdapter("v1");

    await arena.runSmoke([adapter], { smoke: smokeSet }, 1, {
      maxFalsePassRate: 0.01,
      maxP95LatencyMs: 20_000,
    });
    const sizeAfterFirst = arena.getCache().size;
    expect(sizeAfterFirst).toBe(200);

    // Re-running with the same cache should hit cache for every artifact.
    await arena.runSmoke([adapter], { smoke: smokeSet }, 1, {
      maxFalsePassRate: 0.01,
      maxP95LatencyMs: 20_000,
    });
    expect(arena.getCache().size).toBe(sizeAfterFirst);
  });

  /**
   * The other half of the same property. A cache that never misses is not a cache, and the miss
   * that matters is the one nobody would notice: the suite is still called `smoke`, the claim
   * hashes are still `smoke-0000…`, and only the gold labels moved.
   */
  it("re-grades a relabelled corpus that kept its suite name and its claim hashes", async () => {
    const relabelled = (): Artifact[] =>
      smokeSet().map((a) => ({ ...a, expectedVerdict: a.expectedVerdict === "PASS" ? "VOID" : "PASS" }));
    expect(suiteEpoch(relabelled())).not.toBe(SMOKE_EPOCH);
    expect(relabelled()[0]!.claimHash).toBe(smokeSet()[0]!.claimHash);

    const arena = new Arena();
    const adapter = new StubModelAdapter("v1");
    const thresholds = { maxFalsePassRate: 0.01, maxP95LatencyMs: 20_000 };

    await arena.runSmoke([adapter], { smoke: smokeSet }, 1, thresholds);
    expect(arena.getCache().size).toBe(200);

    const second = await arena.runSmoke([adapter], { smoke: relabelled }, 1, thresholds);
    expect(arena.getCache().size).toBe(400);
    expect(second.rows[0]!.suiteEpoch).not.toBe(SMOKE_EPOCH);
  });
});
