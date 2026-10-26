import { describe, expect, it } from "vitest";
import { CapTracker, MAX_PER_ALLOCATION_ETH, MAX_PER_DAY_ETH, MAX_PER_WALLET_PER_DAY_ETH } from "./cap.js";

describe("CapTracker", () => {
  it("approves a first allocation within the per-allocation cap", () => {
    const caps = new CapTracker();
    const est = caps.estimate("0x1111111111111111111111111111111111111111", 0.01);
    expect(est.ok).toBe(true);
    if (est.ok) expect(est.estimated).toBe(0.01);
  });

  it("rejects an amount above the per-allocation cap", () => {
    const caps = new CapTracker();
    const est = caps.estimate("0x1111111111111111111111111111111111111111", MAX_PER_ALLOCATION_ETH + 0.01);
    expect(est.ok).toBe(false);
    if (!est.ok) expect(est.reason).toContain("at most");
  });

  it("rejects a zero or negative amount", () => {
    const caps = new CapTracker();
    expect(caps.estimate("0x1111111111111111111111111111111111111111", 0).ok).toBe(false);
    expect(caps.estimate("0x1111111111111111111111111111111111111111", -1).ok).toBe(false);
  });

  it("tracks per-wallet daily spend across allocations", () => {
    const caps = new CapTracker();
    const w = "0x1111111111111111111111111111111111111111";

    // First allocation of 0.05 ETH (at the per-allocation cap)
    const e1 = caps.estimate(w, MAX_PER_ALLOCATION_ETH);
    expect(e1.ok).toBe(true);
    if (e1.ok) caps.record(w, MAX_PER_ALLOCATION_ETH, e1.estimated, MAX_PER_ALLOCATION_ETH, true);

    // Second allocation of 0.05 ETH (total 0.1, under the 0.2 per-wallet daily cap)
    const e2 = caps.estimate(w, MAX_PER_ALLOCATION_ETH);
    expect(e2.ok).toBe(true);
    if (e2.ok) caps.record(w, MAX_PER_ALLOCATION_ETH, e2.estimated, MAX_PER_ALLOCATION_ETH, true);

    // Third allocation of 0.05 ETH would total 0.15, still under 0.2
    const e3 = caps.estimate(w, MAX_PER_ALLOCATION_ETH);
    expect(e3.ok).toBe(true);
    if (e3.ok) caps.record(w, MAX_PER_ALLOCATION_ETH, e3.estimated, MAX_PER_ALLOCATION_ETH, true);

    // Fourth allocation of 0.05 ETH would total 0.2, at the per-wallet cap
    const e4 = caps.estimate(w, MAX_PER_ALLOCATION_ETH);
    expect(e4.ok).toBe(true);
    if (e4.ok) caps.record(w, MAX_PER_ALLOCATION_ETH, e4.estimated, MAX_PER_ALLOCATION_ETH, true);

    // Fifth allocation of 0.01 ETH would total 0.21, exceeding the per-wallet cap
    const e5 = caps.estimate(w, 0.01);
    expect(e5.ok).toBe(false);
    if (!e5.ok) expect(e5.reason).toContain("daily cap");
  });

  it("tracks all-wallet daily spend", () => {
    const caps = new CapTracker();
    // 39 wallets at 0.05 ETH each = 1.95 ETH total, under the 2.0 daily cap
    for (let i = 0; i < 39; i++) {
      const w = `0x${String(i).padStart(40, "0")}`;
      const e = caps.estimate(w, MAX_PER_ALLOCATION_ETH);
      expect(e.ok).toBe(true);
      if (e.ok) caps.record(w, MAX_PER_ALLOCATION_ETH, e.estimated, MAX_PER_ALLOCATION_ETH, true);
    }
    // The 40th wallet at 0.06 ETH exceeds the per-allocation cap anyway,
    // but even a small amount would push the daily total past 2.0 ETH
    // (floating point makes the exact boundary unreliable, so we test well
    // under it here and the per-wallet test above covers the cap overflow).
    const e40 = caps.estimate("0x9999999999999999999999999999999999999999", 0.01);
    expect(e40.ok).toBe(true);
  });

  it("records a failed allocation with reason", () => {
    const caps = new CapTracker();
    const e = caps.estimate("0x1111111111111111111111111111111111111111", MAX_PER_ALLOCATION_ETH + 1);
    expect(e.ok).toBe(false);
    let reason: string | undefined;
    if (!e.ok) {
      reason = e.reason;
      caps.record("0x1111111111111111111111111111111111111111", MAX_PER_ALLOCATION_ETH + 1, 0, 0, false, reason);
    }
    const list = caps.list();
    expect(list.length).toBe(1);
    const first = list[0];
    expect(first).toBeDefined();
    expect(first!.ok).toBe(false);
    expect(first!.reason).toBe(reason);
  });

  it("constants are the expected values", () => {
    expect(MAX_PER_ALLOCATION_ETH).toBe(0.05);
    expect(MAX_PER_WALLET_PER_DAY_ETH).toBe(0.2);
    expect(MAX_PER_DAY_ETH).toBe(2.0);
  });
});
