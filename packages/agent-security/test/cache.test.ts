/**
 * @file cache.test.ts — the Redis cache module.
 *
 * Two blocks, and they prove different things.
 *
 * The first drives the module through its `getCacheClient(factory)` seam against a
 * stand-in that speaks the same commands. That is where the logic this file owns lives:
 * what gets serialized, what `EX` receives, how a Redis integer becomes a JavaScript
 * boolean, what a non-JSON payload does to `get`. It runs on any machine, CI included.
 *
 * The second needs a real server. It used to be the only block, which meant that on a
 * runner with no Redis the file's fourteen assertions were fourteen failures — and that
 * the module's own rules were asserted nowhere at all. The server-backed cases now report
 * SKIPPED with a reason (see `support/live.ts` for why they will not dial localhost
 * unasked) rather than passing on an absence.
 *
 * The stand-in cannot prove Redis behaves like Redis. That is what the second block is for.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Redis } from 'ioredis';
import {
  getCacheClient,
  get,
  set,
  del,
  exists,
  incr,
  hset,
  hgetall,
  hdel,
  closeCache,
} from '../src/cache.js';
import { probeRedis, skipBanner } from './support/live.js';

/** The commands `src/cache.ts` actually calls, and nothing else. */
class StandInRedis {
  strings = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  /** The ttl argument as the module passed it, so `EX` and its unit are observable. */
  expirations = new Map<string, { mode: string; value: number }>();
  connections = 0;

  on(): void {}

  async connect(): Promise<string> {
    this.connections += 1;
    return 'OK';
  }

  async quit(): Promise<string> {
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.strings.has(key) ? this.strings.get(key)! : null;
  }

  async set(key: string, value: string, mode?: string, value2?: number): Promise<string> {
    this.strings.set(key, value);
    if (mode !== undefined && value2 !== undefined) this.expirations.set(key, { mode, value: value2 });
    else this.expirations.delete(key);
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) removed += 1;
      if (this.hashes.delete(key)) removed += 1;
      this.expirations.delete(key);
    }
    return removed;
  }

  async exists(key: string): Promise<number> {
    return this.strings.has(key) || this.hashes.has(key) ? 1 : 0;
  }

  async incr(key: string): Promise<number> {
    const next = Number(this.strings.get(key) ?? '0') + 1;
    this.strings.set(key, String(next));
    return next;
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    const isNew = !hash.has(field);
    hash.set(field, value);
    this.hashes.set(key, hash);
    return isNew ? 1 : 0;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? new Map());
  }

  async hdel(key: string, field: string): Promise<number> {
    return this.hashes.get(key)?.delete(field) ? 1 : 0;
  }
}

