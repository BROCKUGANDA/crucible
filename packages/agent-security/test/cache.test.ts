/**
 * @file cache.test.ts — Redis cache module tests.
 *
 * Tests cache get/set/del/exists operations. Tests require a real Redis
 * instance; otherwise they verify the module structure and error handling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

describe('cache module', () => {
  it('exports all expected functions', () => {
    expect(typeof getCacheClient).toBe('function');
    expect(typeof get).toBe('function');
    expect(typeof set).toBe('function');
    expect(typeof del).toBe('function');
    expect(typeof exists).toBe('function');
    expect(typeof incr).toBe('function');
    expect(typeof hset).toBe('function');
    expect(typeof hgetall).toBe('function');
    expect(typeof hdel).toBe('function');
    expect(typeof closeCache).toBe('function');
  });

  it('set and get a string value', async () => {
    await set('test:string', 'hello world');
    const value = await get<string>('test:string');
    expect(value).toBe('hello world');
    await del('test:string');
  });

  it('set and get a JSON object value', async () => {
    const obj = { foo: 'bar', num: 42 };
    await set('test:object', obj);
    const value = await get<{ foo: string; num: number }>('test:object');
    expect(value).toEqual(obj);
    await del('test:object');
  });

  it('get returns null for missing key', async () => {
    const value = await get<string>('nonexistent-key');
    expect(value).toBeNull();
  });

  it('del removes a key', async () => {
    await set('test:del', 'to be deleted');
    const existsBefore = await exists('test:del');
    expect(existsBefore).toBe(true);
    await del('test:del');
    const existsAfter = await exists('test:del');
    expect(existsAfter).toBe(false);
  });

  it('exists returns boolean', async () => {
    await set('test:exists', 'value');
    const result = await exists('test:exists');
    expect(typeof result).toBe('boolean');
    expect(result).toBe(true);
    await del('test:exists');
  });

  it('incr increments a counter', async () => {
    await del('test:incr');
    const val1 = await incr('test:incr');
    expect(val1).toBe(1);
    const val2 = await incr('test:incr');
    expect(val2).toBe(2);
    await del('test:incr');
  });

  it('hset and hgetall work', async () => {
    await hset('test:hash', 'field1', 'value1');
    await hset('test:hash', 'field2', JSON.stringify({ num: 42 }));
    const all = await hgetall('test:hash');
    expect(all['field1']).toBe('value1');
    expect(JSON.parse(all['field2'])).toEqual({ num: 42 });
    await del('test:hash');
  });

  afterEach(async () => {
    await closeCache();
  });
});