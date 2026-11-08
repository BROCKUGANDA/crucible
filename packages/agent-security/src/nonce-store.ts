/**
 * @file nonce-store.ts — Shared nonce store for SIWE challenges.
 *
 * Replaces the process-local Map in auth.ts with a pluggable store that
 * defaults to Redis in production and falls back to an in-memory Map for
 * single-process development and testing.
 *
 * Design decisions:
 *
 *   1. **The store is async.** Redis is async; the in-memory adapter is
 *      wrapped in Promise.resolve so the caller never branches on the
 *      backend. A sync store would force the auth routes to be sync for
 *      memory and async for Redis, which is the opposite of what you want.
 *   2. **TTL is the store's responsibility.** The caller passes a TTL in
 *      milliseconds and the store handles expiration. Redis uses EXPIRE;
 *      the in-memory store uses a lazy-prune sweep on every operation,
 *      matching the current auth.ts behaviour.
 *   3. **The store is a plain interface, not a class.** Tests inject a
 *      mock; production creates a Redis-backed instance. The auth module
 *      depends on the interface, not on ioredis.
 *   4. **Key prefixing is the store's job.** Every key is prefixed with
 *      `crucible:auth:` so a shared Redis instance does not collide with
 *      other crucible modules (cache, queue, etc.).
 */

import { Redis } from "ioredis";

/** A stored challenge record, mirroring the Challenge type in auth.ts. */
export interface StoredChallenge {
  nonce: string;
  message: string;
  address: string;
  issuedAt: number;
  expiresAt: number;
  signature?: string;
  sessionToken?: string;
}

/**
 * The operations auth.ts needs from a nonce store.
 *
 * Every method is async so the Redis backend does not force the in-memory
 * one to lie about its I/O.
 */
export interface NonceStore {
  /** Create a new challenge entry. Returns the challengeId. */
  set(challengeId: string, record: StoredChallenge, ttlMs: number): Promise<void>;

  /** Read a challenge entry. Returns null when missing or expired. */
  get(challengeId: string): Promise<StoredChallenge | null>;

  /** Remove a challenge entry (for cleanup or explicit deletion). */
  del(challengeId: string): Promise<void>;

  /**
   * Atomically mark a challenge consumed, and say whether *this* caller won.
   *
   * This exists because `get` → check → `set` is not a consumption. The auth route reads the
   * challenge, awaits signature recovery (real crypto, real milliseconds), and only then marks it
   * used; two concurrent requests carrying the same `{address, nonce, signature}` both read an
   * unconsumed record and both go on to mint a session. The process-local Map this replaced hid
   * that behind the event loop — its check-and-set ran with no await between them — and Redis
   * puts the window back, across processes.
   *
   * So consumption is one operation that either happens or does not, and the caller mints a
   * session only when it returns true. Returns false when the entry is missing, expired, the
   * nonce does not match, or somebody else already consumed it.
   */
  consume(challengeId: string, nonce: string, signature: string, ttlMs: number): Promise<boolean>;

  /**
   * Prune expired entries.
   *
   * The in-memory store needs this because it has no native TTL.
   * The Redis backend is a no-op (Redis expires keys natively).
   */
  prune(maxEntries?: number): Promise<void>;

  /** Close any underlying connections. */
  close(): Promise<void>;

  /**
   * Atomically consume a challenge: mark it consumed only if it is currently
   * unconsumed and the nonce matches. Returns true if this caller won the
   * race, false otherwise (missing, expired, nonce mismatch, already consumed).
   */
  consume(challengeId: string, nonce: string, signature: string, consumedTtlMs: number): Promise<boolean>;
}

const KEY_PREFIX = "crucible:auth:";

function key(challengeId: string): string {
  return `${KEY_PREFIX}${challengeId}`;
}

/**
 * Create a Redis-backed nonce store.
 *
 * When `REDIS_URL` is set and reachable, this is the production path.
 * When Redis is unavailable the store degrades to the in-memory backend
 * so the auth flow still works for a single-process deployment.
 */