describe('cache module through its seam', () => {
  let standIn: StandInRedis;

  beforeEach(async () => {
    await closeCache();
    standIn = new StandInRedis();
    await getCacheClient(() => standIn as unknown as Redis);
  });

  afterEach(async () => {
    await closeCache();
  });

  it('exports all expected functions', () => {
    for (const fn of [getCacheClient, get, set, del, exists, incr, hset, hgetall, hdel, closeCache]) {
      expect(typeof fn).toBe('function');
    }
  });

  it('connects once, however many operations follow', async () => {
    await set('one', '1');
    await get('one');
    await exists('one');
    expect(standIn.connections).toBe(1);
  });

  it('stores a string verbatim rather than as a JSON literal', async () => {
    await set('raw', 'hello world');
    expect(standIn.strings.get('raw')).toBe('hello world');
  });

  it('serializes anything else, and reads it back as the same shape', async () => {
    const obj = { foo: 'bar', num: 42 };
    await set('obj', obj);
    expect(standIn.strings.get('obj')).toBe(JSON.stringify(obj));
    expect(await get<typeof obj>('obj')).toEqual(obj);
  });

  it('passes a ttl as EX with the seconds the caller named', async () => {
    await set('brief', 'gone soon', 30);
    expect(standIn.expirations.get('brief')).toEqual({ mode: 'EX', value: 30 });
  });

  it('sets no expiry when the caller named none', async () => {
    await set('kept', 'value', 5);
    await set('kept', 'value');
    expect(standIn.expirations.has('kept')).toBe(false);
  });

  it('hands back a payload that is not JSON instead of failing on it', async () => {
    // Something else wrote this key — a plain string from another service, say. Reading the
    // cache must not turn a foreign value into an exception.
    standIn.strings.set('foreign', 'plain text, not json');
    expect(await get<string>('foreign')).toBe('plain text, not json');
  });

  it('returns null for a key that is not there', async () => {
    expect(await get<string>('absent')).toBeNull();
  });

  it('removes a key, and reports it gone', async () => {
    await set('doomed', 'value');
    expect(await exists('doomed')).toBe(true);
    await del('doomed');
    expect(await exists('doomed')).toBe(false);
    expect(await get('doomed')).toBeNull();
  });

  it('answers exists with a boolean, not Redis’s integer', async () => {
    await set('present', '1');
    expect(await exists('present')).toBe(true);
    expect(await exists('missing')).toBe(false);
  });

  it('counts a counter up from nothing', async () => {
    expect(await incr('hits')).toBe(1);
    expect(await incr('hits')).toBe(2);
  });

  /**
   * The client must be built with `lazyConnect`, and that cannot be seen through the seam.
   *
   * `new Redis(url)` starts connecting on its own, so the `await client.connect()` above it
   * rejects with "Redis is already connecting/connected" — which means every call in this
   * file would fail against a real server while passing against the stand-in, because the
   * stand-in has no auto-connect to lose. The behavior is a property of the driver, so the
   * guard is over the executed statement that hands it the option (comments stripped, per
   * the lesson in `scripts/install-tool.sh`: prose that mentions a flag is not a flag).
   */
  it('builds the real client lazily so the explicit connect is legal', () => {
    const source = readFileSync(new URL('../src/cache.ts', import.meta.url), 'utf8')
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, '').trim())
      .filter((l) => l.length > 0 && !l.startsWith('*') && !l.startsWith('/*'))
      .join('\n');
    expect(source).toMatch(/new Redis\(REDIS_URL, \{ lazyConnect: true \}\)/);
  });

  it('stores hash fields, serializing the values, and reads them all back', async () => {
    await hset('h', 'text', 'value1');
    await hset('h', 'obj', { num: 42 });
    const all = await hgetall('h');
    expect(all['text']).toBe('value1');
    expect(JSON.parse(all['obj'])).toEqual({ num: 42 });
  });

  it('deletes one hash field and leaves the rest', async () => {
    await hset('h2', 'a', '1');
    await hset('h2', 'b', '2');
    await hdel('h2', 'a');
    expect(await hgetall('h2')).toEqual({ b: '2' });
  });
});

const live = await probeRedis();
skipBanner('cache', live, 'server-backed cases');

const testLive = it.skipIf(!live.ok);

describe(`cache module against a real Redis${live.ok ? '' : ' — SKIPPED (needs REDIS_URL)'}`, () => {
  const key = (name: string) => `crucible:test:${name}`;

  afterEach(async () => {
    await del(key('string'));
    await del(key('object'));
    await del(key('counter'));
    await del(key('hash'));
  });

  testLive('round-trips a string through the server', async () => {
    await set(key('string'), 'hello world');
    expect(await get<string>(key('string'))).toBe('hello world');
  });

  testLive('round-trips an object through the server', async () => {
    const obj = { foo: 'bar', num: 42 };
    await set(key('object'), obj);
    expect(await get<typeof obj>(key('object'))).toEqual(obj);
  });

  testLive('answers null for a key the server does not have', async () => {
    expect(await get<string>(key('absent'))).toBeNull();
  });

  testLive('exists follows a del', async () => {
    await set(key('string'), 'x');
    expect(await exists(key('string'))).toBe(true);
    await del(key('string'));
    expect(await exists(key('string'))).toBe(false);
  });

  testLive('counts on the server, starting from a clean key', async () => {
    await del(key('counter'));
    const first = await incr(key('counter'));
    expect(first).toBeTypeOf('number');
    expect(await incr(key('counter'))).toBe(first + 1);
    await del(key('counter'));
  });

  testLive('writes and reads a hash', async () => {
    await hset(key('hash'), 'field1', 'value1');
    await hset(key('hash'), 'field2', { num: 42 });
    const all = await hgetall(key('hash'));
    expect(all['field1']).toBe('value1');
    expect(JSON.parse(all['field2'])).toEqual({ num: 42 });
  });
});
