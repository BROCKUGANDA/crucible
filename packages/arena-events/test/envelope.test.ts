import { describe, it, expect } from "vitest";
import {
  ARENA_EVENT_VERSION,
  ARENA_MODES,
  ARENA_STAGES,
  ARENA_EVENT_KINDS,
  validateArenaEvent,
  isArenaEvent,
  findCanaries,
  type ArenaEvent,
} from "../src/envelope.js";

const baseEvent: ArenaEvent = {
  v: 1,
  id: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:tx:42",
  mode: "showcase",
  trial: "t_9f2c",
  stage: "IV",
  kind: "break.committed",
  actor: { role: "skeptic", handle: "sk_7a" },
  payload: { sealedCommits: 2, largestStakeVsSeasonMedian: "3x" },
  chainRef: {
    caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    tx: "5abc",
    slotOrBlock: 12345,
    commitment: "confirmed",
  },
  at: "2026-10-30T00:00:00Z",
};

describe("ArenaEvent envelope (gate 801)", () => {
  it("accepts a well-formed event", () => {
    const r = validateArenaEvent(baseEvent);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(isArenaEvent(baseEvent)).toBe(true);
  });

  it("rejects a wrong version", () => {
    const r = validateArenaEvent({ ...baseEvent, v: 2 });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("v must be 1");
  });

  it("rejects an unknown mode", () => {
    const r = validateArenaEvent({ ...baseEvent, mode: "ghosted" });
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown stage", () => {
    const r = validateArenaEvent({ ...baseEvent, stage: "VIII" });
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown kind", () => {
    const r = validateArenaEvent({ ...baseEvent, kind: "trial.deleted" });
    expect(r.ok).toBe(false);
  });

  it("rejects a missing payload", () => {
    const { payload: _p, ...rest } = baseEvent;
    const r = validateArenaEvent(rest);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("payload must be an object");
  });

  it("rejects a non-object payload", () => {
    const r = validateArenaEvent({ ...baseEvent, payload: "nope" });
    expect(r.ok).toBe(false);
  });

  it("rejects a bad actor role", () => {
    const r = validateArenaEvent({ ...baseEvent, actor: { role: "wizard", handle: "x" } });
    expect(r.ok).toBe(false);
  });

  it("rejects a bad chainRef commitment", () => {
    const r = validateArenaEvent({
      ...baseEvent,
      chainRef: { ...baseEvent.chainRef!, commitment: "pending" as never },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a bad CAIP-2", () => {
    const r = validateArenaEvent({
      ...baseEvent,
      chainRef: { ...baseEvent.chainRef!, caip2: "not-a-chain" },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a non-integer slotOrBlock", () => {
    const r = validateArenaEvent({
      ...baseEvent,
      chainRef: { ...baseEvent.chainRef!, slotOrBlock: 1.5 },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an empty id", () => {
    const r = validateArenaEvent({ ...baseEvent, id: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects a non-object input", () => {
    expect(validateArenaEvent(null).ok).toBe(false);
    expect(validateArenaEvent("str").ok).toBe(false);
    expect(validateArenaEvent(42).ok).toBe(false);
  });

  it("accepts an event without optional actor/chainRef", () => {
    const { actor: _a, chainRef: _c, ...rest } = baseEvent;
    const r = validateArenaEvent(rest);
    expect(r.ok).toBe(true);
  });

  it("validates all declared modes/stages/kinds are non-empty", () => {
    expect(ARENA_MODES.length).toBe(4);
    expect(ARENA_STAGES.length).toBe(7);
    expect(ARENA_EVENT_KINDS.length).toBe(20);
    expect(ARENA_EVENT_VERSION).toBe(1);
  });

  it("canary scan finds sealed data in a payload", () => {
    const canaries = ["holdout-salt-xyz", "secret-break-type"];
    const evt = { ...baseEvent, payload: { note: "leaked holdout-salt-xyz here" } };
    expect(findCanaries(evt, canaries)).toContain("holdout-salt-xyz");
    expect(findCanaries(baseEvent, canaries)).toEqual([]);
  });

  it("canary scan checks nested keys and values", () => {
    const canaries = ["hidden"];
    const evt = { ...baseEvent, payload: { hidden: "value" } };
    // key contains canary
    expect(findCanaries(evt, canaries)).toContain("hidden");
  });

  it("canary scan is clean on an empty canary list", () => {
    expect(findCanaries(baseEvent, [])).toEqual([]);
  });
});
