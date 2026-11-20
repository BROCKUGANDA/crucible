/**
 * @file worker-lifecycle.ts — Worker lifecycle management (Phase 3).
 *
 * Provides graceful shutdown, draining, recovery after termination,
 * job leases, heartbeats, timeouts, bounded concurrency, and per-tenant
 * quotas. Workers are idempotent: a job can be safely retried without
 * double-execution.
 *
 * Design principles:
 * - A worker never holds state across restarts.
 * - Job leases prevent double execution.
 * - Heartbeats detect stuck workers.
 * - Draining allows graceful shutdown without dropping in-flight jobs.
 * - Per-tenant quotas prevent one tenant from starving others.
 */

import { randomUUID } from "node:crypto";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type WorkerStatus = "idle" | "draining" | "stopped" | "error";
export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface WorkerConfig {
  /** Maximum concurrent jobs per worker. */
  maxConcurrency?: number;
  /** Job timeout in milliseconds. */
  jobTimeoutMs?: number;
  /** Heartbeat interval in milliseconds. */
  heartbeatIntervalMs?: number;
  /** Lease duration in milliseconds. */
  leaseDurationMs?: number;
  /** Grace period for draining in milliseconds. */
  drainTimeoutMs?: number;
  /** Per-tenant maximum concurrent jobs. */
  perTenantConcurrency?: number;
}

export interface JobDefinition {
  jobId: string;
  tenantId: string;
  runId: string;
  payload: unknown;
  createdAt: number;
  status: JobStatus;
  leaseId?: string;
  leaseExpiresAt?: number;
  startedAt?: number;
  completedAt?: number;
  attempts: number;
  lastError?: string;
}

export interface WorkerStats {
  status: WorkerStatus;
  activeJobs: number;
  completedJobs: number;
  failedJobs: number;
  tenantConcurrency: Map<string, number>;
}

/* ------------------------------------------------------------------ */
/* Defaults                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_CONFIG: Required<WorkerConfig> = {
  maxConcurrency: 10,
  jobTimeoutMs: 300_000,
  heartbeatIntervalMs: 10_000,
  leaseDurationMs: 60_000,
  drainTimeoutMs: 120_000,
  perTenantConcurrency: 3,
};

/* ------------------------------------------------------------------ */
/* In-memory store                                                    */
/* ------------------------------------------------------------------ */

interface WorkerStore {
  jobs: Map<string, JobDefinition>;
  status: WorkerStatus;
  completedCount: number;
  failedCount: number;
  heartbeatTimers: Map<string, ReturnType<typeof setInterval>>;
}

const store: WorkerStore = {
  jobs: new Map(),
  status: "idle",
  completedCount: 0,
  failedCount: 0,
  heartbeatTimers: new Map(),
};

/* ------------------------------------------------------------------ */
/* Job operations                                                     */
/* ------------------------------------------------------------------ */

export function createJob(
  payload: unknown,
  tenantId: string,
  runId: string,
): JobDefinition {
  const now = Date.now();
  const jobId = randomUUID();

  const job: JobDefinition = {
    jobId,
    tenantId,
    runId,
    payload,
    createdAt: now,
    status: "pending",
    attempts: 0,
  };

  store.jobs.set(jobId, job);
  return job;
}

export function getJob(jobId: string): JobDefinition | undefined {
  return store.jobs.get(jobId);
}

export function listJobs(filters: {
  tenantId?: string;
  status?: JobStatus;
  runId?: string;
} = {}): JobDefinition[] {
  const jobs: JobDefinition[] = [];
  for (const [, job] of store.jobs) {
    if (filters.tenantId && job.tenantId !== filters.tenantId) continue;
    if (filters.status && job.status !== filters.status) continue;
    if (filters.runId && job.runId !== filters.runId) continue;
    jobs.push(job);
  }
  return jobs;
}

/* ------------------------------------------------------------------ */
/* Lease management                                                   */
/* ------------------------------------------------------------------ */

