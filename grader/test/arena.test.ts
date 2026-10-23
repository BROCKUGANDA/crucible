import { describe, expect, it } from "vitest";
import { Arena } from "../src/eval/arena.js";
import { StubModelAdapter } from "../src/eval/adapters/stub.js";
import { smokeSet } from "../src/eval/suites.js";

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
});
