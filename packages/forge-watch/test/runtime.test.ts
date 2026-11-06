import { describe, expect, it } from "vitest";
import {
  createForgeWatchRuntime,
  ForgeWatchEventType,
  parseForgeWatchEvent,
  forgeWatchEvent,
} from "../src/index.js";

const base = {
  runId: "run_rt_1",
  trialId: "trial_rt_1",
  agentId: "agent_rt_1",
  tenantId: "tenant_rt_1",
  eventType: ForgeWatchEventType.agentTurnStart,
  source: "forge-runner",
} as const;

describe("Forge Watch runtime", () => {
  it("creates an in-memory runtime by default", async () => {
    const rt = createForgeWatchRuntime({ persist: false });
    const event = parseForgeWatchEvent(forgeWatchEvent(base, { sequence: 1 }));
    await rt.emitEvent(event);
    const list = await rt.collector.list("run_rt_1");
    expect(list).toHaveLength(1);
    await rt.close();
  });

  it("rejects persist mode without a PG executor", () => {
    expect(() => createForgeWatchRuntime({ persist: true })).toThrow(/pgExecutor/);
  });

  it("uses PG store and flushes findings when executor is provided", async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const exec = async <T = unknown>(text: string, params?: unknown[]) => {
      calls.push({ text, params });
      return { rows: [] as T[] };
    };
    const rt = createForgeWatchRuntime({ persist: true, pgExecutor: exec });
    const event = parseForgeWatchEvent(forgeWatchEvent(base, { sequence: 1 }));
    await rt.emitEvent(event);
    expect(calls.some((c) => c.text.includes("INSERT INTO forge_watch_events"))).toBe(true);

    // Force a gap finding via the runtime sequencer.
    const e3 = parseForgeWatchEvent(forgeWatchEvent(base, { sequence: 3, eventId: crypto.randomUUID() }));
    await rt.emitEvent(e3);
    const flushed = await rt.flushFindings("run_rt_1");
    expect(flushed).toBeGreaterThan(0);
    expect(calls.some((c) => c.text.includes("INSERT INTO forge_watch_findings"))).toBe(true);
  });

  it("respects FORGE_WATCH_PERSIST env (false by default)", async () => {
    const prev = process.env.FORGE_WATCH_PERSIST;
    delete process.env.FORGE_WATCH_PERSIST;
    const rt = createForgeWatchRuntime();
    expect(rt.store.constructor.name).toBe("InMemoryEventStore");
    if (prev === undefined) delete process.env.FORGE_WATCH_PERSIST;
    else process.env.FORGE_WATCH_PERSIST = prev;
  });
});