export async function createRedisNonceStore(
  redisUrl?: string,
): Promise<NonceStore> {
  const url = redisUrl || process.env.REDIS_URL || "redis://localhost:6379";
  let client: Redis | null = null;

  try {
    client = new Redis(url, { lazyConnect: true });
    client.on("error", (err: Error) => {
      console.error(`[crucible] Redis nonce store error: ${err.message}`);
    });
    await client.connect();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Fail closed when Redis was explicitly required; otherwise degrade
    // to in-memory for dev/single-process deployments.
    if (process.env.REDIS_REQUIRED === "1" || process.env.NODE_ENV === "production" && process.env.REDIS_URL) {
      throw new Error(`Redis nonce store unavailable: ${msg}`);
    }
    console.warn(
      `[crucible] Redis unavailable (${msg}), falling back to in-memory nonce store`,
    );
    return createMemoryNonceStore();
  }

  const store: NonceStore = {
    async set(challengeId: string, record: StoredChallenge, ttlMs: number) {
      const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
      await client!.set(key(challengeId), JSON.stringify(record), "EX", ttlSeconds);
    },

    async get(challengeId: string) {
      const raw = await client!.get(key(challengeId));
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as StoredChallenge;
      } catch {
        return null;
      }
    },

    async del(challengeId: string) {
      await client!.del(key(challengeId));
    },

    async consume(challengeId: string, nonce: string, signature: string, consumedTtlMs: number) {
      const ttlSeconds = Math.max(1, Math.ceil(consumedTtlMs / 1000));
      const lua = `
        local raw = redis.call('GET', KEYS[1])
        if not raw then return 0 end
        local ok, rec = pcall(cjson.decode, raw)
        if not ok or type(rec) ~= 'table' then return 0 end
        if rec.nonce ~= ARGV[1] then return 0 end
        if rec.signature and rec.signature ~= '' and rec.signature ~= false then return 0 end
        rec.signature = ARGV[2]
        rec.expiresAt = tonumber(ARGV[3])
        redis.call('SET', KEYS[1], cjson.encode(rec), 'EX', ARGV[4])
        return 1
      `;
      const result = await (client as any).eval(lua, 1, key(challengeId), nonce, signature, String(Date.now() + consumedTtlMs), String(ttlSeconds));
      return result === 1;
    },

    async prune() {
      // Redis handles TTL natively; no-op.
    },

    async close() {
      if (client) {
        await client.quit();
        client = null;
      }
    },
  };

  return store;
}

/**
 * Create an in-memory nonce store.
 *
 * Used for:
 * - Single-process development (no Redis daemon)
 * - Unit tests that need a real store without a daemon
 * - Graceful degradation when Redis is unreachable
 *
 * Preserves the globalThis pattern from auth.ts so hot-reloads during
 * development do not empty the store mid-flow.
 */
export function createMemoryNonceStore(): NonceStore {
  const STATE_KEY = "__crucible_auth_nonce_store__";
  const globalScope = globalThis as unknown as Record<string, unknown>;
  const state: { entries: Map<string, { record: StoredChallenge; expireAt: number }> } =
    (globalScope[STATE_KEY] as { entries: Map<string, { record: StoredChallenge; expireAt: number }> } | undefined) ?? {
      entries: new Map(),
    };
  globalScope[STATE_KEY] = state;

  function _pruneNow(now: number, maxEntries?: number): void {
    for (const [k, v] of state.entries) {
      if (v.expireAt <= now) {
        state.entries.delete(k);
      }
    }
    if (maxEntries !== undefined && state.entries.size > maxEntries) {
      const keys = [...state.entries.keys()];
      for (const k of keys) {
        if (state.entries.size <= maxEntries - 1) break;
        state.entries.delete(k);
      }
    }
  }

  return {
    async set(challengeId: string, record: StoredChallenge, ttlMs: number) {
      const now = Date.now();
      _pruneNow(now);
      state.entries.set(challengeId, { record, expireAt: now + ttlMs });
    },

    async get(challengeId: string) {
      const now = Date.now();
      _pruneNow(now);
      const entry = state.entries.get(challengeId);
      if (!entry) return null;
      if (entry.expireAt <= now) {
        state.entries.delete(challengeId);
        return null;
      }
      return entry.record;
    },

    async del(challengeId: string) {
      state.entries.delete(challengeId);
    },

    /**
     * Check and write with no `await` between them, which is what makes this atomic here: a
     * JavaScript turn cannot be interleaved, so the second caller always sees the first's
     * signature. It is the same guarantee the process-local Map gave before this refactor, kept
     * deliberately rather than reintroducing the window the Redis path just closed.
     */
    async consume(challengeId: string, nonce: string, signature: string, ttlMs: number) {
      const now = Date.now();
      _pruneNow(now);
      const entry = state.entries.get(challengeId);
      if (!entry || entry.expireAt <= now) return false;
      if (entry.record.nonce !== nonce) return false;
      if (entry.record.signature) return false;
      entry.record.signature = signature;
      entry.record.expiresAt = now + ttlMs;
      entry.expireAt = now + ttlMs;
      return true;
    },

    async prune(maxEntries?: number) {
      _pruneNow(Date.now(), maxEntries);
    },

    async close() {
      // In-memory store has no connections to close.
    },
  };
}

/**
 * Factory: create the appropriate nonce store for the current environment.
 *
 * - Production (NODE_ENV=production): Redis, with in-memory fallback.
 * - Development: In-memory store (Redis is optional).
 * - Tests: In-memory store (tests inject their own if needed).
 *
 * Exported so `auth.ts` can call it once at startup. The returned store
 * is then used for the lifetime of the process.
 */
export async function createNonceStore(): Promise<NonceStore> {
  if (process.env.NODE_ENV === "production") {
    return createRedisNonceStore();
  }
  return createMemoryNonceStore();
}
