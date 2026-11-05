/**
 * @file database.test.ts — the PostgreSQL module.
 *
 * Everything here either needs no server or asks for one out loud.
 *
 * The cases that used to fail together (`query`, `getClient`, `withTransaction`,
 * `runMigrations`) assert against a live PostgreSQL and are reported SKIPPED with a reason
 * when `DATABASE_URL` is unset — see `support/live.ts` for why the suite refuses to dial
 * the module's localhost default unasked. The teardown that made one missing server look
 * like fourteen defects is covered in `database-lifecycle.test.ts`, which needs nothing.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  pool,
  getClient,
  query,
  withTransaction,
  runMigrations,
  healthCheck,
} from '../src/database.js';
import { probePostgres, skipBanner } from './support/live.js';

const live = await probePostgres();
skipBanner('database', live, 'server-backed cases');

const testLive = it.skipIf(!live.ok);

describe('database module', () => {
  it('exports all expected functions', () => {
    expect(typeof pool).toBe('object');
    expect(typeof getClient).toBe('function');
    expect(typeof query).toBe('function');
    expect(typeof withTransaction).toBe('function');
    expect(typeof runMigrations).toBe('function');
    expect(typeof healthCheck).toBe('function');
  });

  testLive('healthCheck reports healthy against the server it was given', async () => {
    expect(await healthCheck()).toBe(true);
  });

  testLive('query returns a result object', async () => {
    const result = await query('SELECT 1 as test_value');
    expect(result).toHaveProperty('rows');
    expect(Array.isArray(result.rows)).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  testLive('getClient returns a pool client', async () => {
    const client = await getClient();
    expect(client).toHaveProperty('query');
    expect(client).toHaveProperty('release');
    await client.release();
  });

  testLive('withTransaction commits successfully', async () => {
    const result = await withTransaction(async (client) => {
      const r = await client.query('SELECT 42 as val');
      return r.rows[0].val;
    });
    expect(result).toBe(42);
  });

  testLive('withTransaction rolls back on error', async () => {
    await expect(
      withTransaction(async (client) => {
        await client.query('INSERT INTO nonexistent_table (id) VALUES (1)');
      })
    ).rejects.toThrow();
  });

  testLive('runMigrations throws on a directory that is not there', async () => {
    await expect(runMigrations('/nonexistent/path')).rejects.toThrow();
  });
});
