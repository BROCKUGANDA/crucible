import { describe, expect, it } from "vitest";
import {
  idempotentMonitorProcessor,
  l0Processor,
  registerForgeWatchWorkers,
  type MonitorFinding,
} from "../src/forge-watch-workers.js";
import { QUEUE_NAMES } from "../src/queue.js";

describe("Forge Watch worker scaffolding", () => {
  it("rejects malformed payloads", async () => {
    const wrapped = idempotentMonitorProcessor(async () => ({ ok: true }));
    await expect(wrapped({ data: {} } as never)).rejects.toThrow(/invalid/);
    await expect(
      wrapped({ data: { schemaVersion: 2, runId: "r", phase: "l0" } } as never),
    ).rejects.toThrow(/invalid/);
  });

  it("runs a valid processor", async () => {
    let called = false;
    const wrapped = idempotentMonitorProcessor(async () => {
      called = true;
      return { ok: true };
    });
    await wrapped({
      data: { schemaVersion: 1, runId: "r1", phase: "l0", enqueuedAt: 1 },
      id: "j1",
    } as never);
    expect(called).toBe(true);
  });

  it("l0 reports a job with no events as skipped, not passed", async () => {
    const res = await l0Processor({
      data: { schemaVersion: 1, runId: "r1", phase: "l0", enqueuedAt: 1 },
      id: "j1",
    } as never);
    expect(res.ok).toBe(true);
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("l0:no-events");
  });

  function jobWith(events: unknown[]) {
    return {
      data: { schemaVersion: 1, runId: "r1", phase: "l0", enqueuedAt: 1, events },
      id: "j1",
    } as never;
  }

  function event(overrides: Record<string, unknown> = {}) {
    return { eventId: "evt-1", sequence: 1, eventType: "provider.request", source: "agent", ...overrides };
  }

  it("passes clean events", async () => {
    const res = await l0Processor(jobWith([event({ sequence: 1 }), event({ eventId: "evt-2", sequence: 2 })]));
    expect(res.reason).toBe("l0:passed");
    expect(res.skipped).toBe(false);
  });

  it("flags a denied egress decision and a denied tool call", async () => {
    const res = await l0Processor(
      jobWith([
        event({ eventId: "e1", sequence: 1, eventType: "egress.decision", authorizationDecision: "denied" }),
        event({ eventId: "e2", sequence: 2, eventType: "tool.call.deny" }),
      ]),
    );
    expect(res.reason).toContain("l0:forbidden-egress:e1");
    expect(res.reason).toContain("l0:forbidden-tool:e2");
  });

  it("flags a test modification", async () => {
    const res = await l0Processor(jobWith([event({ eventType: "test.modification" })]));
    expect(res.reason).toContain("l0:test-modification:evt-1");
  });

  it("flags a sequence gap and a sequence regression", async () => {
    const gap = await l0Processor(jobWith([event({ sequence: 1 }), event({ eventId: "e2", sequence: 3 })]));
    expect(gap.reason).toContain("l0:sequence-gap:1->3");

    const regression = await l0Processor(
      jobWith([event({ sequence: 5 }), event({ eventId: "e2", sequence: 5 })]),
    );
    expect(regression.reason).toContain("l0:sequence-regression:5->5");
  });

  it("emits the findings it detected as structured records", async () => {
    const res = await l0Processor(
      jobWith([
        event({ eventId: "e1", sequence: 1 }),
        event({ eventId: "e2", sequence: 3, eventType: "egress.decision", authorizationDecision: "denied" }),
      ]),
    );

    // The prose is what an operator reads; the structured findings are what
    // can be persisted. Both must name the same problems.
    expect(res.reason).toContain("l0:sequence-gap:1->3");
    expect(res.reason).toContain("l0:forbidden-egress:e2");

    const kinds = (res.findings ?? []).map((f) => f.kind).sort();
    expect(kinds).toEqual(["forbidden-egress", "gap"]);

    const gap = (res.findings ?? []).find((f) => f.kind === "gap")!;
    expect(gap.expected).toBe(1);
    expect(gap.observed).toBe(3);
    expect(gap.detail).toContain("sequence gap");
  });

  it("hands the detected findings to the sink instead of discarding them", async () => {
    const recorded: (MonitorFinding & { runId: string })[] = [];
    const wrapped = idempotentMonitorProcessor(l0Processor, {
      async record(finding) {
        recorded.push(finding);
      },
    });

    await wrapped({
      data: {
        schemaVersion: 1,
        runId: "run-7",
        phase: "l0",
        enqueuedAt: 1,
        events: [
          { eventId: "e1", sequence: 1, eventType: "provider.request", source: "agent" },
          { eventId: "e2", sequence: 2, eventType: "tool.call.deny", source: "agent" },
        ],
      },
      id: "j1",
    } as never);

    // Before this, the detection died inside the worker: the processor
    // returned its findings and the caller discarded the result, so
    // `forge_watch_findings` was only ever empty.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.kind).toBe("forbidden-tool");
    expect(recorded[0]!.eventId).toBe("e2");
    // The run the finding belongs to is attached here, where it is known.
    expect(recorded[0]!.runId).toBe("run-7");
  });

  it("does not call the sink when there is nothing to report", async () => {
    const recorded: unknown[] = [];
    const wrapped = idempotentMonitorProcessor(l0Processor, {
      async record(finding) {
        recorded.push(finding);
      },
    });

    await wrapped({
      data: {
        schemaVersion: 1,
        runId: "run-7",
        phase: "l0",
        enqueuedAt: 1,
        events: [{ eventId: "e1", sequence: 1, eventType: "provider.request", source: "agent" }],
      },
      id: "j1",
    } as never);

    expect(recorded).toEqual([]);
  });
});

