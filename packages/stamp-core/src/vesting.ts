/**
 * @file vesting.ts — the 24-month investor lock-up, in integer base units.
 *
 * The template releases delivered investor tokens ratably over 24 months,
 * starting on the first day of each calendar month following the Delivery Date.
 * Two things about that sentence are easy to get wrong and expensive:
 *
 *   - "the first day of each calendar month" is a *Pacific* calendar boundary.
 *     A UTC computation puts the first release eight hours early for eight
 *     months of the year and eight hours late for the other four, and the
 *     difference is a token released before the contract said it could be.
 *   - The months must sum *exactly* to the delivered amount. Rounding each
 *     month independently and hoping the total matches is how a holder ends up
 *     with a token that was never released, or with a release that never
 *     happened.
 *
 * The rounding rule is a policy choice the blueprint requires counsel to
 * approve, so both rules are implemented and named:
 *
 *   - `largest-remainder` (default): each month gets floor(total / months) plus
 *     one extra base unit for the months with the largest fractional share. No
 *     month differs from another by more than one base unit.
 *   - `final-release`: the first months get floor(total / months) and the final
 *     release absorbs the whole remainder. This is the template's literal
 *     "allocate the rounding remainder to a specified final release" wording.
 *
 * Both conserve the total exactly. The rule used is recorded in the schedule so
 * a stored schedule can be re-derived and checked.
 */

import {
  PACIFIC_TIMEZONE,
  zonedDateKey,
  zonedMidnightUtc,
  zonedParts,
} from "./calendar.js";

export const VESTING_MONTHS = 24;

export type RemainderPolicy = "largest-remainder" | "final-release";

export interface MonthlyRelease {
  /** 1-based release number. */
  index: number;
  /** Amount released, in integer base units. */
  amountBaseUnits: string;
  /** The instant the release becomes available, as a unix-ms timestamp. */
  releaseAt: number;
}

export interface VestingSchedule {
  scheduleVersion: string;
  remainderPolicy: RemainderPolicy;
  months: number;
  deliveredAmountBaseUnits: string;
  deliveryDate: number;
  firstReleaseAt: number;
  monthlyVector: MonthlyRelease[];
  releasedTotalBaseUnits: string;
  remainingTotalBaseUnits: string;
  /** True when the monthly amounts sum to exactly the delivered amount. */
  conserved: boolean;
  timeZone: string;
}

export interface VestingScheduleInput {
  deliveredAmountBaseUnits: bigint;
  deliveryDate: number;
  months?: number;
  remainderPolicy?: RemainderPolicy;
  timeZone?: string;
  scheduleVersion?: string;
}

/**
 * The monthly amounts, in integer base units.
 *
 * `total` of 0 yields `months` zero releases — a holder who received nothing
 * gets nothing, and the schedule still has the right shape.
 */
export function monthlyReleaseVector(
  total: bigint,
  months: number = VESTING_MONTHS,
  policy: RemainderPolicy = "largest-remainder",
): bigint[] {
  if (!Number.isInteger(months) || months <= 0) throw new Error("monthlyReleaseVector: months must be > 0");
  if (total < 0n) throw new Error("monthlyReleaseVector: negative total");
  if (total === 0n) return Array.from({ length: months }, () => 0n);

  const out: bigint[] = [];
  if (policy === "final-release") {
    // The template's literal wording: the remainder lands on the final release.
    const per = total / BigInt(months);
    for (let i = 0; i < months - 1; i++) out.push(per);
    out.push(total - per * BigInt(months - 1));
    return out;
  }

  // Largest remainder: floor(total / months) each, then one extra base unit for
  // the months with the largest fractional share. `extra` is strictly less than
  // `months`, so no month differs from another by more than one base unit.
  const per = total / BigInt(months);
  const extra = total % BigInt(months);
  for (let i = 0; i < months; i++) out.push(per);
  for (let i = 0; i < Number(extra); i++) out[i] = out[i]! + 1n;
  return out;
}

/**
 * The instant of the first release: midnight (Pacific) on the first day of the
 * month after the delivery month.
 */
export function firstReleaseInstant(deliveryDate: number, timeZone: string = PACIFIC_TIMEZONE): number {
  const p = zonedParts(deliveryDate, timeZone);
  const nextMonth =
    p.month === 12 ? { year: p.year + 1, month: 1 } : { year: p.year, month: p.month + 1 };
  return zonedMidnightUtc(nextMonth.year, nextMonth.month, 1, timeZone);
}

