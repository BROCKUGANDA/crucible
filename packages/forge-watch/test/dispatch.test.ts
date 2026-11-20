import { describe, expect, it } from "vitest";
import {
  eventJobId,
  runJobId,
  deliveryJobId,
  replayJobId,
  jobIdPart,
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

  it("produces a delivery key BullMQ will accept", () => {
    // BullMQ throws `Custom Id cannot contain :` for a custom job id whose
    // colon-separated parts are not exactly three. A two-part id like
    // "fw:evt-1" is rejected at queue.add, so every delivery using it would
    // have failed at the moment it was enqueued — which is why the delivery
    // key carries no colons at all.
    expect(deliveryJobId("evt-1", "L0")).toBe("fw-evt-1-L0");
    expect(deliveryJobId("evt-1", "L0")).not.toContain(":");
  });

  it("keeps a colon inside an id from breaking the job key", () => {
    // A run id or event id that carries a colon would make the three-part
    // id four-part, and BullMQ would refuse the job.
    const id = eventJobId("run:1", "evt:2");
    expect(id.split(":")).toHaveLength(3);
    expect(jobIdPart("a:b")).toBe("a_b");

    const delivery = deliveryJobId("evt:2", "L0");
    expect(delivery).not.toContain(":");
  });

  it("gives a replay its own key but keeps two replays of one attempt identical", () => {
    expect(replayJobId(4, 1)).toBe("dlq-4-1");
    // A replay must be able to run again after the original failed, so the
    // attempt is part of the key — and two replays of the SAME attempt are
    // the same job, so a double-click cannot deliver twice.
    expect(replayJobId(4, 1)).toBe(replayJobId(4, 1));
    expect(replayJobId(4, 2)).not.toBe(replayJobId(4, 1));
    expect(replayJobId(4, 1)).not.toContain(":");
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
