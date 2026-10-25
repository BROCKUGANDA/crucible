import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileEvalCache } from "../src/eval/cache-file.js";
import { cacheKey, gradeCached, type CacheKey } from "../src/eval/cache.js";
import { suiteEpoch } from "../src/eval/suites.js";
import type { Artifact, EvalResult, ModelAdapter } from "../src/eval/types.js";

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "eval-cache-")), "cache.jsonl");
}

function artifact(): Artifact {
  // The tier `smokeSet` gives this payload shape: see `tiers.test.ts`.
  return {
    claimHash: "0xclaim",
    suite: "smoke",
    expectedVerdict: "PASS",
    payload: { kind: "run-artifact" },
    tier: "competence",
    difficulty: "routine",
  };
}

const EPOCH = suiteEpoch([artifact()]);
const KEY = cacheKey("0xclaim", "stub-model", "pv7", EPOCH);

function result(over: Partial<EvalResult> = {}): EvalResult {
  return {
    claimHash: "0xclaim",
    modelId: "stub-model",
    promptVersion: "pv7",
    suite: "smoke",
    suiteEpoch: EPOCH,
    expected: "PASS",
    actual: "PASS",
    confidence: 0.9,
    correct: true,
    falsePass: false,
    falseFail: false,
    latencyMs: 12,
    killed: false,
    // Carried the way the arena carries it: a cached record says what tier it was earned in.
    tier: "competence",
    difficulty: "routine",
    ...over,
  };
}

/**
 * The hot tier is `MemoryEvalCache`, and it is honest about what it is: one run. These tests are
 * about the two tiers a tournament actually needs and did not have — warm (the file survives the
 * process, so a paid run can be re-scored) and cold (a run that opens the file and calls no
 * adapter at all). Every assertion goes through `gradeCached`, the same function the arena uses,
 * because a test of `set`/`get` alone would stay green over a runner that never consults a cache.
 */
describe("FileEvalCache — the warm tier", () => {
  it("survives the process: a second open answers what the first wrote", () => {
    const file = tempFile();
    FileEvalCache.open(file).set(KEY, result({ confidence: 0.42 }));

    const reopened = FileEvalCache.open(file);
    expect(reopened.get(KEY)?.confidence).toBe(0.42);
    expect(reopened.size).toBe(1);
    expect(reopened.corruptLines).toBe(0);
  });

  it("appends rather than rewrites, and the latest line wins", () => {
    const file = tempFile();
    const cache = FileEvalCache.open(file);
    cache.set(KEY, result({ actual: "FAIL" }));
    cache.set(KEY, result({ actual: "PASS" }));

    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
    expect(FileEvalCache.open(file).get(KEY)?.actual).toBe("PASS");
  });

  it("treats an absent file as an empty cache, not an error", () => {
    const file = tempFile();
    const cache = FileEvalCache.open(file);
    expect(cache.size).toBe(0);
    expect(cache.corruptLines).toBe(0);
    expect(cache.has(KEY)).toBe(false);
  });
});

