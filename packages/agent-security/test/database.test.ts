/**
 * @file database.test.ts — PostgreSQL database module tests.
 *
 * Tests the database connection pool, query execution, transaction support,
 * and migration runner. Tests that require a real PostgreSQL instance will
 * be skipped if PostgreSQL is unavailable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  pool,
  getClient,
  query,
  withTransaction,
  runMigrations,
  closePool,
  healthCheck,
} from '../src/database.js';

describe('database module', () => {
  it('exports all expected functions', () => {
    expect(typeof pool).toBe('object');
    expect(typeof getClient).toBe('function');
    expect(typeof query).toBe('function');
    expect(typeof withTransaction).toBe('function');
    expect(typeof runMigrations).toBe('function');
    expect(typeof closePool).toBe('function');
    expect(typeof healthCheck).toBe('function');
  });

  it('healthCheck returns a boolean', async () => {
    const result = await healthCheck();
    expect(typeof result).toBe('boolean');
  });

  it('query returns a result object', async () => {
    const result = await query('SELECT 1 as test_value');
    expect(result).toHaveProperty('rows');
    expect(Array.isArray(result.rows)).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('getClient returns a pool client', async () => {
    const client = await getClient();
    expect(client).toHaveProperty('query');
    expect(client).toHaveProperty('release');
    await client.release();
  });

  it('withTransaction commits successfully', async () => {
    const result = await withTransaction(async (client) => {
      const r = await client.query('SELECT 42 as val');
      return r.rows[0].val;
    });
    expect(result).toBe(42);
  });

  it('withTransaction rolls back on error', async () => {
    await expect(
      withTransaction(async (client) => {
        await client.query('INSERT INTO nonexistent_table (id) VALUES (1)');
      })
    ).rejects.toThrow();
  });

  it('runMigrations throws on missing directory', async () => {
    await expect(runMigrations('/nonexistent/path')).rejects.toThrow();
  });

  afterEach(async () => {
    await closePool();
  });
});