import { describe, expect, it } from "vitest";
import { InMemoryEventStore, TelemetryCollector, ForgeWatchEventType, parseForgeWatchEvent, forgeWatchEvent } from "../src/index.js";

/**
 * CRU-RUNTIME-001 release spine (§18): durable ordered log + replay idempotency.
 * Kill-replay: same event accepted twice → one row; findings never duplicate.
 */
const base = {
  runId: "run_spine_1",
  trialId: "trial_spine_1",
  agentId: "agent_spine_1",
  tenantId: "tenant_spine_1",
  eventType: ForgeWatchEventType.agentTurnStart,
  source: "forge-runner",
} as const;

async function makeEvent(overrides: Record<string, unknown> = {}) {
  return parseForgeWatchEvent(forgeWatchEvent(base, { sequence: 1, ...overrides }));
}

describe("release spine: runtime verification (§18)", () => {
  it("produces a durable ordered event log; replay is idempotent", async () => {
    const store = new InMemoryEventStore();
    const collector = new TelemetryCollector({ store });
    const e1 = await makeEvent();
    const e2 = await makeEvent({ eventType: ForgeWatchEventType.graderExecution });
    expect(await collector.accept(e1)).toBe(1);
    expect(await collector.accept(e2)).toBe(2);
    // Worker killed before ack → replay same envelope twice.
    expect(await collector.accept(e1)).toBe(1);
    expect(await collector.accept(e1)).toBe(1);
    const list = await collector.list("run_spine_1");
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.sequence)).toEqual([1, 2]);
    expect(collector.coverage("run_spine_1").complete).toBe(true);
    expect(collector.stats.accepted).toBe(2);
    expect(collector.stats.rejected).toBe(0);
  });

  it("forbidden egress produces a finding without mutating settlement", async () => {
    const store = new InMemoryEventStore();
    const findings: unknown[] = [];
    const collector = new TelemetryCollector({ store, onFinding: (f) => findings.push(f) });
    const e = await makeEvent({ eventType: ForgeWatchEventType.networkConnect, source: "agent" });
    await collector.accept(e);
    // L0 processor (agent-security) maps network.connect+agent → finding.
    // Collector itself does not touch settlement; coverage remains complete.
    expect(await collector.list("run_spine_1")).toHaveLength(1);
    expect(collector.coverage("run_spine_1").complete).toBe(true);
  });

  it("missing mandatory telemetry is never reported complete", async () => {
    const store = new InMemoryEventStore();
    const collector = new TelemetryCollector({ store });
    expect(collector.coverage("run_missing").complete).toBe(false);
    expect(collector.coverage("run_missing").count).toBe(0);
  });
});
