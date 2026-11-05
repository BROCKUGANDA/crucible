/**
 * @file kill-switch.test.ts — Off-chain new-run kill switch tests.
 *
 * The kill switch blocks new evaluations and risky off-chain work but never
 * blocks settlement, withdrawals, or on-chain finalization.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  enable,
  disable,
  status,
  history,
  isBlocked,
  assertNotBlocked,
  __resetKillSwitchForTests,
} from "../src/kill-switch.js";

beforeEach(() => {
  __resetKillSwitchForTests();
});

describe("kill switch status", () => {
  it("starts disabled", () => {
    const s = status();
    expect(s.enabled).toBe(false);
    expect(s.enabledAt).toBeNull();
    expect(s.enabledBy).toBeNull();
    expect(s.reason).toBeNull();
    expect(s.historyCount).toBe(0);
  });
});

describe("enable", () => {
  it("enables the switch and records history", () => {
    const s = enable("0xowner", "suspected attack pattern");
    expect(s.enabled).toBe(true);
    expect(s.enabledBy).toBe("0xowner");
    expect(s.reason).toBe("suspected attack pattern");
    expect(s.enabledAt).toBeGreaterThan(0);
    expect(s.historyCount).toBe(1);
    expect(history()).toHaveLength(1);
    expect(history()[0].action).toBe("enable");
    expect(history()[0].previous).toBe(false);
    expect(history()[0].next).toBe(true);
  });

  it("is idempotent — enabling twice does not duplicate history", () => {
    enable("0xowner", "reason 1");
    const s = enable("0xowner", "reason 2");
    expect(s.historyCount).toBe(1);
    expect(history()).toHaveLength(1);
  });
});

describe("disable", () => {
  it("disables the switch and records history", () => {
    enable("0xowner", "reason 1");
    const s = disable("0xowner", "recovered");
    expect(s.enabled).toBe(false);
    expect(s.enabledAt).toBeNull();
    expect(s.enabledBy).toBeNull();
    expect(s.reason).toBe(null);
    expect(s.historyCount).toBe(2);
    expect(history()[1].action).toBe("disable");
    expect(history()[1].previous).toBe(true);
    expect(history()[1].next).toBe(false);
  });

  it("is idempotent — disabling an already-disabled switch adds no history", () => {
    const s = disable("0xowner", "nothing");
    expect(s.historyCount).toBe(0);
    expect(history()).toHaveLength(0);
  });
});

describe("isBlocked", () => {
  beforeEach(() => {
    enable("0xowner", "emergency");
  });

  it("blocks new evaluations", () => {
    expect(isBlocked("new_evaluation")).toBe(true);
  });

  it("blocks batch submission", () => {
    expect(isBlocked("batch_submit")).toBe(true);
  });

  it("blocks deploy jobs", () => {
    expect(isBlocked("deploy_job")).toBe(true);
  });

  it("never blocks withdrawals", () => {
    expect(isBlocked("withdraw")).toBe(false);
  });

  it("never blocks finalize", () => {
    expect(isBlocked("finalize")).toBe(false);
  });

  it("never blocks reclaim", () => {
    expect(isBlocked("reclaim")).toBe(false);
  });

  it("allows all actions when disabled", () => {
    disable("0xowner", "recovered");
    expect(isBlocked("new_evaluation")).toBe(false);
    expect(isBlocked("batch_submit")).toBe(false);
    expect(isBlocked("deploy_job")).toBe(false);
    expect(isBlocked("withdraw")).toBe(false);
    expect(isBlocked("finalize")).toBe(false);
    expect(isBlocked("reclaim")).toBe(false);
  });
});

describe("assertNotBlocked", () => {
  it("throws when blocked", () => {
    enable("0xowner", "emergency");
    expect(() => assertNotBlocked("new_evaluation")).toThrow(/kill switch enabled/);
  });

  it("does not throw for withdrawals even when enabled", () => {
    enable("0xowner", "emergency");
    expect(() => assertNotBlocked("withdraw")).not.toThrow();
  });

  it("does not throw when disabled", () => {
    expect(() => assertNotBlocked("new_evaluation")).not.toThrow();
  });
});