describe("FileEvalCache — the cold tier", () => {
  it("replays through gradeCached without calling the adapter", async () => {
    const file = tempFile();
    const adapter: ModelAdapter = {
      id: "stub-model",
      grade: vi.fn(async () => ({ verdict: "PASS", confidence: 0.8, latencyMs: 5, promptVersion: "pv7" })),
    };

    const first = FileEvalCache.open(file);
    const fresh = await gradeCached(first, adapter, artifact(), "pv7", EPOCH, () => adapter.grade(artifact(), "pv7"));
    expect(fresh.cached).toBe(false);
    expect(adapter.grade).toHaveBeenCalledTimes(1);

    const replayed = FileEvalCache.open(file);
    const second = await gradeCached(replayed, adapter, artifact(), "pv7", EPOCH, () => adapter.grade(artifact(), "pv7"));
    expect(second.cached).toBe(true);
    expect(second.verdict).toBe("PASS");
    expect(adapter.grade).toHaveBeenCalledTimes(1);
  });

  /**
   * The warm tier is the dangerous one: it survives the process, so a stale hit is not a nuisance
   * in this run but a published number in the next. Same file, same claim hash, same prompt —
   * a re-cut corpus must cost a real model call.
   */
  it("does not replay a paid verdict into a corpus that changed after it was paid for", async () => {
    const file = tempFile();
    const adapter: ModelAdapter = {
      id: "stub-model",
      grade: vi.fn(async () => ({ verdict: "PASS", confidence: 0.8, latencyMs: 5, promptVersion: "pv7" })),
    };

    await gradeCached(FileEvalCache.open(file), adapter, artifact(), "pv7", EPOCH, () =>
      adapter.grade(artifact(), "pv7"),
    );
    expect(adapter.grade).toHaveBeenCalledTimes(1);

    const recut = suiteEpoch([{ ...artifact(), expectedVerdict: "VOID" }]);
    const next = await gradeCached(FileEvalCache.open(file), adapter, artifact(), "pv7", recut, () =>
      adapter.grade(artifact(), "pv7"),
    );

    expect(next.cached).toBe(false);
    expect(adapter.grade).toHaveBeenCalledTimes(2);
  });
});

describe("FileEvalCache refuses what it cannot vouch for", () => {
  it("counts a torn or unparsable line instead of dropping it silently, and keeps the good ones", () => {
    const file = tempFile();
    FileEvalCache.open(file).set(KEY, result());
    appendFileSync(file, '{"key": {"claimHash": "0xclaim"', "utf8");

    const reopened = FileEvalCache.open(file);
    expect(reopened.size).toBe(1);
    expect(reopened.corruptLines).toBe(1);
    expect(reopened.get(KEY)).not.toBeNull();
  });

  it("rejects a line filed under a key it does not describe", () => {
    const file = tempFile();
    const lying = { key: KEY, value: result({ modelId: "different-model" }) };
    writeFileSync(file, `${JSON.stringify(lying)}\n`, "utf8");

    const cache = FileEvalCache.open(file);
    expect(cache.corruptLines).toBe(1);
    expect(cache.get(KEY)).toBeNull();
  });

  it("rejects a line filed under an epoch it does not describe", () => {
    const file = tempFile();
    const lying = { key: KEY, value: result({ suiteEpoch: suiteEpoch([artifact(), artifact()]) }) };
    writeFileSync(file, `${JSON.stringify(lying)}\n`, "utf8");

    const cache = FileEvalCache.open(file);
    expect(cache.corruptLines).toBe(1);
    expect(cache.get(KEY)).toBeNull();
  });

  /**
   * Not migrated, not defaulted. A file written before the key carried `suiteEpoch` cannot be
   * repaired after the fact — the epoch is a digest of artifacts that are gone — so guessing one
   * would file last generation's verdicts under this generation's exam. The whole file reads as
   * corrupt, which is a loud number on `corruptLines` rather than a plausible cache hit.
   */
  it("counts a pre-epoch line as corrupt rather than adopting it", () => {
    const file = tempFile();
    const preEpoch = {
      key: { claimHash: "0xclaim", modelId: "stub-model", promptVersion: "pv7" },
      value: (() => {
        const { suiteEpoch: _drop, ...rest } = result();
        return rest;
      })(),
    };
    writeFileSync(file, `${JSON.stringify(preEpoch)}\n`, "utf8");

    const cache = FileEvalCache.open(file);
    expect(cache.corruptLines).toBe(1);
    expect(cache.size).toBe(0);
    expect(cache.get(KEY)).toBeNull();
  });

  it("keeps entries that do describe themselves", () => {
    const file = tempFile();
    const honest: { key: CacheKey; value: EvalResult } = { key: KEY, value: result() };
    writeFileSync(file, `${JSON.stringify(honest)}\n`, "utf8");

    const cache = FileEvalCache.open(file);
    expect(cache.corruptLines).toBe(0);
    expect(cache.get(KEY)?.actual).toBe("PASS");
  });
});
