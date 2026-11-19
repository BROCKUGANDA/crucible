/**
 * @file allocations.ts — integer Schedule 2 allocation with the 20% investor cap.
 *
 * The STAMP template caps the aggregate investor pro-rata allocation at 20% of
 * Total Network Tokens and, when the aggregate exceeds that cap, reduces the
 * allocations *ratably* so the total equals the cap.
 *
 * Three rules govern this file and they are the reason it exists at all:
 *
 *   1. No floating point. Every percentage is an integer number of basis points
 *      and every token amount is an integer count of base units. A float would
 *      make the same Schedule 2 produce two different portions on two runs.
 *   2. The reduction is *ratable* and *exact*. After reduction the effective
 *      allocations sum to exactly the cap, not "approximately" the cap, and
 *      every holder keeps the same share of what they asked for.
 *   3. A correction is a new version, never an update in place. Snapshots carry
 *      the hash of the inputs that produced them, so a stored snapshot can be
 *      re-derived and checked.
 */

import { calculationInputHash } from "./hash.js";

/** Aggregate investor reserve cap: 20% of Total Network Tokens. */
export const INVESTOR_RESERVE_CAP_BPS = 2000n;

/** Aggregate founder / service-provider allocation floor: 10%. */
export const TEAM_ALLOCATION_MIN_BPS = 1000n;

/** Aggregate founder / service-provider allocation ceiling: 40%. */
export const TEAM_ALLOCATION_MAX_BPS = 4000n;

export const BPS_DENOMINATOR = 10_000n;

export interface AllocationInput {
  /** Stable identity of the holder the allocation belongs to. */
  holderId: string;
  /** The holder's pro-rata percentage, in basis points. */
  rawProRataBps: bigint;
}

export interface AllocationSnapshot {
  holderId: string;
  rawProRataBps: string;
  effectiveProRataBps: string;
  totalNetworkTokens: string;
  holderPortionTokens: string;
  calculationVersion: string;
  calculationInputHash: string;
  capped: boolean;
}

/**
 * Ratable reduction to a cap, by the largest-remainder method.
 *
 * Each holder's effective allocation is `raw * cap / total`, floored. The
 * leftover units (the dust that flooring leaves over) go to the holders with the
 * largest fractional remainders, ties broken by position, so the result sums to
 * exactly `cap` and is reproducible on any host.
 *
 * "Give the dust to the largest holder" (an earlier, simpler rule) also sums
 * exactly, but it is not ratable in the contractual sense: one holder can end up
 * with materially more than their share because of rounding. Largest remainder
 * keeps every holder within one basis point of their exact share.
 */
export function ratableReduce(
  rawBps: readonly bigint[],
  capBps: bigint = INVESTOR_RESERVE_CAP_BPS,
): bigint[] {
  if (capBps < 0n) throw new Error("ratableReduce: cap must be >= 0");
  for (const b of rawBps) {
    if (b < 0n) throw new Error("ratableReduce: negative allocation");
  }
  const total = rawBps.reduce((a, b) => a + b, 0n);
  if (total <= capBps) return [...rawBps];
  if (capBps === 0n) return rawBps.map(() => 0n);

  const floors: bigint[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let assigned = 0n;
  for (let i = 0; i < rawBps.length; i++) {
    const numerator = rawBps[i]! * capBps;
    const floor = numerator / total;
    floors.push(floor);
    assigned += floor;
    remainders.push({ index: i, remainder: numerator % total });
  }
  let dust = capBps - assigned;
  // Largest remainder first; ties broken by the earlier holder so the result
  // does not depend on sort stability.
  remainders.sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder < b.remainder ? 1 : -1));
  for (const entry of remainders) {
    if (dust <= 0n) break;
    floors[entry.index] = floors[entry.index]! + 1n;
    dust -= 1n;
  }
  return floors;
}

/**
 * A holder's portion of Total Network Tokens.
 *
 * `HolderPortion = HolderProRataPortion * TotalNetworkTokens`. The template has
 * no double counting for assignments or transfers, so this function is applied
 * to the *effective* (post-cap) pro-rata and never to a raw one.
 */
export function holderPortion(proRataBps: bigint, totalNetworkTokens: bigint): bigint {
  if (proRataBps < 0n) throw new Error("holderPortion: negative pro-rata");
  if (totalNetworkTokens < 0n) throw new Error("holderPortion: negative supply");
  return (proRataBps * totalNetworkTokens) / BPS_DENOMINATOR;
}

export interface AllocationResult {
  snapshots: AllocationSnapshot[];
  /** Sum of the effective allocations, in basis points. */
  effectiveTotalBps: string;
  /** Sum of the portions, in base units. */
  portionTotalTokens: string;
  /** The cap that was applied. */
  capBps: string;
  /** True when the raw aggregate exceeded the cap and the reduction ran. */
  capped: boolean;
  /** True when the sum of portions equals the cap's share of the supply. */
  conserved: boolean;
  calculationVersion: string;
  calculationInputHash: string;
}

