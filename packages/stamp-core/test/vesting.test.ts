import { describe, expect, it } from "vitest";
import {
  buildVestingSchedule,
  describeFirstRelease,
  firstReleaseInstant,
  monthlyReleaseVector,
  reconcileVesting,
  releaseInstant,
  vestingStateAt,
} from "../src/vesting.js";
import { PACIFIC_TIMEZONE, zonedDateKey, zonedMidnightUtc } from "../src/calendar.js";

/** 2026-03-15 12:00:00 Pacific (PDT, UTC-7). */
const DELIVERY_MARCH_2026 = Date.UTC(2026, 2, 15, 19, 0, 0);

describe("monthlyReleaseVector", () => {
  it("has 24 entries that sum to the delivered amount", () => {
    const vector = monthlyReleaseVector(100n * 10n ** 18n);
    expect(vector).toHaveLength(24);
    expect(vector.reduce((a, b) => a + b, 0n)).toBe(100n * 10n ** 18n);
  });

  it("spreads the remainder so no two months differ by more than one base unit", () => {
    const total = 1000n;
    const vector = monthlyReleaseVector(total);
    const min = vector.reduce((a, b) => (b < a ? b : a));
    const max = vector.reduce((a, b) => (b > a ? b : a));
    expect(max - min).toBeLessThanOrEqual(1n);
    expect(vector.reduce((a, b) => a + b, 0n)).toBe(total);
  });

  it("conserves the total for every amount (property)", () => {
    for (let amount = 0n; amount <= 200n; amount++) {
      const vector = monthlyReleaseVector(amount);
      expect(vector.reduce((a, b) => a + b, 0n)).toBe(amount);
      expect(vector).toHaveLength(24);
    }
  });

  it("conserves the total under the final-release policy too", () => {
    for (let amount = 0n; amount <= 100n; amount++) {
      const vector = monthlyReleaseVector(amount, 24, "final-release");
      expect(vector.reduce((a, b) => a + b, 0n)).toBe(amount);
    }
  });

  it("puts the whole remainder on the last release under the final-release policy", () => {
    const vector = monthlyReleaseVector(1000n, 24, "final-release");
    const per = 1000n / 24n;
    expect(vector[0]).toBe(per);
    expect(vector[23]).toBe(1000n - per * 23n);
  });

  it("refuses a non-positive month count", () => {
    expect(() => monthlyReleaseVector(1n, 0)).toThrow(/months/);
  });
});

describe("first release instant", () => {
  it("is the first day of the month after the delivery month, Pacific midnight", () => {
    const first = firstReleaseInstant(DELIVERY_MARCH_2026);
    expect(zonedDateKey(first, PACIFIC_TIMEZONE)).toBe("2026-04-01");
    expect(first).toBe(zonedMidnightUtc(2026, 4, 1, PACIFIC_TIMEZONE));
  });

  it("rolls the year over in December", () => {
    const december = Date.UTC(2026, 11, 20, 12, 0, 0);
    expect(zonedDateKey(firstReleaseInstant(december), PACIFIC_TIMEZONE)).toBe("2027-01-01");
  });

  it("is a Pacific midnight, not a UTC midnight", () => {
    const first = firstReleaseInstant(DELIVERY_MARCH_2026);
    // 2026-04-01 00:00 PDT is 07:00 UTC.
    expect(new Date(first).toISOString()).toBe("2026-04-01T07:00:00.000Z");
  });
});

describe("monthly release instants", () => {
  it("walks month by month for 24 releases", () => {
    const first = firstReleaseInstant(DELIVERY_MARCH_2026);
    expect(zonedDateKey(releaseInstant(first, 1), PACIFIC_TIMEZONE)).toBe("2026-04-01");
    expect(zonedDateKey(releaseInstant(first, 12), PACIFIC_TIMEZONE)).toBe("2027-03-01");
    expect(zonedDateKey(releaseInstant(first, 24), PACIFIC_TIMEZONE)).toBe("2028-03-01");
  });
});

describe("buildVestingSchedule", () => {
  const schedule = buildVestingSchedule({
    deliveredAmountBaseUnits: 1_000_000n,
    deliveryDate: DELIVERY_MARCH_2026,
  });

  it("conserves the delivered amount exactly", () => {
    expect(schedule.conserved).toBe(true);
    const sum = schedule.monthlyVector.reduce((a, r) => a + BigInt(r.amountBaseUnits), 0n);
    expect(sum).toBe(1_000_000n);
  });

  it("starts on the first day of the month after delivery", () => {
    expect(describeFirstRelease(schedule)).toBe("2026-04-01");
  });

  it("is reproducible from the same inputs", () => {
    const again = buildVestingSchedule({
      deliveredAmountBaseUnits: 1_000_000n,
      deliveryDate: DELIVERY_MARCH_2026,
    });
    expect(again.monthlyVector).toEqual(schedule.monthlyVector);
  });
});

describe("vestingStateAt", () => {
  const schedule = buildVestingSchedule({
    deliveredAmountBaseUnits: 2400n,
    deliveryDate: DELIVERY_MARCH_2026,
  });

  it("releases nothing before the first release", () => {
    const state = vestingStateAt(schedule, schedule.firstReleaseAt - 1);
    expect(state.releasedBaseUnits).toBe("0");
    expect(state.remainingLockedBaseUnits).toBe("2400");
    expect(state.nextReleaseAt).toBe(schedule.firstReleaseAt);
  });

  it("releases one month at a time", () => {
    const state = vestingStateAt(schedule, schedule.firstReleaseAt);
    expect(state.elapsedReleases).toBe(1);
    expect(state.releasedBaseUnits).toBe("100");
    expect(state.remainingLockedBaseUnits).toBe("2300");
  });

  it("fully unlocks after the last release", () => {
    const last = schedule.monthlyVector[schedule.monthlyVector.length - 1]!;
    const state = vestingStateAt(schedule, last.releaseAt);
    expect(state.fullyUnlocked).toBe(true);
    expect(state.releasedBaseUnits).toBe("2400");
    expect(state.remainingLockedBaseUnits).toBe("0");
  });
});

describe("reconcileVesting", () => {
  const schedule = buildVestingSchedule({
    deliveredAmountBaseUnits: 1000n,
    deliveryDate: DELIVERY_MARCH_2026,
  });

  it("passes when the chain agrees", () => {
    expect(reconcileVesting(schedule, 500n).ok).toBe(true);
  });

  it("refuses a chain that released more than was delivered", () => {
    const result = reconcileVesting(schedule, 1001n);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/more than/);
  });
});