import { describe, expect, it } from "vitest";
import {
  PgEventStore,
  isUniqueViolation,
  ForgeWatchEventType,
  parseForgeWatchEvent,
  forgeWatchEvent,
} from "../src/index.js";

const base = {
  runId: "run_pg_1",
  trialId: "trial_pg_1",
  agentId: "agent_pg_1",
  tenantId: "tenant_pg_1",
  eventType: ForgeWatchEventType.agentTurnStart,
  source: "forge-runner",
} as const;

async function makeEvent(sequence: number) {
  return parseForgeWatchEvent(forgeWatchEvent(base, { sequence }));
}

describe("PgEventStore", () => {
  it("appends an event with the expected SQL shape", async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const event = await makeEvent(1);
    const store = new PgEventStore(async (text, params) => {
      calls.push({ text, params });
      return { rows: [{ event_id: event.eventId }] };
    });
    expect(await store.append(event)).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].text).toContain("INSERT INTO forge_watch_events");
    expect(calls[0].params?.[0]).toBe(event.eventId);
    expect(calls[0].params?.[3]).toBe("run_pg_1");
    expect(calls[0].params?.[8]).toBe(1);
  });

  it("translates unique violations to duplicate errors", async () => {
    const store = new PgEventStore(async (text) => {
      if (text.includes("INSERT INTO forge_watch_events")) {
        const err = new Error("unique violation") as Error & { code: string };
        err.code = "23505";
        throw err;
      }
      return { rows: [] };
    });
    const event = await makeEvent(1);
    await expect(store.append(event)).rejects.toThrow(/run sequence conflict/);
  });

  it("isUniqueViolation detects PG 23505", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  it("treats an identical event-id redelivery as an idempotent no-op", async () => {
    const event = await makeEvent(1);
    let insertCount = 0;
    const store = new PgEventStore(async (text) => {
      if (text.includes("INSERT INTO forge_watch_events")) {
        insertCount += 1;
        return insertCount === 1
          ? { rows: [{ event_id: event.eventId }] }
          : { rows: [] };
      }
      return { rows: [{ envelope: event }] };
    });

    expect(await store.append(event)).toBe(true);
    expect(await store.append(event)).toBe(false);
  });

  it("rejects an event id replayed with different canonical bytes", async () => {
    const event = await makeEvent(1);
    const conflicting = await makeEvent(1);
    conflicting.toolId = "different-tool";
    const store = new PgEventStore(async (text) => {
      if (text.includes("INSERT INTO forge_watch_events")) return { rows: [] };
      return { rows: [{ envelope: event }] };
    });

    await expect(store.append(conflicting)).rejects.toThrow(/event id conflict/);
  });

  it("get returns null when no row", async () => {
    const store = new PgEventStore(async () => ({ rows: [] }));
    expect(await store.get("run_pg_1", 1)).toBeNull();
  });

  it("list returns events from envelope column", async () => {
    const event = await makeEvent(1);
    const store = new PgEventStore(async () => ({
      rows: [{ envelope: event }],
    }));
    const list = await store.list("run_pg_1");
    expect(list).toHaveLength(1);
    expect(list[0].eventId).toBe(event.eventId);
  });

  it("markDispatched is a no-op for empty input", async () => {
    let called = false;
    const store = new PgEventStore(async () => {
      called = true;
      return { rows: [] };
    });
    await store.markDispatched([]);
    expect(called).toBe(false);
  });

  it("markDispatched updates by event ids", async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const store = new PgEventStore(async (text, params) => {
      calls.push({ text, params });
      return { rows: [] };
    });
    await store.markDispatched(["a", "b"], 123);
    expect(calls[0].text).toContain("UPDATE forge_watch_events SET dispatched_at");
    expect(calls[0].params).toEqual([["a", "b"], 123]);
  });
});
