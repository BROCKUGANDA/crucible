/**
 * @file database.ts — PostgreSQL connection pool and migration runner.
 *
 * Provides a pooled PostgreSQL connection for durable application data.
 * Consistent with ADR-0023: PostgreSQL is the durable source of truth for
 * application data, while the blockchain remains the authoritative financial
 * state. Two distinct sources of authority.
 *
 * All timestamps are Unix milliseconds. All monetary amounts are stored as
 * strings (wei/lamports) to avoid floating-point precision loss.
 */

import { Pool, type PoolClient, type QueryResult } from 'pg';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the connection string, refusing the known-default localhost pair in production.
 *
 * This runs on first *use*, not at import. It used to be a top-level IIFE, which meant merely
 * importing `@crucible/agent-security` — the way `auth.ts` imports the Redis nonce store — created
 * a Postgres pool and threw in any production process without `DATABASE_URL`. The deployed API
 * crash-looped on `DATABASE_URL is required in production` while using no Postgres feature at all:
 * the barrel re-exports this module, so an unused pool was a boot-time landmine. A connection pool
 * is a resource a process opens when it needs it, the same lazy shape `cache.ts` uses for Redis.
 * The safety intent is unchanged — a production query still refuses the localhost default — it
 * just fires when somebody actually asks the database for something.
 */
function resolveDatabaseUrl(): string {
  const configured = process.env.DATABASE_URL?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_URL is required in production; refusing the localhost crucible:crucible default",
    );
  }
  return "postgresql://crucible:crucible@localhost:5432/crucible";
}

let pool: Pool | null = null;
let closed = false;

/**
 * The pool, created on first use and refused after shutdown.
 *
 * `pg` answers a use after `end()` with "Cannot use a pool after calling end on the pool"
 * and a second `end()` with "Called end on pool more than once". Both were observed in CI,
 * where a test suite closed the pool in `afterEach` and every later case inherited the
 * corpse — one teardown turned fourteen assertions into noise, and the first failure was the
 * only one that had a cause. Refusing with the real reason is the fix: shutdown is
 * idempotent, and use after shutdown says so.
 */
export function getPool(): Pool {
  if (closed) {
    throw new Error('database pool is closed; this process has shut its database down');
  }
  if (pool === null) {
    pool = new Pool({
      connectionString: resolveDatabaseUrl(),
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

function activePool(): Pool {
  return getPool();
}

/**
 * Get a client from the pool. Caller must release the client when done.
 */
export async function getClient(): Promise<PoolClient> {
  return activePool().connect();
}

/**
 * Run a query with parameterized values.
 */
export async function query<T = unknown>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<any>> {
  return activePool().query(text, params);
}

/**
 * Run a query in a transaction. The callback receives a client and should
 * commit or rollback. Returns the callback's return value.
 */
export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await activePool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Resolve the migrations directory. Deployments can override with
 * CRUCIBLE_MIGRATIONS_DIR; otherwise defaults to `<repo>/migrations` relative
 * to this package's compiled location.
 */
export function resolveMigrationsDir(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.CRUCIBLE_MIGRATIONS_DIR) return process.env.CRUCIBLE_MIGRATIONS_DIR;
  return join(__dirname, '..', '..', '..', 'migrations');
}

/**
 * Run all pending migration files in order. Migration files are SQL files
 * in the migrations directory, named with a numeric prefix (e.g.,
 * 0001_identity.sql). Each migration is run inside a transaction.
 *
 * Note: there is no applied-migrations ledger; migrations MUST be idempotent
 * (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, etc.).
 */
export async function runMigrations(migrationsDir?: string): Promise<void> {
  const dir = resolveMigrationsDir(migrationsDir);
  const client = await activePool().connect();
  try {
    await runMigrationsImpl(client, dir);
  } finally {
    client.release();
  }
}

async function runMigrationsImpl(
  client: PoolClient,
  migrationsDir: string
): Promise<void> {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    // Split by semicolons outside of string literals for basic statement splitting
    const statements = splitSqlStatements(sql);

    for (const statement of statements) {
      const trimmed = statement.trim();
      if (trimmed.length === 0) continue;
      await client.query(trimmed);
    }
  }
}

/**
 * Split SQL statements by semicolons, respecting string literals.
 * Simple implementation: handles single-quoted strings and dollar-quoted strings.
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDollarQuote = false;
  let dollarTag = '';

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inDollarQuote) {
      current += ch;
      if (dollarTag && sql.startsWith('$' + dollarTag + '$', i)) {
        current += '$' + dollarTag + '$';
        i += dollarTag.length + 1;
        inDollarQuote = false;
        dollarTag = '';
      }
      continue;
    }

    if (inSingleQuote) {
      current += ch;
      if (ch === "'" && sql[i + 1] !== "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      current += ch;
      continue;
    }

    if (ch === '$' && next && /[a-zA-Z_]/.test(next)) {
      // Potential dollar-quoted string
      let tag = '';
      let j = i + 1;
      while (j < sql.length) {
        const chj = sql[j];
        if (!chj || !/[a-zA-Z_0-9]/.test(chj)) break;
        tag += chj;
        j++;
      }
      if (j < sql.length && sql[j] === '$') {
        dollarTag = tag;
        inDollarQuote = true;
        current += ch + tag + '$';
        i = j;
        continue;
      }
    }

    if (ch === ';' && !inSingleQuote && !inDollarQuote) {
      statements.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim().length > 0) {
    statements.push(current);
  }

  return statements;
}

/**
 * Close the pool. Call on process shutdown. Idempotent: a second call — or a call from a
 * signal handler that races an orderly shutdown — does nothing rather than throwing.
 */
export async function closePool(): Promise<void> {
  if (closed) return;
  closed = true;
  // A pool that was never opened has nothing to end — and `pg` lets a never-connected pool end
  // cleanly anyway, so this only guards the null. Shutdown must not require the database to exist.
  if (pool !== null) await pool.end();
}

// Health check: verify database connectivity. A closed pool is not healthy, and the
// answer stays a boolean rather than becoming a throw at a caller that cannot handle one.
export async function healthCheck(): Promise<boolean> {
  try {
    await activePool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}