/**
 * The registration path, not the wrapper.
 *
 * The wrapper honoured a finding sink, and a test proved that — while the
 * registration, which is what production actually calls, did not pass the
 * sink down, so the finding was still discarded. Removing the `opts?.onFinding`
 * argument from the L0 registration left every other test green. This is the
 * test that closes that gap: it drives the registration, so the wiring
 * between the two cannot drift apart silently.
 */
describe("worker registration wiring", () => {
  function fakeFactory() {
    const registered: {
      name: string;
      processor: (job: unknown) => Promise<void>;
    }[] = [];
    const factory = (name: string, processor: (job: never) => Promise<void>) => {
      registered.push({ name, processor: processor as (job: unknown) => Promise<void> });
      return {
        on: () => undefined,
        close: async () => undefined,
      } as never;
    };
    return { registered, factory };
  }

  it("hands the registered L0 processor the finding sink", async () => {
    const { registered, factory } = fakeFactory();
    const recorded: (MonitorFinding & { runId: string })[] = [];

    registerForgeWatchWorkers({
      createWorker: factory as never,
      onFinding: {
        async record(finding) {
          recorded.push(finding);
        },
      },
    });

    const l0 = registered.find((r) => r.name === QUEUE_NAMES.FORGE_WATCH_L0);
    expect(l0).toBeDefined();

    await l0!.processor({
      data: {
        schemaVersion: 1,
        runId: "run-9",
        phase: "l0",
        enqueuedAt: 1,
        events: [
          { eventId: "e1", sequence: 1, eventType: "provider.request", source: "agent" },
          { eventId: "e2", sequence: 2, eventType: "test.modification", source: "agent" },
        ],
      },
      id: "j1",
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.kind).toBe("test-modification");
    expect(recorded[0]!.runId).toBe("run-9");
  });

  it("acknowledges the events the consumer finished with", async () => {
    const { registered, factory } = fakeFactory();
    const acked: { runId: string; eventIds: string[] }[] = [];

    registerForgeWatchWorkers({
      createWorker: factory as never,
      onAcknowledge: {
        async acknowledge(runId, eventIds) {
          acked.push({ runId, eventIds });
        },
      },
    });

    const l0 = registered.find((r) => r.name === QUEUE_NAMES.FORGE_WATCH_L0)!;
    await l0.processor({
      data: {
        schemaVersion: 1,
        runId: "run-11",
        phase: "l0",
        enqueuedAt: 1,
        events: [
          { eventId: "e1", sequence: 1, eventType: "provider.request", source: "agent" },
          { eventId: "e2", sequence: 2, eventType: "provider.request", source: "agent" },
        ],
      },
      id: "j1",
    });

    // The relay said the event was handed over; this says the consumer
    // finished with it. Without the pair, "handed over but never
    // acknowledged" is not a question the database can answer.
    expect(acked).toHaveLength(1);
    expect(acked[0]!.runId).toBe("run-11");
    expect(acked[0]!.eventIds).toEqual(["e1", "e2"]);
  });
});
