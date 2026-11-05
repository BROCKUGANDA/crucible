/**
 * @file queue.ts — BullMQ queue setup for durable background jobs.
 *
 * Provides BullMQ queues for background job processing with retries,
 * dead-letter handling, and concurrency limits. Consistent with ADR-0023:
 * queues are for durable background work, not for financial authority.
 * PostgreSQL retains the durable record; Redis/BullMQ is the delivery layer.
 *
 * BullMQ is at-least-once: workers must be idempotent. Duplicate job
 * delivery must not corrupt state.
 */

import { Queue, Worker, type Job, type QueueOptions, type WorkerOptions } from 'bullmq';
import { Redis } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const redisConnection = {
  url: REDIS_URL,
};

const queueOptions: QueueOptions = {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
};

const queues: Map<string, Queue> = new Map();

export function getQueue(name: string, options?: QueueOptions): Queue {
  if (queues.has(name)) {
    return queues.get(name)!;
  }

  const queue = new Queue(name, {
    ...queueOptions,
    ...options,
  });
  queues.set(name, queue);
  return queue;
}

/**
 * Create a worker for a queue. The processor function receives the job
 * and should return a result or throw on failure.
 */
export function createWorker(
  name: string,
  processor: (job: Job) => Promise<void>,
  options?: WorkerOptions
): Worker {
  return new Worker(
    name,
    processor,
    {
      connection: redisConnection,
      ...options,
    }
  );
}

/**
 * Add a job to a queue. Returns the job object.
 */
export async function addJob(
  queueName: string,
  name: string,
  data: unknown,
  options?: {
    delay?: number;
    attempts?: number;
    backoff?: { delay: number; type: 'fixed' | 'exponential' };
    priority?: number;
    jobId?: string;
  }
): Promise<Job> {
  const queue = getQueue(queueName);
  return queue.add(name, data, {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: 100,
    removeOnFail: 50,
    ...options,
  });
}

/**
 * Get all queues.
 */
export function getAllQueues(): Queue[] {
  return Array.from(queues.values());
}

/**
 * Close all queues. Call on process shutdown.
 */
export async function closeQueues(): Promise<void> {
  await Promise.all(Array.from(queues.values()).map(q => q.close()));
  queues.clear();
}

// Common queue names
export const QUEUE_NAMES = {
  EVALUATION: 'evaluation',
  GRADING: 'grading',
  INDEXER: 'indexer',
  SETTLEMENT: 'settlement',
  NOTIFICATION: 'notification',
  RECONCILIATION: 'reconciliation',
} as const;

export type QueueName = typeof QUEUE_NAMES[keyof typeof QUEUE_NAMES];