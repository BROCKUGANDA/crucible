/**
 * @file worker-service.test.ts — the one background process.
 *
 * The thing this test exists to make unbreakable: the worker registers its
 * schedules, drains, reports and shuts down — and there is exactly one of
 * it. The previous entrypoint (`apps/api/src/worker.ts`) had seven handlers
 * that reported success without doing anything, and a repeat pattern that
 * ran its "hourly" job exactly once because the re-added job's id was
 * already held by the completed job.
 *
 * So these tests assert:
 *
 *   - a schedule is registered with the scheduler, keyed by its id;
 *   - the drain loop runs and stops;
 *   - the service refuses to start without a database and a queue address;
 *   - stopping is idempotent, and the final drain happens.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const scheduled: { id: string; everyMs: number; queueName: string; jobName: string }[] = [];
const closed: string[] = [];

vi.mock("../src/queue.js", async () => {
  const actual = await vi.importActual<typeof import("../src/queue.js")>("../src/queue.js");
  return {
    ...actual,
    scheduleRecurring: async (spec: { id: string; everyMs: number; queueName: string; jobName: string }) => {
      scheduled.push(spec);
    },
    closeQueues: async () => {
      closed.push("queues");
    },
  };
});

vi.mock("../src/database.js", () => ({
  query: async () => ({ rows: [], rowCount: 0 }),
}));

import { startWorkerService } from "../src/worker-service.js";
import type { TelemetryPipeline } from "../src/forge-watch-telemetry.js";

function pipeline(overrides: Partial<TelemetryPipeline> = {}): TelemetryPipeline {
  return {
    drainOnce: async () => 1,
    workers: [] as never,
    deadLetters: {} as never,
    findings: {} as never,
    replay: async () => false,
    resolve: async () => false,
    pendingDeadLetters: async () => [],
    stats: async () => ({ pendingEvents: 0, oldestPendingAgeMs: null, pendingDeadLetters: 0 }),
    purgeDispatched: async () => 0,
    ...overrides,
  } as TelemetryPipeline;
}

describe("startWorkerService", () => {
  beforeEach(() => {
    scheduled.length = 0;
    closed.length = 0;
    process.env.DATABASE_URL = "postgresql://crucible:crucible@localhost:5432/crucible";
    process.env.REDIS_URL = "redis://localhost:6379";
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
    vi.restoreAllMocks();
  });

  it("registers each recurring job with the scheduler", async () => {
    const service = await startWorkerService({
      pipeline: pipeline(),
      jobs: [
        { id: "outbox-retention", everyMs: 900_000, queueName: "maintenance", jobName: "outbox-retention" },
        { id: "dead-letter-report", everyMs: 900_000, queueName: "maintenance", jobName: "dead-letter-report" },
      ],
      onLog: () => {},
    });

    expect(scheduled).toEqual([
      { id: "outbox-retention", everyMs: 900_000, queueName: "maintenance", jobName: "outbox-retention" },
      { id: "dead-letter-report", everyMs: 900_000, queueName: "maintenance", jobName: "dead-letter-report" },
    ]);
    expect(service.scheduledJobIds()).toEqual(["outbox-retention", "dead-letter-report"]);

    await service.stop();
  });

  it("drains on demand and reports the backlog", async () => {
    const drain = vi.fn(async () => 3);
    const service = await startWorkerService({
      pipeline: pipeline({ drainOnce: drain }),
      onLog: () => {},
    });

    expect(await service.drainOnce()).toBe(3);
    expect(drain).toHaveBeenCalledTimes(1);

    const stats = await service.stats();
    expect(stats.pendingEvents).toBe(0);

    await service.stop();
  });

  it("refuses to start without a database address", async () => {
    delete process.env.DATABASE_URL;
    await expect(startWorkerService({ pipeline: pipeline(), onLog: () => {} })).rejects.toThrow(
      /DATABASE_URL is required/,
    );
  });

  it("refuses to start without a queue address", async () => {
    delete process.env.REDIS_URL;
    await expect(startWorkerService({ pipeline: pipeline(), onLog: () => {} })).rejects.toThrow(
      /REDIS_URL is required/,
    );
  });

  it("stops idempotently and closes the queues once", async () => {
    const service = await startWorkerService({ pipeline: pipeline(), onLog: () => {} });

    await service.stop();
    await service.stop();

    expect(closed).toEqual(["queues"]);
  });

  it("drains once more on shutdown so a claimed row is not left in limbo", async () => {
    let drains = 0;
    const service = await startWorkerService({
      pipeline: pipeline({
        drainOnce: async () => {
          drains += 1;
          return 1;
        },
      }),
      onLog: () => {},
    });

    await service.drainOnce();
    await service.stop();

    expect(drains).toBeGreaterThanOrEqual(2);
  });

  it("does not drain after it has stopped", async () => {
    let drains = 0;
    const service = await startWorkerService({
      pipeline: pipeline({
        drainOnce: async () => {
          drains += 1;
          return 1;
        },
      }),
      onLog: () => {},
    });

    await service.stop();
    const after = drains;
    await service.drainOnce();

    expect(drains).toBe(after);
  });
});
