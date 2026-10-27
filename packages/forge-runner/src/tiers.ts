import type { SandboxSpec } from "./sandbox.js";

/**
 * Capability tiers and sandbox strictness (gates 841-842, 901).
 *
 * A trial's tier is derived from its frontier-axis vector — horizon,
 * transfer distance, novelty distance, composition depth, perturbation
 * recovery — never self-declared by a publisher. Strictness scales with
 * that tier: the higher the classification, the larger the sandbox floor
 * (time, memory) a run or a verification re-run must execute under, and
 * the higher the Alloy tier an agent must hold before it may *earn* from
 * the trial. Strictness only ever raises a caller's spec; it never lowers
 * one, so a caller that already runs stricter is untouched.
 */

export type TrialTier = 0 | 1 | 2 | 3 | 4;

export interface FrontierAxes {
  /** multi-session / long-horizon demand, 0..1 */
  horizon: number;
  /** cross-domain transfer distance, 0..1 */
  transfer: number;
  /** novelty distance from public benchmarks, 0..1 */
  novelty: number;
  /** tool / step composition depth, 0..1 */
  composition: number;
  /** perturbation-recovery demand, 0..1 */
  perturbation: number;
}

const AXES = ["horizon", "transfer", "novelty", "composition", "perturbation"] as const;

/**
 * Derive the tier from the axis vector. The mean sets the ladder rung; any
 * single axis at or beyond 0.9 forces at least T3, because a suite that is
 * extreme on one axis is frontier work however ordinary the rest looks.
 */
export function tierOfSuite(axes: FrontierAxes): TrialTier {
  let sum = 0;
  let extreme = false;
  for (const axis of AXES) {
    const v = axes[axis];
    if (typeof v !== "number" || Number.isNaN(v) || v < 0 || v > 1) {
      throw new Error(`frontier axis ${axis} must be a number in [0, 1], got ${String(v)}`);
    }
    sum += v;
    if (v >= 0.9) extreme = true;
  }
  const mean = sum / AXES.length;
  let tier: TrialTier = 0;
  if (mean >= 0.8) tier = 4;
  else if (mean >= 0.6) tier = 3;
  else if (mean >= 0.4) tier = 2;
  else if (mean >= 0.2) tier = 1;
  if (extreme && tier < 3) tier = 3;
  return tier;
}

export interface TierStrictness {
  /** sandbox wall-clock floor, seconds */
  minTimeoutSec: number;
  /** sandbox memory floor, megabytes */
  minMemoryMb: number;
  /** independent re-executions a verdict at this tier requires (panel seats) */
  replays: number;
}

/** The strictness ladder. Floors, not defaults: callers may run stricter. */
export const TIER_STRICTNESS: Record<TrialTier, TierStrictness> = {
  0: { minTimeoutSec: 300, minMemoryMb: 512, replays: 1 },
  1: { minTimeoutSec: 600, minMemoryMb: 1024, replays: 1 },
  2: { minTimeoutSec: 900, minMemoryMb: 2048, replays: 1 },
  3: { minTimeoutSec: 1800, minMemoryMb: 4096, replays: 2 },
  4: { minTimeoutSec: 3600, minMemoryMb: 8192, replays: 3 },
};

function memoryMb(memory: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([gm])$/i.exec(memory.trim());
  if (!m) throw new Error(`unparseable sandbox memory: ${JSON.stringify(memory)}`);
  const value = Number(m[1]);
  return m[2]!.toLowerCase() === "g" ? Math.round(value * 1024) : Math.round(value);
}

/**
 * Raise a sandbox spec to the tier's floor. Returns the spec to execute
 * under plus the names of the fields that were raised, so a caller can log
 * exactly what the tier demanded beyond what it would have run anyway.
 */
export function strictSandboxFor(
  base: SandboxSpec,
  tier: TrialTier,
): { spec: SandboxSpec; raised: string[] } {
  const floor = TIER_STRICTNESS[tier];
  const spec: SandboxSpec = { ...base };
  const raised: string[] = [];
  if (spec.timeoutSec < floor.minTimeoutSec) {
    spec.timeoutSec = floor.minTimeoutSec;
    raised.push("timeoutSec");
  }
  if (memoryMb(spec.memory) < floor.minMemoryMb) {
    spec.memory = `${floor.minMemoryMb}m`;
    raised.push("memory");
  }
  return { spec, raised };
}

/**
 * May an agent holding Alloy tier `agentTier` (0-4, the registry ladder)
 * earn from a trial classified `trialTier`? Below-tier work may still be
 * attempted and recorded; it may not be paid at the frontier rate. This is
 * the gate that stops a low-tier agent farming high-tier payouts.
 */
export function mayEarnAtTier(agentTier: number, trialTier: TrialTier): boolean {
  if (!Number.isInteger(agentTier) || agentTier < 0 || agentTier > 4) {
    throw new Error(`agent tier must be an integer in [0, 4], got ${String(agentTier)}`);
  }
  return agentTier >= trialTier;
}
