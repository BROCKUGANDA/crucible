/**
 * @file database-lifecycle.test.ts — what shutdown does to the pool, and what the pool
 * does afterwards.
 *
 * Found while making the server-backed cases honest: `closePool()` called `pool.end()` on a
 * module-level singleton with no record that it had. In CI, where no PostgreSQL is reachable,
 * the first failing test's `afterEach` closed the pool and every later test in the file
 * inherited the corpse — six different assertions reported "Cannot use a pool after calling
 * end on the pool" and "Called end on pool more than once", and the one real cause (no
 * server) was buried under a cascade that looked like seven defects. A shutdown that cannot
 * be called twice, and a pool that mutters vendor errors after it, are also wrong in
 * production: a SIGTERM handler racing an orderly shutdown hits exactly this path.
 *
 * These cases need no server. `pg` lets a pool that never connected end cleanly, which is
 * what makes the lifecycle testable apart from the database.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { closePool, getClient, healthCheck, query, withTransaction } from '../src/database.js';

describe('database shutdown', () => {
  beforeAll(async () => {
    await closePool();
  });

  it('closes once and tolerates being asked again', async () => {
    // The second call is the regression: pg throws "Called end on pool more than once".
    await expect(closePool()).resolves.toBeUndefined();
  });

  it('refuses a query by naming the reason', async () => {
    await expect(query('SELECT 1')).rejects.toThrow(/pool is closed/);
  });

  it('refuses a client', async () => {
    await expect(getClient()).rejects.toThrow(/pool is closed/);
  });

  it('refuses a transaction', async () => {
    await expect(withTransaction(async () => 'never runs')).rejects.toThrow(/pool is closed/);
  });

  it('reports unhealthy rather than throwing at a caller that cannot handle it', async () => {
    await expect(healthCheck()).resolves.toBe(false);
  });
});

/**
 * The boot landmine that took the deployed API down.
 *
 * `database.ts` used to resolve `DATABASE_URL` and build the pool in a top-level IIFE, so merely
 * importing `@crucible/agent-security` — which `auth.ts` does for the Redis nonce store — threw
 * `DATABASE_URL is required in production` in any production process without a database. The API,
 * keeper and juror crash-looped on a Postgres feature none of them used. The pool is now lazy: the
 * import is inert, and the production refusal fires only when somebody actually opens the pool.
 *
 * A fresh module instance is imported under a simulated production env so this measures the import
 * itself, not a pool some earlier test already opened.
 */
describe('importing the module without a database does not boot-crash', () => {
  it('imports cleanly in production with no DATABASE_URL, and refuses only on first use', async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevUrl = process.env.DATABASE_URL;
    process.env.NODE_ENV = 'production';
    delete process.env.DATABASE_URL;
    vi.resetModules();
    try {
      // The regression: this import used to throw before any function was called.
      const mod = await import('../src/database.js');
      expect(typeof mod.getPool).toBe('function');
      // The safety intent survives: a real use still refuses the localhost default in production.
      expect(() => mod.getPool()).toThrow(/DATABASE_URL is required in production/);
      // Shutdown needs no database to exist, even after a refused open.
      await expect(mod.closePool()).resolves.toBeUndefined();
    } finally {
      vi.resetModules();
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
      if (prevUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevUrl;
    }
  });
});