/**
 * Allocate a Schedule 2: apply the cap, compute portions, snapshot everything.
 *
 * The snapshot is immutable by construction: it carries the hash of the exact
 * inputs, so two runs over the same inputs produce the same bytes and a stored
 * snapshot can be re-derived from the inputs it names.
 */
export function allocateSchedule2(
  inputs: readonly AllocationInput[],
  totalNetworkTokens: bigint,
  options: { capBps?: bigint; calculationVersion?: string } = {},
): AllocationResult {
  const capBps = options.capBps ?? INVESTOR_RESERVE_CAP_BPS;
  const calculationVersion = options.calculationVersion ?? "stamp-alloc/v1";
  const raw = inputs.map((i) => i.rawProRataBps);
  const effective = ratableReduce(raw, capBps);
  const capped = raw.reduce((a, b) => a + b, 0n) > capBps;

  const inputHash = calculationInputHash({
    version: calculationVersion,
    capBps: capBps.toString(),
    totalNetworkTokens: totalNetworkTokens.toString(),
    inputs: inputs.map((i) => ({ holderId: i.holderId, rawProRataBps: i.rawProRataBps.toString() })),
  });

  const snapshots: AllocationSnapshot[] = inputs.map((input, index) => ({
    holderId: input.holderId,
    rawProRataBps: input.rawProRataBps.toString(),
    effectiveProRataBps: effective[index]!.toString(),
    totalNetworkTokens: totalNetworkTokens.toString(),
    holderPortionTokens: holderPortion(effective[index]!, totalNetworkTokens).toString(),
    calculationVersion,
    calculationInputHash: inputHash,
    capped,
  }));

  const effectiveTotal = effective.reduce((a, b) => a + b, 0n);
  const portionTotal = snapshots.reduce((a, s) => a + BigInt(s.holderPortionTokens), 0n);
  const capShare = holderPortion(capBps, totalNetworkTokens);

  return {
    snapshots,
    effectiveTotalBps: effectiveTotal.toString(),
    portionTotalTokens: portionTotal.toString(),
    capBps: capBps.toString(),
    capped,
    conserved: portionTotal <= capShare,
    calculationVersion,
    calculationInputHash: inputHash,
  };
}

export interface TeamAllocationStatus {
  teamBps: string;
  minBps: string;
  maxBps: string;
  withinBounds: boolean;
  reason: string | null;
}

/**
 * The founder / service-provider allocation band (10%-40% of the applicable
 * network-token supply).
 *
 * This is a reconciliation input, not a gate the app can satisfy by itself: the
 * signed instrument and MetaDAO's own configuration both have to agree with it,
 * and the reconciliation happens before the supply snapshot is locked.
 */
export function teamAllocationStatus(teamBps: bigint): TeamAllocationStatus {
  const within = teamBps >= TEAM_ALLOCATION_MIN_BPS && teamBps <= TEAM_ALLOCATION_MAX_BPS;
  return {
    teamBps: teamBps.toString(),
    minBps: TEAM_ALLOCATION_MIN_BPS.toString(),
    maxBps: TEAM_ALLOCATION_MAX_BPS.toString(),
    withinBounds: within,
    reason: within
      ? null
      : `team allocation ${teamBps} bps is outside the ${TEAM_ALLOCATION_MIN_BPS}-${TEAM_ALLOCATION_MAX_BPS} bps band`,
  };
}

/** Headroom left under the investor cap, in basis points. */
export function reserveHeadroomBps(allocations: readonly bigint[]): bigint {
  const total = allocations.reduce((a, b) => a + b, 0n);
  const headroom = INVESTOR_RESERVE_CAP_BPS - total;
  return headroom > 0n ? headroom : 0n;
}

/**
 * Is a holder's portion monotonic in their pro-rata percentage?
 *
 * Before the cap bites, a holder with a larger percentage must never receive
 * fewer tokens than one with a smaller percentage. The cap can invert the
 * ordering for pairs *above* the cap (a 30% holder reduced to 20% can land
 * below a 19% holder who was not reduced), so this check only applies to the
 * uncapped regime and is asserted there.
 */
export function isMonotonic(
  inputs: readonly AllocationInput[],
  totalNetworkTokens: bigint,
): boolean {
  const raw = inputs.map((i) => i.rawProRataBps);
  if (raw.reduce((a, b) => a + b, 0n) > INVESTOR_RESERVE_CAP_BPS) return false;
  const portions = inputs.map((i) => holderPortion(i.rawProRataBps, totalNetworkTokens));
  for (let i = 0; i < inputs.length; i++) {
    for (let j = 0; j < inputs.length; j++) {
      if (inputs[i]!.rawProRataBps <= inputs[j]!.rawProRataBps) {
        if (portions[i]! > portions[j]!) return false;
      }
    }
  }
  return true;
}