import { describe, expect, it } from "vitest";
import { MemoryEvalCache, cacheKey, cacheKeyString, gradeCached } from "../src/eval/cache.js";
import { suiteEpoch } from "../src/eval/suites.js";
import type { Artifact, ModelVerdict, SuiteEpoch } from "../src/eval/types.js";

const PASS = "PASS" as const;
const VOID = "VOID" as const;

const artifact: Artifact = {
  claimHash: "claim-abc",
  payload: { kind: "run-artifact", index: 1 },
  expectedVerdict: PASS,
  suite: "smoke",
  thresholdBand: "normal",
  // The tier `smokeSet` gives this payload shape: see `tiers.test.ts`.
  tier: "competence",
  difficulty: "routine",
};

const adapter = { id: "stub" };
const promptVersion = "v1";
/** The epoch of the corpus this file actually grades, not a made-up string. */
const EPOCH: SuiteEpoch = suiteEpoch([artifact]);

describe("MemoryEvalCache", () => {
  it("get returns null before set, then the value after set", () => {
    const cache = new MemoryEvalCache();
    const key = cacheKey(artifact.claimHash, adapter.id, promptVersion, EPOCH);
    expect(cache.get(key)).toBeNull();
    expect(cache.has(key)).toBe(false);
    expect(cache.size).toBe(0);

    const result = {
      claimHash: artifact.claimHash,
      modelId: adapter.id,
      promptVersion,
      suite: "smoke",
      suiteEpoch: EPOCH,
      expected: PASS,
      actual: PASS,
      confidence: 0.9,
      correct: true,
      falsePass: false,
      falseFail: false,
      latencyMs: 5,
      killed: false,
    };
    cache.set(key, result);
    expect(cache.get(key)).toBe(result);
    expect(cache.has(key)).toBe(true);
    expect(cache.size).toBe(1);
  });

  it("cacheKeyString is deterministic and collision-resistant", () => {
    const a = cacheKeyString(cacheKey("c1", "m1", "v1", EPOCH));
    const b = cacheKeyString(cacheKey("c1", "m1", "v1", EPOCH));
    const c = cacheKeyString(cacheKey("c1", "m2", "v1", EPOCH));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("clear empties the cache", () => {
    const cache = new MemoryEvalCache();
    cache.set(cacheKey("c1", "m1", "v1", EPOCH), {} as any);
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe("gradeCached", () => {
  it("grades on a cache miss and caches the result", async () => {
    const cache = new MemoryEvalCache();
    let calls = 0;
    const grade = async (): Promise<ModelVerdict> => {
      calls += 1;
      return { verdict: PASS, confidence: 0.9, latencyMs: 10, promptVersion };
    };

    const first = await gradeCached(cache, adapter, artifact, promptVersion, EPOCH, grade);
    expect(first.cached).toBe(false);
    expect(first.verdict).toBe(PASS);
    expect(calls).toBe(1);

    const second = await gradeCached(cache, adapter, artifact, promptVersion, EPOCH, grade);
    expect(second.cached).toBe(true);
    expect(calls).toBe(1); // no re-grade
  });

  it("uses separate cache entries per (claim, model, promptVersion)", async () => {
    const cache = new MemoryEvalCache();
    let calls = 0;
    const grade = async (): Promise<ModelVerdict> => {
      calls += 1;
      return { verdict: PASS, confidence: 0.9, latencyMs: 10, promptVersion };
    };

    await gradeCached(cache, adapter, artifact, "v1", EPOCH, grade);
    await gradeCached(cache, adapter, artifact, "v2", EPOCH, grade);
    expect(calls).toBe(2);
  });

  it("derives falsePass / falseFail / correct from expected vs actual", async () => {
    const cache = new MemoryEvalCache();
    const voidArtifact: Artifact = { ...artifact, expectedVerdict: VOID };
    const grade = async (): Promise<ModelVerdict> => ({ verdict: PASS, confidence: 0.9, latencyMs: 10, promptVersion });

    const res = await gradeCached(cache, adapter, voidArtifact, promptVersion, EPOCH, grade);
    expect(res.verdict).toBe(PASS);
    const stored = cache.get(cacheKey(voidArtifact.claimHash, adapter.id, promptVersion, EPOCH));
    expect(stored!.falsePass).toBe(true);
    expect(stored!.falseFail).toBe(false);
    expect(stored!.correct).toBe(false);
  });

  /**
   * The reason the key has a fourth component. Everything else about these two calls is identical —
   * same claim hash, same model, same prompt — and the answer must still be a fresh draw, because
   * the corpus the claim hash came from is not the corpus it came from before. `smoke-0000` is a
   * literal in `suites.ts`, so a relabelled gold set reuses every old claim hash.
   */
  it("misses on a different suite epoch, even with the same claim and prompt", async () => {
    const cache = new MemoryEvalCache();
    let calls = 0;
    const grade = async (): Promise<ModelVerdict> => {
      calls += 1;
      return { verdict: calls === 1 ? PASS : VOID, confidence: 0.9, latencyMs: 10, promptVersion };
    };

    const relabelled: SuiteEpoch = suiteEpoch([{ ...artifact, expectedVerdict: VOID }]);
    expect(relabelled).not.toBe(EPOCH);

    const first = await gradeCached(cache, adapter, artifact, promptVersion, EPOCH, grade);
    const second = await gradeCached(cache, adapter, artifact, promptVersion, relabelled, grade);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(false);
    expect(calls).toBe(2);
    // The second draw is the second model call, not the first verdict served under a new key.
    expect(second.verdict).toBe(VOID);
    expect(cache.size).toBe(2);
  });

  it("records the epoch it was given on the stored result", async () => {
    const cache = new MemoryEvalCache();
    const grade = async (): Promise<ModelVerdict> => ({ verdict: PASS, confidence: 0.9, latencyMs: 10, promptVersion });

    await gradeCached(cache, adapter, artifact, promptVersion, EPOCH, grade);
    const stored = cache.get(cacheKey(artifact.claimHash, adapter.id, promptVersion, EPOCH));
    expect(stored!.suiteEpoch).toBe(EPOCH);
  });
});