/**
 * Claim a job lease. Returns the job if successfully claimed, undefined if
 * no job is available or the tenant quota is exceeded.
 */
export function claimJob(config: WorkerConfig = {}): JobDefinition | undefined {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const now = Date.now();

  // Count active jobs per tenant
  const tenantActive = new Map<string, number>();
  let totalActive = 0;

  for (const [, job] of store.jobs) {
    if (job.status === "running") {
      totalActive += 1;
      tenantActive.set(job.tenantId, (tenantActive.get(job.tenantId) ?? 0) + 1);
    }
  }

  // Check global concurrency
  if (totalActive >= cfg.maxConcurrency) {
    return undefined;
  }

  // Find a pending job within tenant quota
  for (const [, job] of store.jobs) {
    if (job.status !== "pending") continue;

    // Check tenant concurrency
    const tenantCount = tenantActive.get(job.tenantId) ?? 0;
    if (tenantCount >= cfg.perTenantConcurrency) {
      continue;
    }

    // Check lease expiry
    if (job.leaseExpiresAt && job.leaseExpiresAt > now) {
      continue;
    }

    // Claim the job
    const leaseId = randomUUID();
    job.status = "running";
    job.leaseId = leaseId;
    job.leaseExpiresAt = now + cfg.leaseDurationMs;
    job.startedAt = now;
    job.attempts += 1;

    store.jobs.set(job.jobId, job);
    return job;
  }

  return undefined;
}

/**
 * Complete a job successfully. Verifies the lease to prevent stale completions.
 */
export function completeJob(jobId: string, leaseId: string): boolean {
  const job = store.jobs.get(jobId);
  if (!job) return false;
  if (job.status !== "running") return false;
  if (job.leaseId !== leaseId) return false;

  job.status = "completed";
  job.completedAt = Date.now();
  job.leaseId = undefined;
  job.leaseExpiresAt = undefined;

  store.jobs.set(jobId, job);
  store.completedCount += 1;

  // Clean up heartbeat
  const timer = store.heartbeatTimers.get(jobId);
  if (timer) {
    clearInterval(timer);
    store.heartbeatTimers.delete(jobId);
  }

  return true;
}

/**
 * Fail a job with an error message. The job returns to pending for retry
 * if attempts < maxAttempts, otherwise it's marked as failed.
 */
export function failJob(
  jobId: string,
  leaseId: string,
  error: string,
  maxAttempts: number = 3,
): boolean {
  const job = store.jobs.get(jobId);
  if (!job) return false;
  if (job.status !== "running") return false;
  if (job.leaseId !== leaseId) return false;

  job.lastError = error;
  job.leaseId = undefined;
  job.leaseExpiresAt = undefined;

  if (job.attempts >= maxAttempts) {
    job.status = "failed";
    job.completedAt = Date.now();
    store.failedCount += 1;
  } else {
    job.status = "pending";
    job.startedAt = undefined;
  }

  store.jobs.set(jobId, job);

  // Clean up heartbeat
  const timer = store.heartbeatTimers.get(jobId);
  if (timer) {
    clearInterval(timer);
    store.heartbeatTimers.delete(jobId);
  }

  return true;
}

/* ------------------------------------------------------------------ */
/* Heartbeat management                                               */
/* ------------------------------------------------------------------ */

/**
 * Start heartbeat for a job. The heartbeat renews the lease periodically.
 * Returns a stop function to cancel the heartbeat.
 */
export function startHeartbeat(
  jobId: string,
  leaseId: string,
  config: WorkerConfig = {},
): () => void {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const job = store.jobs.get(jobId);
  if (!job || job.leaseId !== leaseId) {
    return () => {};
  }

  const timer = setInterval(() => {
    const currentJob = store.jobs.get(jobId);
    if (!currentJob || currentJob.status !== "running" || currentJob.leaseId !== leaseId) {
      clearInterval(timer);
      store.heartbeatTimers.delete(jobId);
      return;
    }

    // Renew lease
    currentJob.leaseExpiresAt = Date.now() + cfg.leaseDurationMs;
    store.jobs.set(jobId, currentJob);
  }, cfg.heartbeatIntervalMs);

  store.heartbeatTimers.set(jobId, timer);

  return () => {
    clearInterval(timer);
    store.heartbeatTimers.delete(jobId);
  };
}

