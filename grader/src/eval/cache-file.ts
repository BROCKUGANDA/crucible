import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  cacheKeyString,
  type CacheKey,
  type EvalCache,
} from "./cache.js";
import type { EvalResult } from "./types.js";

/**
 * The warm and cold tiers of the eval cache.
 *
 * `MemoryEvalCache` is the hot tier: it answers within a run and disappears with the process,
 * so a tournament that costs real money cannot be replayed, compared or audited after the fact —
 * gate 510 asks for a persistent, content-addressed cache and gate 431 for a key every number
 * stays comparable under. This is the same interface, backed by a JSONL file:
 *
 *   hot   — memory, this process, one run
 *   warm  — the file, surviving the process; a second run in the same tournament replays it
 *   cold  — the file opened by a run that calls no adapter at all, which is what a re-scored
 *           or audited tournament is: `gradeCached` returns `cached: true` without a network call
 *
 * Two properties are deliberate.
 *
 * **Append-only.** Every write is one line, so a crash costs at most the line in flight and never
 * rewrites history. Later lines win on load, which makes a corrected verdict a new fact rather
 * than a mutation of an old one.
 *
 * **Nothing is loaded silently.** A line that is not valid JSON, or whose recorded
 * `(claimHash, modelId, promptVersion, suiteEpoch)` disagrees with the key it is filed under, is
 * counted and skipped — counted because a cache that quietly drops entries is a cache that reports
 * a different tournament than the one that ran. `corruptLines` is the number to alert on, and
 * `null` is returned for a key whose line was rejected rather than a guess at its verdict.
 *
 * That policy has a consequence worth stating rather than discovering: a file written before the key
 * carried `suiteEpoch` loads as **entirely corrupt**. It is not migrated and not defaulted, because
 * the epoch is the one component that cannot be recovered after the fact — the artifacts it digests
 * are gone, and guessing one would file an old verdict under a corpus it was never computed
 * against, which is the exact error the component exists to prevent.
 */
export class FileEvalCache implements EvalCache {
  private store = new Map<string, { key: CacheKey; value: EvalResult }>();
  private corrupt = 0;

  private constructor(private readonly file: string) {}

  /**
   * Open (or create) the cache file. An absent file is an empty cache, not an error: the first
   * run of a tournament has nothing to replay, and refusing to start would make the warm tier
   * a prerequisite for the cold one.
   */
  static open(file: string): FileEvalCache {
    const cache = new FileEvalCache(file);
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) return cache;

    const text = readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A torn final line is the expected shape of a crash mid-append; a torn middle line is
        // corruption. Neither is guessed at, and both are counted.
        cache.corrupt += 1;
        continue;
      }
      const entry = parsed as { key?: CacheKey; value?: EvalResult };
      if (!isKey(entry.key) || !isResult(entry.value)) {
        cache.corrupt += 1;
        continue;
      }
      if (cacheKeyString(entry.key) !== keyOfResult(entry.value)) {
        // The file is content-addressed: the key IS the record. A line filed under a key it does
        // not describe would answer a question about model B with model A's verdict.
        cache.corrupt += 1;
        continue;
      }
      cache.store.set(cacheKeyString(entry.key), { key: entry.key, value: entry.value });
    }
    return cache;
  }

  get(key: CacheKey): EvalResult | null {
    return this.store.get(cacheKeyString(key))?.value ?? null;
  }

  set(key: CacheKey, result: EvalResult): void {
    const id = cacheKeyString(key);
    this.store.set(id, { key, value: result });
    appendFileSync(this.file, `${JSON.stringify({ key, value: result })}\n`, "utf8");
  }

  has(key: CacheKey): boolean {
    return this.store.has(cacheKeyString(key));
  }

  get size(): number {
    return this.store.size;
  }

  /** Lines this cache refused to load. Non-zero means the file is not the tournament it claims. */
  get corruptLines(): number {
    return this.corrupt;
  }

  entries(): IterableIterator<[CacheKey, EvalResult]> {
    const values = [...this.store.values()];
    let i = 0;
    return {
      [Symbol.iterator](): IterableIterator<[CacheKey, EvalResult]> {
        return this;
      },
      next(): IteratorResult<[CacheKey, EvalResult]> {
        if (i >= values.length) {
          return { value: undefined as unknown as [CacheKey, EvalResult], done: true };
        }
        const { key, value } = values[i++]!;
        return { value: [key, value], done: false };
      },
    };
  }
}

function isKey(value: unknown): value is CacheKey {
  if (typeof value !== "object" || value === null) return false;
  const k = value as Partial<CacheKey>;
  return (
    typeof k.claimHash === "string" &&
    typeof k.modelId === "string" &&
    typeof k.promptVersion === "string" &&
    typeof k.suiteEpoch === "string"
  );
}

function isResult(value: unknown): value is EvalResult {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<EvalResult>;
  return (
    typeof r.claimHash === "string" &&
    typeof r.actual === "string" &&
    // The record has to carry its own epoch, or `keyOfResult` cannot reconstruct the key it is
    // filed under — and a key that cannot be checked is a key that can be wrong silently.
    typeof r.suiteEpoch === "string"
  );
}

/** The key a result describes, derived from the record itself rather than from where it sits. */
function keyOfResult(result: EvalResult): string {
  return cacheKeyString({
    claimHash: result.claimHash,
    modelId: result.modelId,
    promptVersion: result.promptVersion,
    suiteEpoch: result.suiteEpoch,
  });
}
