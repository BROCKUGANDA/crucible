/**
 * @file cache.ts — Redis cache client for transient state.
 *
 * Provides a Redis client for high-speed transient state: API caching,
 * rate limits, short-lived sessions, leaderboard caching. Consistent with
 * ADR-0023: Redis cache is for disposable data only, never for financial
 * authority. PostgreSQL remains the durable source of truth.
 *
 * Cache Redis uses eviction policy (allkeys-lru) and short TTLs — separate
 * from the queue Redis which uses noeviction.
 */

import { Redis } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let client: Redis | null = null;

/**
 * The client the cache talks through, and the door a test walks in through.
 *
 * `lazyConnect` is load-bearing, not decoration: `new Redis(url)` starts connecting on its
 * own, so the explicit `connect()` below used to reject with "Redis is already
 * connecting/connected" on any host where a server was actually reachable. Nothing noticed
 * because the module has never had a server to reach — every caller so far died on
 * ECONNREFUSED first. A cache whose happy path has never executed is not a verified cache.
 */
function createCacheClient(): Redis {
  return new Redis(REDIS_URL, { lazyConnect: true });
}

/**
 * The cache client, connected once.
 *
 * `factory` is the seam: `cache.test.ts` passes a stand-in that speaks the same commands so
 * the serialization and return-shape rules in this file are asserted without a daemon, the
 * same way `forge-runner`'s `SandboxDeps.exec` asserts the container path without one. The
 * stand-in proves *our* logic; it cannot prove Redis behaves like Redis, which is what the
 * server-backed cases in that file exist for.
 */
export async function getCacheClient(factory: () => Redis = createCacheClient): Promise<Redis> {
  if (!client) {
    client = factory();
    client.on('error', (err: Error) => {
      console.error('Redis cache client error:', err);
    });
    await client.connect();
  }
  return client;
}

/**
 * Get a value from cache. Returns null if not found or expired.
 */
export async function get<T>(key: string): Promise<T | null> {
  const client = await getCacheClient();
  const value = await client.get(key);
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return value as unknown as T;
  }
}

/**
 * Set a value in cache with optional TTL in seconds.
 */
export async function set(
  key: string,
  value: unknown,
  ttlSeconds?: number
): Promise<void> {
  const client = await getCacheClient();
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (ttlSeconds) {
    await client.set(key, serialized, 'EX', ttlSeconds);
  } else {
    await client.set(key, serialized);
  }
}

/**
 * Delete a key from cache.
 */
export async function del(key: string): Promise<void> {
  const client = await getCacheClient();
  await client.del(key);
}

/**
 * Check if a key exists in cache.
 */
export async function exists(key: string): Promise<boolean> {
  const client = await getCacheClient();
  const result = await client.exists(key);
  return result === 1;
}

/**
 * Increment a numeric counter in cache.
 */
export async function incr(key: string): Promise<number> {
  const client = await getCacheClient();
  return client.incr(key);
}

/**
 * Set multiple fields in a hash.
 */
export async function hset(
  key: string,
  field: string,
  value: unknown
): Promise<void> {
  const client = await getCacheClient();
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  await client.hset(key, field, serialized);
}

/**
 * Get multiple fields from a hash.
 */
export async function hgetall(key: string): Promise<Record<string, string>> {
  const client = await getCacheClient();
  return client.hgetall(key);
}

/**
 * Delete a hash field.
 */
export async function hdel(key: string, field: string): Promise<void> {
  const client = await getCacheClient();
  await client.hdel(key, field);
}

/**
 * Close the cache client. Call on process shutdown.
 */
export async function closeCache(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}