import { describe, expect, it } from "vitest";
import {
  eventJobId,
  runJobId,
  monitorJob,
  monitorEventJob,
  FORGE_WATCH_QUEUE_NAMES,
} from "../src/index.js";

describe("Forge Watch dispatch helpers", () => {
  it("builds stable idempotent event job ids", () => {
    expect(eventJobId("run1", "evt1")).toBe("fw:run1:evt1");
    expect(eventJobId("run1", "evt1")).toBe(eventJobId("run1", "evt1"));
  });

  it("builds stable run job ids", () => {
    expect(runJobId("run1", "l0")).toBe("fw:run:run1:l0");
  });

  it("creates monitor payloads with schema version", () => {
    const p = monitorJob({ runId: "r", phase: "l0", eventId: "e" });
    expect(p.schemaVersion).toBe(1);
    expect(p.runId).toBe("r");
    expect(typeof p.enqueuedAt).toBe("number");
  });

  it("monitorEventJob carries the event the L0 worker inspects", () => {
    const payload = monitorEventJob("r", {
      eventId: "evt-1",
      sequence: 4,
      eventType: "egress.decision",
      source: "gateway",
      authorizationDecision: "denied",
    });
    expect(payload.eventId).toBe("evt-1");
    expect(payload.events).toHaveLength(1);
    expect(payload.events![0]!.authorizationDecision).toBe("denied");
    expect(payload.phase).toBe("l0");
  });

  it("exposes queue names", () => {
    expect(FORGE_WATCH_QUEUE_NAMES.L0).toBe("forge-watch-l0");
    expect(FORGE_WATCH_QUEUE_NAMES.DLQ).toBe("forge-watch-dlq");
  });
});
