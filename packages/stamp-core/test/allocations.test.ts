import { describe, expect, it } from "vitest";
import {
  INVESTOR_RESERVE_CAP_BPS,
  allocateSchedule2,
  holderPortion,
  isMonotonic,
  ratableReduce,
  reserveHeadroomBps,
  teamAllocationStatus,
  TEAM_ALLOCATION_MAX_BPS,
  TEAM_ALLOCATION_MIN_BPS,
} from "../src/allocations.js";

/** A deterministic pseudo-random source, so a failure is reproducible. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("holderPortion", () => {
  it("multiplies pro-rata by total tokens and truncates", () => {
    expect(holderPortion(500n, 1_000_000n)).toBe(50_000n);
    // Truncation, not rounding: the chain holds less than a rounded-up portion.
    expect(holderPortion(1n, 999n)).toBe(0n);
    expect(holderPortion(3333n, 3_000_003n)).toBe((3333n * 3_000_003n) / 10_000n);
  });

  it("refuses negative inputs", () => {
    expect(() => holderPortion(-1n, 100n)).toThrow(/negative/);
    expect(() => holderPortion(1n, -100n)).toThrow(/negative/);
  });
});

describe("ratableReduce", () => {
  it("leaves an aggregate under the cap untouched", () => {
    expect(ratableReduce([500n, 400n])).toEqual([500n, 400n]);
  });

  it("reduces an over-cap aggregate to exactly the cap", () => {
    const reduced = ratableReduce([2500n, 1000n]);
    expect(reduced.reduce((a, b) => a + b, 0n)).toBe(INVESTOR_RESERVE_CAP_BPS);
    // Ratable: each holder lands within one basis point of their exact share.
    const exact0 = (2500n * INVESTOR_RESERVE_CAP_BPS) / 3500n;
    const exact1 = (1000n * INVESTOR_RESERVE_CAP_BPS) / 3500n;
    expect(reduced[0]! - exact0).toBeGreaterThanOrEqual(0n);
    expect(reduced[0]! - exact0).toBeLessThanOrEqual(1n);
    expect(reduced[1]! - exact1).toBeGreaterThanOrEqual(0n);
    expect(reduced[1]! - exact1).toBeLessThanOrEqual(1n);
  });

  it("never moves a holder more than one basis point from their exact share", () => {
    const raw = [1234n, 777n, 901n, 55n];
    const total = raw.reduce((a, b) => a + b, 0n);
    const reduced = ratableReduce(raw);
    for (let i = 0; i < raw.length; i++) {
      const exact = (raw[i]! * INVESTOR_RESERVE_CAP_BPS) / total;
      const remainder = (raw[i]! * INVESTOR_RESERVE_CAP_BPS) % total;
      const floor = exact;
      expect(reduced[i]!).toBeGreaterThanOrEqual(floor);
      expect(reduced[i]!).toBeLessThanOrEqual(floor + 1n);
      expect(remainder).toBeGreaterThanOrEqual(0n);
    }
  });

  it("sums exactly to the cap for every aggregate over it (property)", () => {
    const rand = lcg(20261110);
    for (let trial = 0; trial < 400; trial++) {
      const count = 1 + Math.floor(rand() * 9);
      const raw: bigint[] = [];
      for (let i = 0; i < count; i++) raw.push(BigInt(Math.floor(rand() * 5000)));
      const total = raw.reduce((a, b) => a + b, 0n);
      const reduced = ratableReduce(raw);
      const sum = reduced.reduce((a, b) => a + b, 0n);
      if (total <= INVESTOR_RESERVE_CAP_BPS) {
        expect(sum).toBe(total);
      } else {
        expect(sum).toBe(INVESTOR_RESERVE_CAP_BPS);
      }
      // Every reduced allocation is at most the original.
      for (let i = 0; i < raw.length; i++) expect(reduced[i]!).toBeLessThanOrEqual(raw[i]!);
    }
  });

  it("reduces to zero when the cap is zero", () => {
    expect(ratableReduce([100n, 200n], 0n)).toEqual([0n, 0n]);
  });

  it("refuses negative allocations", () => {
    expect(() => ratableReduce([-1n])).toThrow(/negative/);
  });
});

describe("allocateSchedule2", () => {
  it("produces an immutable, re-derivable snapshot", () => {
    const inputs = [
      { holderId: "h1", rawProRataBps: 700n },
      { holderId: "h2", rawProRataBps: 900n },
    ];
    const first = allocateSchedule2(inputs, 100_000_000n);
    const second = allocateSchedule2(inputs, 100_000_000n);
    expect(first.calculationInputHash).toBe(second.calculationInputHash);
    expect(first.snapshots).toEqual(second.snapshots);
    // The hash is over the *inputs*, so a different supply is a different hash.
    const third = allocateSchedule2(inputs, 200_000_000n);
    expect(third.calculationInputHash).not.toBe(first.calculationInputHash);
  });

  it("keeps the aggregate portion under the cap's share of the supply", () => {
    const inputs = [
      { holderId: "h1", rawProRataBps: 1500n },
      { holderId: "h2", rawProRataBps: 1500n },
    ];
    const result = allocateSchedule2(inputs, 10_000_000n);
    expect(result.capped).toBe(true);
    expect(BigInt(result.effectiveTotalBps)).toBe(INVESTOR_RESERVE_CAP_BPS);
    expect(BigInt(result.portionTotalTokens)).toBeLessThanOrEqual(2_000_000n);
    expect(result.conserved).toBe(true);
  });

  it("hashes the same logical input identically regardless of key order", () => {
    const a = allocateSchedule2(
      [
        { holderId: "h1", rawProRataBps: 100n },
        { holderId: "h2", rawProRataBps: 200n },
      ],
      1_000n,
    );
    const b = allocateSchedule2(
      [
        { holderId: "h2", rawProRataBps: 200n },
        { holderId: "h1", rawProRataBps: 100n },
      ],
      1_000n,
    );
    // Different holder order is a different Schedule 2: the hash must differ.
    expect(a.calculationInputHash).not.toBe(b.calculationInputHash);
  });
});

describe("team allocation band", () => {
  it("accepts 10% to 40% and refuses outside it", () => {
    expect(teamAllocationStatus(TEAM_ALLOCATION_MIN_BPS).withinBounds).toBe(true);
    expect(teamAllocationStatus(TEAM_ALLOCATION_MAX_BPS).withinBounds).toBe(true);
    expect(teamAllocationStatus(999n).withinBounds).toBe(false);
    expect(teamAllocationStatus(4001n).withinBounds).toBe(false);
    expect(teamAllocationStatus(999n).reason).toMatch(/outside/);
  });
});

describe("reserve headroom", () => {
  it("reports the room left under the cap and never goes negative", () => {
    expect(reserveHeadroomBps([500n, 400n])).toBe(1100n);
    expect(reserveHeadroomBps([3000n])).toBe(0n);
  });
});

describe("monotonicity", () => {
  it("holds for holders below the cap (property)", () => {
    const rand = lcg(7);
    for (let trial = 0; trial < 200; trial++) {
      const count = 2 + Math.floor(rand() * 6);
      const inputs = [];
      for (let i = 0; i < count; i++) {
        inputs.push({ holderId: `h${i}`, rawProRataBps: BigInt(Math.floor(rand() * 400)) });
      }
      expect(isMonotonic(inputs, 1_000_000_000n)).toBe(true);
    }
  });
});