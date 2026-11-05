/**
 * support/live.ts — whether a real Redis / PostgreSQL is in reach for this run.
 *
 * These probes deliberately do NOT fall back to the module default. `cache.ts` and
 * `database.ts` each resolve a URL at import (`redis://localhost:6379`,
 * `postgresql://crucible:crucible@localhost:5432/crucible`) because a deployed process is
 * entitled to be told where its store is by the absence of a setting. A test suite is not.
 * On this repository's CI runner — the same box that serves the site — an unasked-for dial
 * of localhost means the suite writes `test:*` keys and runs migrations against whatever
 * happens to own that port. So the rule here is: no explicit URL, no live run, and the
 * reason is printed rather than hidden behind a green checkmark.
 */

import { Redis } from 'ioredis';
import { Client } from 'pg';

export interface Probe {
  ok: boolean;
  reason: string;
}

/** The URL a live case may use, or null when the operator has not named one. */
export function liveRedisUrl(): string | null {
  return process.env.REDIS_URL ?? null;
}

export function liveDatabaseUrl(): string | null {
  return process.env.DATABASE_URL ?? null;
}

export async function probeRedis(): Promise<Probe> {
  const url = liveRedisUrl();
  if (!url) {
    return {
      ok: false,
      reason: 'REDIS_URL is unset, and this suite will not dial the module default of ' +
        'redis://localhost:6379 unasked',
    };
  }
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  // ioredis emits an 'error' event for the refused connection as well as rejecting the
  // command; without a listener Node treats the stray event as fatal and takes the worker.
  client.on('error', () => {});
  try {
    await client.connect();
    const pong = await client.ping();
    return { ok: pong === 'PONG', reason: `PING answered ${String(pong)}` };
  } catch (err) {
    return { ok: false, reason: `${url} refused the probe: ${(err as Error).message}` };
  } finally {
    client.disconnect();
  }
}

export async function probePostgres(): Promise<Probe> {
  const url = liveDatabaseUrl();
  if (!url) {
    return {
      ok: false,
      reason: 'DATABASE_URL is unset, and this suite will not dial the module default of ' +
        'postgresql://…@localhost:5432/crucible unasked',
    };
  }
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const res = await client.query('SELECT 1 AS one');
    return { ok: res.rows[0]?.one === 1, reason: 'SELECT 1 answered' };
  } catch (err) {
    return { ok: false, reason: `${url} refused the probe: ${(err as Error).message}` };
  } finally {
    await client.end().catch(() => {});
  }
}

/** The line the suite prints when a service-backed block is not going to run. */
export function skipBanner(module: string, probe: Probe, what: string): void {
  if (probe.ok) return;
  console.log(
    `SKIPPING ${module} ${what}: ${probe.reason}. These cases assert behaviour against the ` +
      'real server and there is no server to assert them against. They report SKIPPED, not passed.',
  );
}
