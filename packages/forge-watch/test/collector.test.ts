import { describe, expect, it } from "vitest";
import {
  InMemoryEventStore,
  TelemetryCollector,
  ForgeWatchEventType,
  parseForgeWatchEvent,
  forgeWatchEvent,
  defaultSequencer,
} from "../src/index.js";

const base = {
  runId: "run_collect_1",
  trialId: "trial_collect_1",
  agentId: "agent_collect_1",
  tenantId: "tenant_collect_1",
  eventType: ForgeWatchEventType.agentTurnStart,
  source: "forge-runner",
} as const;

async function makeEvent(overrides: Record<string, unknown> = {}) {
  const event = forgeWatchEvent(base, {
    sequence: 1,
    ...overrides,
  });
  return parseForgeWatchEvent(event);
}

describe("telemetry collector", () => {
  it("accepts a valid event and assigns a sequence", async () => {
    const store = new InMemoryEventStore();
    const collector = new TelemetryCollector({ store });
    const event = await makeEvent();
    const seq = await collector.accept(event);
    expect(seq).toBe(1);

    const got = await collector.get("run_collect_1", 1);
    expect(got).not.toBeNull();
    expect(got!.runId).toBe("run_collect_1");
  });

  it("assigns monotonic sequences per run", async () => {
    const store = new InMemoryEventStore();
    const collector = new TelemetryCollector({ store });
    const a = await collector.accept(await makeEvent({ sequence: 1 }));
    const b = await collector.accept(await makeEvent({ sequence: 2 }));
    expect(a).toBe(1);
    expect(b).toBe(2);

    const list = await collector.list("run_collect_1");
    expect(list.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it("treats an exact redelivery as an idempotent no-op", async () => {
    const store = new InMemoryEventStore();
    const collector = new TelemetryCollector({ store });
    const event = await makeEvent();

    expect(await collector.accept(event)).toBe(1);
    expect(await collector.accept(event)).toBe(1);
    expect(await collector.list(event.runId)).toHaveLength(1);
    expect(collector.stats.accepted).toBe(1);
    expect(collector.stats.rejected).toBe(0);
  });

  it("rejects reuse of an event id with a different payload", async () => {
    const store = new InMemoryEventStore();
    const collector = new TelemetryCollector({ store });
    const event = await makeEvent();
    await collector.accept(event);

    const conflicting = await makeEvent({
      eventId: event.eventId,
      sequence: 1,
      toolId: "different-tool",
    });

    await expect(collector.accept(conflicting)).rejects.toThrow(/event id conflict/i);
    expect(await collector.list(event.runId)).toHaveLength(1);
    expect(collector.stats.rejected).toBe(0);
  });

  it("does not advance the sequence cursor when durable append fails", async () => {
    class FailOnceStore extends InMemoryEventStore {
      private failures = 1;
      override async append(event: Awaited<ReturnType<typeof makeEvent>>) {
        if (this.failures > 0) {
          this.failures -= 1;
          throw new Error("postgres unavailable");
        }
        await super.append(event);
      }
    }

    const store = new FailOnceStore();
    const collector = new TelemetryCollector({ store });
    const event = await makeEvent();

    await expect(collector.accept(event)).rejects.toThrow("postgres unavailable");
    expect(await collector.accept(event)).toBe(1);
    expect((await collector.list(event.runId)).map((item) => item.sequence)).toEqual([1]);
  });

  it("tracks accepted/rejected counts", async () => {
    const store = new InMemoryEventStore();
    const collector = new TelemetryCollector({ store });
    const event = await makeEvent();
    await collector.accept(event);
    let threw = false;
    try {
      await collector.accept(event); // duplicate eventId
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(collector.stats.accepted).toBe(1);
    expect(collector.stats.rejected).toBe(1);
  });

  it("returns null for a missing event", async () => {
    const store = new InMemoryEventStore();
    const collector = new TelemetryCollector({ store });
    const got = await collector.get("run_collect_1", 1);
    expect(got).toBeNull();
  });

  it("uses default collector and store", () => {
    expect(defaultSequencer).toBeDefined();
  });
});
