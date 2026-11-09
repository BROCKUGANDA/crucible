/**
 * @file queue.test.ts — BullMQ queue module tests.
 *
 * Queue construction, naming and the registry are asserted here always; the one case that
 * actually enqueues needs a server and runs only when `REDIS_URL` names one (announced
 * SKIPPED otherwise). Queue names carry the `crucible-test-` prefix because a BullMQ queue
 * name is a global key inside the Redis it lives in — a generic name would collide with
 * whatever else that server is carrying.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  getQueue,
  createWorker,
  addJob,
  getAllQueues,
  closeQueues,
  redisOptionsFromUrl,
  isFinalFailure,
  buildDeadLetterRecord,
  QUEUE_NAMES,
} from '../src/queue.js';
import { probeRedis, skipBanner } from './support/live.js';

/**
 * Constructing a BullMQ queue needs no server — a `Queue` is an object and a lazy
 * connection. Enqueueing is a different claim, and on a runner with no Redis it waited on a
 * retry loop until the test timeout killed it. That case now asks for `REDIS_URL` out loud
 * and reports SKIPPED without one, for the reason in `support/live.ts`.
 */
const live = await probeRedis();
skipBanner('queue', live, 'the enqueue case');

const testLive = it.skipIf(!live.ok);

describe('queue module', () => {
  it('exports all expected functions', () => {
    expect(typeof getQueue).toBe('function');
    expect(typeof createWorker).toBe('function');
    expect(typeof addJob).toBe('function');
    expect(typeof getAllQueues).toBe('function');
    expect(typeof closeQueues).toBe('function');
    expect(typeof QUEUE_NAMES).toBe('object');
  });

  it('parses REDIS_URL into host, port, credentials and db', () => {
    // ioredis ignores a `{ url }` options object, so REDIS_URL must be parsed
    // explicitly or every queue silently dials 127.0.0.1.
    expect(redisOptionsFromUrl('redis://redis.internal:6380/3')).toEqual({
      host: 'redis.internal',
      port: 6380,
      db: 3,
    });
    expect(redisOptionsFromUrl('redis://user:pass@cache:6379/0')).toEqual({
      host: 'cache',
      port: 6379,
      username: 'user',
      password: 'pass',
      db: 0,
    });
    expect(redisOptionsFromUrl('redis://localhost')).toEqual({ host: 'localhost', port: 6379 });
  });

  it('dead-letters only on the final failed attempt, with the payload intact', () => {
    expect(isFinalFailure(4, 5)).toBe(false);
    expect(isFinalFailure(5, 5)).toBe(true);
    // No explicit attempts: the Forge Watch default (5) decides.
    expect(isFinalFailure(4, undefined)).toBe(false);
    expect(isFinalFailure(5, undefined)).toBe(true);

    const record = buildDeadLetterRecord(
      'forge-watch',
      { id: 'job-1', name: 'monitor', data: { runId: 'r1', phase: 'l0' } },
      new Error('payload invalid'),
      () => 1_000,
    );
    expect(record).toEqual({
      source: 'forge-watch',
      jobId: 'job-1',
      name: 'monitor',
      data: { runId: 'r1', phase: 'l0' },
      error: 'payload invalid',
      failedAt: 1_000,
    });
    expect(QUEUE_NAMES.FORGE_WATCH_DLQ).toBe('forge-watch-dlq');
  });

  it('QUEUE_NAMES has expected values', () => {
    expect(QUEUE_NAMES.EVALUATION).toBe('evaluation');
    expect(QUEUE_NAMES.GRADING).toBe('grading');
    expect(QUEUE_NAMES.INDEXER).toBe('indexer');
    expect(QUEUE_NAMES.SETTLEMENT).toBe('settlement');
    expect(QUEUE_NAMES.NOTIFICATION).toBe('notification');
    expect(QUEUE_NAMES.RECONCILIATION).toBe('reconciliation');
  });

  it('getQueue returns a Queue instance', async () => {
    const queue = getQueue('crucible-test-queue');
    expect(queue).toHaveProperty('add');
    expect(queue).toHaveProperty('close');
    expect(queue.name).toBe('crucible-test-queue');
  });

  testLive('addJob creates a job', async () => {
    // Through the exported `addJob`, which is the thing this case is named after. The
    // first version called `queue.add` directly, so it asserted BullMQ's own API and left
    // this module's retry/backoff defaults unexercised.
    const job = await addJob('crucible-test-job-queue', 'test-job', { foo: 'bar' }, { attempts: 1 });
    expect(job).toHaveProperty('id');
    expect(job).toHaveProperty('name', 'test-job');
    expect(job.data).toEqual({ foo: 'bar' });
    await job.remove().catch(() => undefined);
  });

  it('getAllQueues returns all created queues', async () => {
    const q1 = getQueue('crucible-test-queue-1');
    const q2 = getQueue('crucible-test-queue-2');
    const all = getAllQueues();
    expect(all.length).toBeGreaterThanOrEqual(2);
    await q1.close();
    await q2.close();
  });

  afterEach(async () => {
    await closeQueues();
  });
});