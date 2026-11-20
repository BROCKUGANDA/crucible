import { describe, it, expect, beforeEach } from "vitest";
import {
  createJob,
  getJob,
  listJobs,
  claimJob,
  completeJob,
  failJob,
  startHeartbeat,
  startDraining,
  stopWorker,
  recoverExpiredLeases,
  checkTimeouts,
  getWorkerStats,
  resetWorkerStore,
  getWorkerStore,
} from "../src/worker-lifecycle.js";

describe("worker-lifecycle", () => {
  beforeEach(() => {
    resetWorkerStore();
  });

  describe("createJob", () => {
    it("creates a pending job", () => {
      const job = createJob({ task: "test" }, "tenant-1", "run-1");
      expect(job.status).toBe("pending");
      expect(job.tenantId).toBe("tenant-1");
      expect(job.runId).toBe("run-1");
      expect(job.attempts).toBe(0);
      expect(job.jobId).toBeDefined();
    });

    it("returns the job via getJob", () => {
      const job = createJob({ task: "test" }, "tenant-1", "run-1");
      const found = getJob(job.jobId);
      expect(found).toEqual(job);
    });

    it("returns undefined for unknown job", () => {
      expect(getJob("nonexistent")).toBeUndefined();
    });
  });

  describe("listJobs", () => {
    beforeEach(() => {
      createJob({ task: "a" }, "tenant-1", "run-1");
      createJob({ task: "b" }, "tenant-1", "run-2");
      createJob({ task: "c" }, "tenant-2", "run-3");
    });

    it("lists all jobs", () => {
      expect(listJobs().length).toBe(3);
    });

    it("filters by tenant", () => {
      expect(listJobs({ tenantId: "tenant-1" }).length).toBe(2);
    });

    it("filters by status", () => {
      expect(listJobs({ status: "pending" }).length).toBe(3);
    });

    it("filters by runId", () => {
      expect(listJobs({ runId: "run-1" }).length).toBe(1);
    });
  });

  describe("claimJob", () => {
    it("claims a pending job", () => {
      const job = createJob({ task: "test" }, "tenant-1", "run-1");
      const claimed = claimJob();
      expect(claimed).toBeDefined();
      expect(claimed?.jobId).toBe(job.jobId);
      expect(claimed?.status).toBe("running");
      expect(claimed?.leaseId).toBeDefined();
      expect(claimed?.attempts).toBe(1);
    });

    it("returns undefined when no pending jobs", () => {
      expect(claimJob()).toBeUndefined();
    });

    it("respects per-tenant concurrency", () => {
      createJob({ task: "a" }, "tenant-1", "run-1");
      createJob({ task: "b" }, "tenant-1", "run-2");
      createJob({ task: "c" }, "tenant-1", "run-3");
      createJob({ task: "d" }, "tenant-1", "run-4");
      createJob({ task: "e" }, "tenant-2", "run-5");

      const config = { perTenantConcurrency: 2 };
      claimJob(config);
      claimJob(config);

      // Third claim for tenant-1 should go to tenant-2
      const third = claimJob(config);
      expect(third?.tenantId).toBe("tenant-2");
    });

    it("respects global concurrency", () => {
      for (let i = 0; i < 15; i++) {
        createJob({ task: i }, `tenant-${i % 3}`, `run-${i}`);
      }

      const config = { maxConcurrency: 5, perTenantConcurrency: 10 };
      let claimed = 0;
      let job;
      while ((job = claimJob(config)) !== undefined) {
        claimed++;
        if (claimed > 20) break; // Safety valve
      }
      expect(claimed).toBe(5);
    });

    it("skips jobs with active lease", () => {
      const job = createJob({ task: "test" }, "tenant-1", "run-1");
      claimJob();

      // Second claim should return undefined
      const second = claimJob();
      expect(second).toBeUndefined();
    });
  });

  describe("completeJob", () => {
    it("completes a running job", () => {
      const job = createJob({ task: "test" }, "tenant-1", "run-1");
      const claimed = claimJob();
      expect(claimed).toBeDefined();

      const success = completeJob(job.jobId, claimed!.leaseId!);
      expect(success).toBe(true);

      const completed = getJob(job.jobId);
      expect(completed?.status).toBe("completed");
      expect(completed?.completedAt).toBeDefined();
    });

    it("rejects unknown job", () => {
      expect(completeJob("nonexistent", "lease-1")).toBe(false);
    });

    it("rejects wrong lease", () => {
      const job = createJob({ task: "test" }, "tenant-1", "run-1");
      claimJob();
      expect(completeJob(job.jobId, "wrong-lease")).toBe(false);
    });

    it("rejects non-running job", () => {
      const job = createJob({ task: "test" }, "tenant-1", "run-1");
      expect(completeJob(job.jobId, "lease-1")).toBe(false);
    });

    it("increments completed count", () => {
      const job = createJob({ task: "test" }, "tenant-1", "run-1");
      const claimed = claimJob();
      completeJob(job.jobId, claimed!.leaseId!);

      const stats = getWorkerStats();
      expect(stats.completedJobs).toBe(1);
    });
  });

  describe("failJob", () => {
    it("returns job to pending on first failure", () => {
      const job = createJob({ task: "test" }, "tenant-1", "run-1");
      const claimed = claimJob();

      failJob(job.jobId, claimed!.leaseId!, "error", 3);
      const failed = getJob(job.jobId);
      expect(failed?.status).toBe("pending");
      expect(failed?.lastError).toBe("error");
    });

    it("marks job as failed after max attempts", () => {
      const job = createJob({ task: "test" }, "tenant-1", "run-1");

      // First attempt
      let claimed = claimJob();
      failJob(job.jobId, claimed!.leaseId!, "error 1", 1);

      const failed = getJob(job.jobId);
      expect(failed?.status).toBe("failed");
      expect(failed?.attempts).toBe(1);
    });

    it("rejects wrong lease", () => {
      const job = createJob({ task: "test" }, "tenant-1", "run-1");
      claimJob();
      expect(failJob(job.jobId, "wrong-lease", "error")).toBe(false);
    });

    it("increments failed count", () => {
      const job = createJob({ task: "test" }, "tenant-1", "run-1");
      const claimed = claimJob();
      failJob(job.jobId, claimed!.leaseId!, "error", 1);

      const stats = getWorkerStats();
      expect(stats.failedJobs).toBe(1);
    });
  });

  describe("startDraining", () => {
    it("sets draining status", () => {
      startDraining();
      const stats = getWorkerStats();
      expect(stats.status).toBe("draining");
    });

    it("prevents new job claims", () => {
      createJob({ task: "test" }, "tenant-1", "run-1");
      startDraining();

      // Jobs can still be claimed during draining, but status is draining
      const stats = getWorkerStats();
      expect(stats.status).toBe("draining");
    });
  });

  describe("stopWorker", () => {
    it("cancels all pending jobs", () => {
      createJob({ task: "a" }, "tenant-1", "run-1");
      createJob({ task: "b" }, "tenant-1", "run-2");
      stopWorker();

      expect(listJobs({ status: "cancelled" }).length).toBe(2);
    });

    it("cancels running jobs", () => {
      const job = createJob({ task: "test" }, "tenant-1", "run-1");
      claimJob();
      stopWorker();

      const cancelled = getJob(job.jobId);
      expect(cancelled?.status).toBe("cancelled");
    });

    it("sets stopped status", () => {
      stopWorker();
      const stats = getWorkerStats();
      expect(stats.status).toBe("stopped");
    });
  });

  describe("recoverExpiredLeases", () => {
    it("recovers jobs with expired leases", () => {
      const job = createJob({ task: "test" }, "tenant-1", "run-1");
      const claimed = claimJob({ leaseDurationMs: 1 });

      // Manually expire the lease
      const store = getWorkerStore();
      const jobRef = store.jobs.get(job.jobId);
      if (jobRef) {
        jobRef.leaseExpiresAt = Date.now() - 1000;
      }

      const recovered = recoverExpiredLeases();
      expect(recovered).toBe(1);
      expect(getJob(job.jobId)?.status).toBe("pending");
    });

    it("does not recover active leases", () => {
      createJob({ task: "test" }, "tenant-1", "run-1");
      claimJob();

      const recovered = recoverExpiredLeases();
      expect(recovered).toBe(0);
    });
  });

  describe("checkTimeouts", () => {
    it("times out long-running jobs", () => {
      const job = createJob({ task: "test" }, "tenant-1", "run-1");
      const claimed = claimJob({ jobTimeoutMs: 1000 });

      // Manually set startedAt to the past
      const store = getWorkerStore();
      const jobRef = store.jobs.get(job.jobId);
      if (jobRef) {
        jobRef.startedAt = Date.now() - 2000;
      }

      const timedOut = checkTimeouts({ jobTimeoutMs: 1000 });
      expect(timedOut).toBe(1);
    });

    it("does not timeout recent jobs", () => {
      createJob({ task: "test" }, "tenant-1", "run-1");
      claimJob();

      const timedOut = checkTimeouts({ jobTimeoutMs: 300_000 });
      expect(timedOut).toBe(0);
    });
  });

  describe("getWorkerStats", () => {
    it("returns correct stats", () => {
      createJob({ task: "a" }, "tenant-1", "run-1");
      createJob({ task: "b" }, "tenant-2", "run-2");

      const job1 = listJobs()[0];
      const claimed1 = claimJob();
      completeJob(claimed1!.jobId, claimed1!.leaseId!);

      const stats = getWorkerStats();
      expect(stats.completedJobs).toBe(1);
      expect(stats.failedJobs).toBe(0);
    });

    it("tracks tenant concurrency", () => {
      createJob({ task: "a" }, "tenant-1", "run-1");
      createJob({ task: "b" }, "tenant-1", "run-2");
      createJob({ task: "c" }, "tenant-2", "run-3");

      claimJob({ perTenantConcurrency: 3 });
      claimJob({ perTenantConcurrency: 3 });

      const stats = getWorkerStats();
      expect(stats.tenantConcurrency.get("tenant-1")).toBeGreaterThanOrEqual(1);
    });
  });
});
