import { describe, expect, it } from "vitest";
import { idempotentMonitorProcessor, l0Processor } from "../src/forge-watch-workers.js";

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
});
