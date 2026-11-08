import { describe, expect, it } from "vitest";
import { RunSequencer, defaultSequencer, sequenceEvent } from "../src/sequencer.js";
import { ForgeWatchEventType, forgeWatchEvent } from "../src/events.js";

const runId = "run_seq_1";
const base = {
  runId,
  trialId: "trial_seq_1",
  agentId: "agent_seq_1",
  tenantId: "tenant_seq_1",
  eventType: ForgeWatchEventType.agentTurnStart,
  source: "forge-runner",
} as const;

describe("per-run sequence integrity", () => {
  it("fills an observed gap without rewinding the contiguous cursor", () => {
    const seq = new RunSequencer();

    expect(seq.next("run-order", 1)).toBe(1);
    expect(seq.next("run-order", 3)).toBe(3);
    expect(seq.next("run-order", 2)).toBe(2);
    expect(seq.next("run-order", 4)).toBe(4);

    expect(seq.findingsSnapshot.filter((finding) => finding.kind === "gap")).toHaveLength(1);
    expect(seq.findingsSnapshot.filter((finding) => finding.kind === "regression")).toHaveLength(0);
  });

  it("records a regression without moving the cursor backwards", () => {
    const seq = new RunSequencer();

    expect(seq.next("run-regression", 1)).toBe(1);
    expect(seq.next("run-regression", 1)).toBe(1);
    expect(seq.next("run-regression", 2)).toBe(2);

    expect(seq.findingsSnapshot.filter((finding) => finding.kind === "regression")).toHaveLength(1);
    expect(seq.findingsSnapshot.filter((finding) => finding.kind === "gap")).toHaveLength(0);
  });
  it("assigns monotonic sequences starting at 1", () => {
    const seq = new RunSequencer();
    const a = sequenceEvent({ ...base, sequence: 1 }, seq);
    const b = sequenceEvent({ ...base, sequence: 2 }, seq);
    const c = sequenceEvent({ ...base, sequence: 3 }, seq);
    expect(a.sequence).toBe(1);
    expect(b.sequence).toBe(2);
    expect(c.sequence).toBe(3);
  });

  it("records a gap when a sequence is skipped", () => {
    const seq = new RunSequencer();
    sequenceEvent({ ...base, sequence: 1 }, seq);
    sequenceEvent({ ...base, sequence: 3 }, seq); // skips 2
    const findings = seq.findingsSnapshot;
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe("gap");
    if (findings[0].kind === "gap") {
      expect(findings[0].expected).toBe(2);
      expect(findings[0].observed).toBe(3);
    }
  });

  it("records a regression when sequence goes backwards", () => {
    const seq = new RunSequencer();
    sequenceEvent({ ...base, sequence: 1 }, seq);
    sequenceEvent({ ...base, sequence: 1 }, seq); // goes backwards from 2 to 1
    const findings = seq.findingsSnapshot;
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe("regression");
    if (findings[0].kind === "regression") {
      expect(findings[0].previous).toBe(2);
      expect(findings[0].observed).toBe(1);
    }
  });

  it("does not record a finding for in-order events", () => {
    const seq = new RunSequencer();
    sequenceEvent({ ...base, sequence: 1 }, seq);
    sequenceEvent({ ...base, sequence: 2 }, seq);
    expect(seq.findingsSnapshot).toEqual([]);
  });

  it("tracks sequences independently per run", () => {
    const seq = new RunSequencer();
    sequenceEvent({ ...base, runId: "run_a", sequence: 1 }, seq);
    sequenceEvent({ ...base, runId: "run_b", sequence: 1 }, seq);
    sequenceEvent({ ...base, runId: "run_a", sequence: 2 }, seq);
    expect(seq.findingCount("run_a")).toBe(0);
    expect(seq.findingCount("run_b")).toBe(0);
  });

  it("defaultSequencer is shared across calls", () => {
    const a = sequenceEvent({ ...base, sequence: 1 }, defaultSequencer);
    const b = sequenceEvent({ ...base, sequence: 2 }, defaultSequencer);
    expect(a.sequence).toBe(1);
    expect(b.sequence).toBe(2);
    // reset for other tests that use defaultSequencer
    defaultSequencer.__resetForTests(runId);
  });

  it("forgeWatchEvent plus sequenceEvent produces a valid envelope", () => {
    const seq = new RunSequencer();
    const env = sequenceEvent(forgeWatchEvent(base, { sequence: 1 }), seq);
    expect(env.schemaVersion).toBe(1);
    expect(env.runId).toBe(runId);
    expect(env.sequence).toBe(1);
    expect(typeof env.eventId).toBe("string");
    expect(typeof env.timestamp).toBe("number");
  });
});
