import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Arena } from "../src/eval/arena.js";
import { StubModelAdapter } from "../src/eval/adapters/stub.js";
import { FileEvalCache } from "../src/eval/cache-file.js";
import { corpusEpochOf } from "../src/eval/scorer.js";
import { smokeSet, suiteEpoch } from "../src/eval/suites.js";
import type { Artifact, ModelAdapter } from "../src/eval/types.js";

const SMOKE_EPOCH = suiteEpoch(smokeSet());
const THRESHOLDS = { maxFalsePassRate: 0.01, maxP95LatencyMs: 20_000 };

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

/**
 * An adapter that measures what it returns, and counts the calls it took to do it.
 *
 * It answers every artifact with that artifact's own gold label so accuracy, kappa and the
 * false-pass gate all stay out of the way: these tests are about the two figures the arena used to
 * overwrite, not about a model being right.
 */
function measuring(
  id: string,
  latencyMs: number,
  confidence: number,
  calls = { n: 0 },
): ModelAdapter & { calls: { n: number } } {
  return {
    id,
    calls,
    async grade(artifact: Artifact) {
      calls.n += 1;
      return { verdict: artifact.expectedVerdict, confidence, latencyMs, promptVersion: "v1" };
    },
  };
}

/** A short slice of the real corpus: same generator, same suite name, fewer calls per test. */
function slice(n: number): () => Artifact[] {
  const artifacts = smokeSet().slice(0, n);
  return () => artifacts;
}

describe("the row carries what the adapter measured", () => {
  /**
   * `maxP95LatencyMs` is documented in `SmokeThresholds` as a hard disqualifier. It could not
   * disqualify anything, because the arena wrote `latencyMs: 0` into every result regardless of what
   * the adapter returned — so `p95` was always 0 and `0 > 20000` is never true. A threshold no
   * input can trip is decoration, and this is the test that says so.
   */
  it("disqualifies a model that is too slow, which it could not do while latency was a literal", async () => {
    const arena = new Arena();
    const scorecard = await arena.runSmoke([measuring("slow", 25_000, 0.9)], { smoke: slice(5) }, 1, THRESHOLDS);

    const row = scorecard.rows[0]!;
    expect(row.avgLatencyMs).toBe(25_000);
    expect(row.p95LatencyMs).toBe(25_000);
    expect(row.disqualified).toBe(true);
    expect(row.disqualifyReason).toBe("p95 latency 25000ms > 20000ms");
  });

  it("keeps a model that answers inside the latency budget", async () => {
    const arena = new Arena();
    const scorecard = await arena.runSmoke([measuring("brisk", 1_200, 0.9)], { smoke: slice(5) }, 1, THRESHOLDS);

    const row = scorecard.rows[0]!;
    expect(row.p95LatencyMs).toBe(1_200);
    expect(row.disqualified).toBe(false);
    expect(row.disqualifyReason).toBeUndefined();
  });

  it("reports a distribution of call times, not one figure counted twenty times", async () => {
    const arena = new Arena();
    let n = 0;
    const uneven: ModelAdapter = {
      id: "uneven",
      async grade(artifact: Artifact) {
        // Two slow calls in twenty, not one. `p95` ranks at `ceil(0.95 * n) - 1`, so with a single
        // outlier in twenty the 95th percentile is still a fast call and the gate does not fire —
        // which is the percentile being right about the distribution, not the measurement being
        // absent. The mean has to sit below the p95 for the row to be a spread rather than a
        // constant repeated.
        const latencyMs = (n += 1) % 10 === 0 ? 30_000 : 100;
        return { verdict: artifact.expectedVerdict, confidence: 0.9, latencyMs, promptVersion: "v1" };
      },
    };

    const row = (await arena.runSmoke([uneven], { smoke: slice(20) }, 1, THRESHOLDS)).rows[0]!;
    expect(row.avgLatencyMs).toBe(3_090);
    expect(row.avgLatencyMs).toBeLessThan(row.p95LatencyMs);
    expect(row.p95LatencyMs).toBe(30_000);
    expect(row.disqualifyReason).toBe("p95 latency 30000ms > 20000ms");
  });

  /**
   * Two gates fire on one row and the row has to name both. The first scorecard measured against a
   * real provider published `false-pass rate 22.22% > 1.00%` on a row whose p95 was 268638ms against
   * a 20000ms budget; a precedence chain named the first and dropped the second, so the row invited
   * a reader to fix one gate and expect the model to qualify.
   *
   * `smokeSet` cycles PASS/VOID/FAIL, so an adapter that answers PASS to everything false-passes
   * every artifact that did not expect one — the first five carry three.
   */
  it("names every gate that fired, not the first in precedence order", async () => {
    const liar: ModelAdapter = {
      id: "liar-and-slow",
      async grade() {
        return { verdict: "PASS", confidence: 0.9, latencyMs: 25_000, promptVersion: "v1" };
      },
    };

    const row = (await new Arena().runSmoke([liar], { smoke: slice(5) }, 1, THRESHOLDS)).rows[0]!;
    // Both premises asserted, so the test cannot pass by tripping only one gate.
    expect(row.falsePassRate).toBeGreaterThan(THRESHOLDS.maxFalsePassRate);
    expect(row.p95LatencyMs).toBeGreaterThan(THRESHOLDS.maxP95LatencyMs);
    expect(row.disqualified).toBe(true);
    expect(row.disqualifyReason).toContain("false-pass rate 60.00% > 1.00%");
    expect(row.disqualifyReason).toContain("p95 latency 25000ms > 20000ms");
  });
});

