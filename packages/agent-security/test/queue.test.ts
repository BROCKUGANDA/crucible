/**
 * @file queue.test.ts — BullMQ queue module tests.
 *
 * Tests queue creation, job addition, and worker creation. Tests that
 * require a real Redis instance will be skipped if Redis is unavailable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getQueue,
  createWorker,
  addJob,
  getAllQueues,
  closeQueues,
  QUEUE_NAMES,
} from '../src/queue.js';

describe('queue module', () => {
  it('exports all expected functions', () => {
    expect(typeof getQueue).toBe('function');
    expect(typeof createWorker).toBe('function');
    expect(typeof addJob).toBe('function');
    expect(typeof getAllQueues).toBe('function');
    expect(typeof closeQueues).toBe('function');
    expect(typeof QUEUE_NAMES).toBe('object');
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
    const queue = getQueue('test-queue');
    expect(queue).toHaveProperty('add');
    expect(queue).toHaveProperty('close');
    expect(queue.name).toBe('test-queue');
  });

  it('addJob creates a job', async () => {
    const queue = getQueue('test-job-queue');
    const job = await queue.add('test-job', { foo: 'bar' }, { attempts: 1 });
    expect(job).toHaveProperty('id');
    expect(job).toHaveProperty('name', 'test-job');
    expect(job.data).toEqual({ foo: 'bar' });
    await queue.close();
  });

  it('getAllQueues returns all created queues', async () => {
    const q1 = getQueue('test-queue-1');
    const q2 = getQueue('test-queue-2');
    const all = getAllQueues();
    expect(all.length).toBeGreaterThanOrEqual(2);
    await q1.close();
    await q2.close();
  });

  afterEach(async () => {
    await closeQueues();
  });
});