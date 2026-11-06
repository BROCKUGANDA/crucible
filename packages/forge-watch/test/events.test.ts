import { describe, expect, it } from "vitest";
import {
  ForgeWatchEventSchema,
  ForgeWatchEventType,
  FORGE_WATCH_SCHEMA_VERSION,
  parseForgeWatchEvent,
  safeParseForgeWatchEvent,
  forgeWatchEvent,
} from "../src/events.js";

const base = {
  runId: "run_1",
  trialId: "trial_1",
  agentId: "agent_1",
  tenantId: "tenant_1",
  eventType: ForgeWatchEventType.agentTurnStart,
  source: "forge-runner",
} as const;

describe("canonical event envelope", () => {
  it("accepts a fully-populated envelope", () => {
    const event = parseForgeWatchEvent(
      forgeWatchEvent(base, {
        sequence: 1,
        toolId: "run_suite",
        permission: "trial:run",
        authorizationDecision: "allowed",
      }),
    );
    expect(event.schemaVersion).toBe(FORGE_WATCH_SCHEMA_VERSION);
    expect(event.eventType).toBe("agent.turn.start");
    expect(event.sequence).toBe(1);
    expect(typeof event.timestamp).toBe("number");
    expect(typeof event.eventId).toBe("string");
  });

  it("accepts an envelope with only required fields", () => {
    const event = parseForgeWatchEvent(forgeWatchEvent(base, { sequence: 3 }));
    expect(event.providerId).toBeUndefined();
    expect(event.modelId).toBeUndefined();
    expect(event.toolId).toBeUndefined();
    expect(event.authorizationDecision).toBeUndefined();
  });

  it("rejects a wrong schemaVersion", () => {
    const bad = {
      ...forgeWatchEvent(base, { sequence: 1 }),
      schemaVersion: 99,
    };
    const result = safeParseForgeWatchEvent(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("schemaVersion"))).toBe(true);
    }
  });

  it("rejects a missing runId", () => {
    const result = safeParseForgeWatchEvent(
      forgeWatchEvent({ ...base, runId: "" }, { sequence: 1 }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects an unknown eventType", () => {
    const result = safeParseForgeWatchEvent({
      ...forgeWatchEvent(base, { sequence: 1 }),
      eventType: "not.a.real.event",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative sequence", () => {
    const result = safeParseForgeWatchEvent(
      forgeWatchEvent(base, { sequence: -1 }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a non-UUID eventId", () => {
    const result = safeParseForgeWatchEvent(
      forgeWatchEvent(base, { sequence: 1, eventId: "not-a-uuid" }),
    );
    expect(result.success).toBe(false);
  });

  it("safeParse returns the error without throwing", () => {
    const result = safeParseForgeWatchEvent({ not: "an event" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(Error);
  });
});