/** The instant of the nth monthly release (1-based). */
export function releaseInstant(
  firstReleaseAt: number,
  index: number,
  timeZone: string = PACIFIC_TIMEZONE,
): number {
  if (!Number.isInteger(index) || index < 1) throw new Error("releaseInstant: index must be >= 1");
  const p = zonedParts(firstReleaseAt, timeZone);
  const zeroBased = p.month - 1 + (index - 1);
  const year = p.year + Math.floor(zeroBased / 12);
  const month = (zeroBased % 12) + 1;
  return zonedMidnightUtc(year, month, 1, timeZone);
}

/**
 * Build the schedule.
 *
 * The schedule is reproducible: same delivered amount, same delivery date, same
 * rule, same vector. That is what makes an independently recomputed schedule a
 * meaningful check on a stored one.
 */
export function buildVestingSchedule(input: VestingScheduleInput): VestingSchedule {
  const months = input.months ?? VESTING_MONTHS;
  const policy = input.remainderPolicy ?? "largest-remainder";
  const timeZone = input.timeZone ?? PACIFIC_TIMEZONE;
  const amounts = monthlyReleaseVector(input.deliveredAmountBaseUnits, months, policy);
  const firstReleaseAt = firstReleaseInstant(input.deliveryDate, timeZone);
  const monthlyVector: MonthlyRelease[] = amounts.map((amount, i) => ({
    index: i + 1,
    amountBaseUnits: amount.toString(),
    releaseAt: releaseInstant(firstReleaseAt, i + 1, timeZone),
  }));
  const sum = amounts.reduce((a, b) => a + b, 0n);
  return {
    scheduleVersion: input.scheduleVersion ?? "stamp-vesting/v1",
    remainderPolicy: policy,
    months,
    deliveredAmountBaseUnits: input.deliveredAmountBaseUnits.toString(),
    deliveryDate: input.deliveryDate,
    firstReleaseAt,
    monthlyVector,
    releasedTotalBaseUnits: "0",
    remainingTotalBaseUnits: input.deliveredAmountBaseUnits.toString(),
    conserved: sum === input.deliveredAmountBaseUnits,
    timeZone,
  };
}

export interface VestingState {
  releasedBaseUnits: string;
  remainingLockedBaseUnits: string;
  nextReleaseAt: number | null;
  fullyUnlocked: boolean;
  elapsedReleases: number;
}

/** How much of a schedule has released at `at`, and what is still locked. */
export function vestingStateAt(schedule: VestingSchedule, at: number): VestingState {
  let released = 0n;
  let elapsed = 0;
  let next: number | null = null;
  for (const release of schedule.monthlyVector) {
    if (release.releaseAt <= at) {
      released += BigInt(release.amountBaseUnits);
      elapsed += 1;
    } else if (next === null) {
      next = release.releaseAt;
    }
  }
  const total = BigInt(schedule.deliveredAmountBaseUnits);
  const remaining = total - released;
  return {
    releasedBaseUnits: released.toString(),
    remainingLockedBaseUnits: remaining.toString(),
    nextReleaseAt: next,
    fullyUnlocked: remaining === 0n,
    elapsedReleases: elapsed,
  };
}

/**
 * Reconcile an observed chain state against the schedule.
 *
 * `observedReleased` is what the chain says is unlocked. The reconciliation
 * passes only when the schedule conserves the delivered amount and the chain
 * has not released more than was delivered. A mismatch is a hard failure: the
 * chain and the contract disagree, and no arithmetic fixes that.
 */
export function reconcileVesting(
  schedule: VestingSchedule,
  observedReleasedBaseUnits: bigint,
): { ok: boolean; reason: string | null; released: string; remaining: string } {
  const total = BigInt(schedule.deliveredAmountBaseUnits);
  const expectedReleased = schedule.monthlyVector.reduce(
    (a, r) => a + BigInt(r.amountBaseUnits),
    0n,
  );
  if (expectedReleased !== total) {
    return {
      ok: false,
      reason: `schedule does not conserve the delivered amount (${expectedReleased} != ${total})`,
      released: observedReleasedBaseUnits.toString(),
      remaining: (total - observedReleasedBaseUnits).toString(),
    };
  }
  if (observedReleasedBaseUnits > total) {
    return {
      ok: false,
      reason: `chain reports ${observedReleasedBaseUnits} released, more than the ${total} delivered`,
      released: observedReleasedBaseUnits.toString(),
      remaining: "0",
    };
  }
  return {
    ok: true,
    reason: null,
    released: observedReleasedBaseUnits.toString(),
    remaining: (total - observedReleasedBaseUnits).toString(),
  };
}

/** A human-readable description of the schedule's first release, for the portal. */
export function describeFirstRelease(schedule: VestingSchedule): string {
  return zonedDateKey(schedule.firstReleaseAt, schedule.timeZone);
}