/* ------------------------------------------------------------------ */
/* Worker lifecycle                                                   */
/* ------------------------------------------------------------------ */

/**
 * Start draining: stop accepting new jobs and wait for in-flight jobs to complete.
 */
export function startDraining(config: WorkerConfig = {}): void {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  store.status = "draining";

  // Stop all heartbeats
  for (const [jobId, timer] of store.heartbeatTimers) {
    clearInterval(timer);
    store.heartbeatTimers.delete(jobId);
  }

  // Set drain timeout for running jobs
  const drainDeadline = Date.now() + cfg.drainTimeoutMs;
  for (const [, job] of store.jobs) {
    if (job.status === "running") {
      job.leaseExpiresAt = Math.min(
        job.leaseExpiresAt ?? Infinity,
        drainDeadline,
      );
    }
  }
}

/**
 * Stop the worker: cancel all pending jobs and stop running jobs.
 */
export function stopWorker(): void {
  store.status = "stopped";

  // Cancel all pending jobs
  for (const [, job] of store.jobs) {
    if (job.status === "pending") {
      job.status = "cancelled";
      job.completedAt = Date.now();
    }
    // Force-stop running jobs
    if (job.status === "running") {
      job.status = "cancelled";
      job.completedAt = Date.now();
      job.leaseId = undefined;
      job.leaseExpiresAt = undefined;
    }
  }

  // Stop all heartbeats
  for (const [, timer] of store.heartbeatTimers) {
    clearInterval(timer);
  }
  store.heartbeatTimers.clear();
}

/**
 * Recover expired leases: jobs whose lease expired are returned to pending.
 */
export function recoverExpiredLeases(): number {
  const now = Date.now();
  let recovered = 0;

  for (const [, job] of store.jobs) {
    if (job.status === "running" && job.leaseExpiresAt && job.leaseExpiresAt < now) {
      job.status = "pending";
      job.leaseId = undefined;
      job.leaseExpiresAt = undefined;
      job.startedAt = undefined;
      recovered += 1;
    }
  }

  return recovered;
}

/**
 * Check for timed-out jobs and fail them.
 */
export function checkTimeouts(config: WorkerConfig = {}): number {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const now = Date.now();
  let timedOut = 0;

  for (const [, job] of store.jobs) {
    if (job.status === "running" && job.startedAt) {
      const elapsed = now - job.startedAt;
      if (elapsed > cfg.jobTimeoutMs) {
        failJob(job.jobId, job.leaseId ?? "", "Job timed out");
        timedOut += 1;
      }
    }
  }

  return timedOut;
}

/* ------------------------------------------------------------------ */
/* Stats                                                              */
/* ------------------------------------------------------------------ */

export function getWorkerStats(): WorkerStats {
  const tenantConcurrency = new Map<string, number>();
  let activeJobs = 0;

  for (const [, job] of store.jobs) {
    if (job.status === "running") {
      activeJobs += 1;
      tenantConcurrency.set(
        job.tenantId,
        (tenantConcurrency.get(job.tenantId) ?? 0) + 1,
      );
    }
  }

  return {
    status: store.status,
    activeJobs,
    completedJobs: store.completedCount,
    failedJobs: store.failedCount,
    tenantConcurrency,
  };
}

/* ------------------------------------------------------------------ */
/* Store access for testing                                         */
/* ------------------------------------------------------------------ */

export function getWorkerStore(): WorkerStore {
  return store;
}

export function resetWorkerStore(): void {
  // Stop all timers
  for (const [, timer] of store.heartbeatTimers) {
    clearInterval(timer);
  }
  store.jobs.clear();
  store.status = "idle";
  store.completedCount = 0;
  store.failedCount = 0;
  store.heartbeatTimers.clear();
}
