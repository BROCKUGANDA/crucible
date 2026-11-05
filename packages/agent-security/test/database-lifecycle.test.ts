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

import { beforeAll, describe, expect, it } from 'vitest';
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
