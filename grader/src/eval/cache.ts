import type { Artifact, EvalResult, ModelVerdict } from "./types.js";

/**
 * Eval cache keyed by (claimHash, model, promptVersion) — every number comparable forever.
 * A prompt change or a model swap yields a new cache key; old numbers stay comparable.
 */
export interface EvalCache {
  get(key: CacheKey): EvalResult | null;
  set(key: CacheKey, result: EvalResult): void;
  has(key: CacheKey): boolean;
  size: number;
}

export interface CacheKey {
  claimHash: string;
  modelId: string;
  promptVersion: string;
}

export function cacheKey(claimHash: string, modelId: string, promptVersion: string): CacheKey {
  return { claimHash, modelId, promptVersion };
}

export function cacheKeyString(key: CacheKey): string {
  return `${key.claimHash}::${key.modelId}::${key.promptVersion}`;
}

/** In-memory eval cache. Persistent deployments swap the backing store; the key shape is locked. */
export class MemoryEvalCache implements EvalCache {
  private store = new Map<string, { key: CacheKey; value: EvalResult }>();

  get(key: CacheKey): EvalResult | null {
    return this.store.get(cacheKeyString(key))?.value ?? null;
  }

  set(key: CacheKey, result: EvalResult): void {
    this.store.set(cacheKeyString(key), { key, value: result });
  }

  has(key: CacheKey): boolean {
    return this.store.has(cacheKeyString(key));
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  entries(): IterableIterator<[CacheKey, EvalResult]> {
    const inner = this.store.values()[Symbol.iterator]() as Iterator<{ key: CacheKey; value: EvalResult }>;
    return {
      [Symbol.iterator](): IterableIterator<[CacheKey, EvalResult]> {
        return this;
      },
      next(): IteratorResult<[CacheKey, EvalResult]> {
        const { done, value } = inner.next();
        if (done) return { value: undefined as unknown as [CacheKey, EvalResult], done: true };
        return { value: [value.key, value.value], done: false };
      },
    };
  }
}

/** Grade an artifact through a model adapter, honoring the eval cache. */
export async function gradeCached(
  cache: EvalCache,
  adapter: { id: string },
  artifact: Artifact,
  promptVersion: string,
  grade: () => Promise<ModelVerdict>,
): Promise<ModelVerdict & { cached: boolean }> {
  const key = cacheKey(artifact.claimHash, adapter.id, promptVersion);
  const existing = cache.get(key);
  if (existing) {
    return {
      verdict: existing.actual,
      confidence: existing.confidence,
      latencyMs: existing.latencyMs,
      promptVersion,
      cached: true,
    };
  }

  const verdict = await grade();
  cache.set(key, {
    claimHash: artifact.claimHash,
    modelId: adapter.id,
    promptVersion,
    suite: artifact.suite,
    expected: artifact.expectedVerdict,
    actual: verdict.verdict,
    confidence: verdict.confidence,
    correct: verdict.verdict === artifact.expectedVerdict,
    falsePass: verdict.verdict === "PASS" && artifact.expectedVerdict !== "PASS",
    falseFail: verdict.verdict !== "PASS" && artifact.expectedVerdict === "PASS",
    latencyMs: verdict.latencyMs,
    killed: false,
  });

  return { ...verdict, cached: false };
}