/**
 * The warm tier, through the arena rather than through `gradeCached` directly.
 *
 * `Arena`'s constructor used to be typed to `MemoryEvalCache`, the concrete hot tier, so
 * `FileEvalCache` had no production caller: a tournament paid for itself again on every run, and the
 * file-backed tier was exercised only by its own unit tests. Widening the seam to `EvalCache` is
 * unproven until something runs an arena against a file.
 */
describe("the arena runs against the warm tier", () => {
  function tempFile(): string {
    return join(mkdtempSync(join(tmpdir(), "arena-cache-")), "eval.jsonl");
  }

  it("answers a second process from the file, making no calls and keeping the figures it stored", async () => {
    const file = tempFile();

    const first = measuring("warm", 7, 0.9);
    await new Arena(FileEvalCache.open(file)).runSmoke([first], { smoke: slice(4) }, 1, THRESHOLDS);
    expect(first.calls.n).toBe(4);

    // A fresh cache object over the same file is a fresh process's view: nothing in memory, the
    // whole tournament on disk. The adapter counts calls, so "made none" is observed, not assumed.
    const second = measuring("warm", 7, 0.9);
    const scorecard = await new Arena(FileEvalCache.open(file)).runSmoke(
      [second],
      { smoke: slice(4) },
      1,
      THRESHOLDS,
    );

    expect(second.calls.n).toBe(0);
    const row = scorecard.rows[0]!;
    expect(row.n).toBe(4);
    // Replayed, not re-measured: the latency is the one the first run's calls produced, which is
    // what a cache hit means at this layer — the same fact a previous run paid for.
    expect(row.p95LatencyMs).toBe(7);
    expect(row.disqualified).toBe(false);
  });

  it("still calls the model on a draw the file cannot answer", async () => {
    const file = tempFile();
    const suite = slice(4);

    const first = measuring("warm", 7, 0.9);
    await new Arena(FileEvalCache.open(file)).runSmoke([first], { smoke: suite }, 1, THRESHOLDS);

    // Relabelled, so the epoch moves and every key misses. Same suite name, same claim hashes — the
    // case a name-keyed cache would have answered from the old exam.
    const relabelled = (): Artifact[] =>
      suite().map((a) => ({ ...a, expectedVerdict: a.expectedVerdict === "PASS" ? "VOID" : "PASS" }));

    const second = measuring("warm", 7, 0.9);
    await new Arena(FileEvalCache.open(file)).runSmoke([second], { smoke: relabelled }, 1, THRESHOLDS);
    expect(second.calls.n).toBe(4);
  });
});
