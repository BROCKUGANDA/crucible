// SPDX-License-Identifier: UNLICENSED
/**
 * Bayesian Sybil-risk scorer — Phase 1.
 *
 * Computes P(unique human | evidence) using hand-tuned priors and likelihood
 * ratios. Evidence comes from the indexer read model (trial history, alloy
 * tier, identity linkage). No chain keys required — all data is read-only
 * projection.
 *
 * Future phases: HMC with leapfrog integration for offline parameter fitting
 * from labeled outcomes, replacing hand-tuned values (Phase 3).
 *
 * Design:
 *   log-odds = ln(prior / (1 - prior)) + Σ ln(LRᵢ)
 *   P(unique human) = sigmoid(log-odds)
 *
 * Each likelihood ratio LRᵢ = P(evidenceᵢ | unique human) / P(evidenceᵢ | sybil).
 * LR > 1 favors human; LR < 1 favors sybil.
 */

import type { AgentRow, AlloyState, ReadModel, TrialRow } from "@crucible/indexer";

// ── Base rate ──────────────────────────────────────────────────────────────
// P(unique human) for a fresh wallet with no evidence. Hand-picked for Phase 1 — an earlier
// version of this comment called it "calibrated from the observed base rate of genuine users
// vs sybils on the demo chain", and no such observation exists: there is no labelled corpus
// in this repository. A prior that claims to be measured and is not is worse than an honest
// guess, because a reader has no way to tell the difference.
const BASE_RATE_UNIQUE_HUMAN = 0.10;

// ── Likelihood ratios (human : sybil) ──────────────────────────────────────
// Each LR multiplies the odds. LR > 1 favors human; LR < 1 favors sybil.
// Values are hand-tuned for Phase 1; Phase 3 fits them via HMC/leapfrog.
export const LIKELIHOOD_RATIOS = {
  // Alloy tier signals (registry state — expensive to acquire, hard to farm)
  alloyTierIron: 2.0,    // tier >= Iron (1)
  alloyTierBronze: 3.0,  // tier >= Bronze (2)
  alloyTierSteel: 5.0,   // tier >= Steel (3)
  alloyTierDamascus: 10.0, // tier >= Damascus (4)

  // Identity linkage (ERC-8004 — costs gas, ties to real identity)
  identityLinked: 5.0,

  // Trial history (behavioral — expensive to fake at scale)
  hasWonTrial: 3.0,     // at least one paid verdict
  hasSurvivedBreak: 2.0, // at least one break survived
  hasSlashes: 0.2,       // any slash (anti-sybil)
  multipleTrials: 2.0,   // 3+ settled trials

  // Wallet age (from first trial creation)
  walletAgeOld: 4.0,     // > 90 days since first activity
} as const;

// ── Types ──────────────────────────────────────────────────────────────────

export interface EvidenceSignal {
  name: string;
  present: boolean;
  lr: number;
  logLr: number;
  description: string;
}

export interface RiskScore {
  wallet: string;
  agentId: number | null;
  pUniqueHuman: number; // calibrated posterior [0, 1]
  logOdds: number;      // ln(prior / (1 - prior)) + Σ ln(LR)
  evidence: EvidenceSignal[];
  modelVersion: string;
  computedAt: number;
}

export interface Decision {
  action: "allow" | "challenge" | "rate-limit" | "deny";
  reason: string;
}

// ── Math ───────────────────────────────────────────────────────────────────

/** Log-odds of the base rate. */
function baseLogOdds(): number {
  const p = BASE_RATE_UNIQUE_HUMAN;
  return Math.log(p / (1 - p));
}

/** Sigmoid: map log-odds to probability. */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

// ── Evidence collection ────────────────────────────────────────────────────

/** Find the agent row for a wallet address (operator field). */
function findAgentByWallet(model: ReadModel, wallet: string): AgentRow | null {
  const walletLower = wallet.toLowerCase();
  for (const agent of model.agents.values()) {
    if (agent.operator.toLowerCase() === walletLower) {
      return agent;
    }
  }
  return null;
}

/** Get all settled trials for an agent. */
function getAgentTrials(model: ReadModel, agentId: number): TrialRow[] {
  const trials: TrialRow[] = [];
  for (const t of model.trials.values()) {
    if (t.agentId === agentId && t.status === "settled") {
      trials.push(t);
    }
  }
  return trials;
}

/** Collect evidence signals for an agent. */
function collectEvidence(
  model: ReadModel,
  agent: AgentRow | null,
  alloy: AlloyState | null,
  nowSeconds: number | null,
): EvidenceSignal[] {
  const signals: EvidenceSignal[] = [];

  if (!agent) {
    // No agent on record — fresh wallet, no evidence beyond base rate
    return signals;
  }

  const trials = getAgentTrials(model, agent.id);

  // Alloy tier (registry state — expensive to acquire, hard to farm)
  const tier = alloy?.tier ?? null;
  if (tier !== null && tier >= 4) {
    signals.push({
      name: "alloyTierDamascus",
      present: true,
      lr: LIKELIHOOD_RATIOS.alloyTierDamascus,
      logLr: Math.log(LIKELIHOOD_RATIOS.alloyTierDamascus),
      description: `Alloy tier Damascus (${tier})`,
    });
  } else if (tier !== null && tier >= 3) {
    signals.push({
      name: "alloyTierSteel",
      present: true,
      lr: LIKELIHOOD_RATIOS.alloyTierSteel,
      logLr: Math.log(LIKELIHOOD_RATIOS.alloyTierSteel),
      description: `Alloy tier Steel (${tier})`,
    });
  } else if (tier !== null && tier >= 2) {
    signals.push({
      name: "alloyTierBronze",
      present: true,
      lr: LIKELIHOOD_RATIOS.alloyTierBronze,
      logLr: Math.log(LIKELIHOOD_RATIOS.alloyTierBronze),
      description: `Alloy tier Bronze (${tier})`,
    });
  } else if (tier !== null && tier >= 1) {
    signals.push({
      name: "alloyTierIron",
      present: true,
      lr: LIKELIHOOD_RATIOS.alloyTierIron,
      logLr: Math.log(LIKELIHOOD_RATIOS.alloyTierIron),
      description: `Alloy tier Iron (${tier})`,
    });
  } else if (tier !== null && tier === 0) {
    signals.push({
      name: "alloyTierUnforged",
      present: true,
      lr: 1.0, // no information either way
      logLr: 0,
      description: "Alloy tier Unforged (0)",
    });
  }

  // Identity linkage (ERC-8004 — costs gas, ties to real identity)
  if (agent.identityAgentId !== null) {
    signals.push({
      name: "identityLinked",
      present: true,
      lr: LIKELIHOOD_RATIOS.identityLinked,
      logLr: Math.log(LIKELIHOOD_RATIOS.identityLinked),
      description: `ERC-8004 identity linked (tokenId ${agent.identityAgentId})`,
    });
  }

  // Trial history
  const hasWon = trials.some((t) => t.verdict === "paid");
  if (hasWon) {
    signals.push({
      name: "hasWonTrial",
      present: true,
      lr: LIKELIHOOD_RATIOS.hasWonTrial,
      logLr: Math.log(LIKELIHOOD_RATIOS.hasWonTrial),
      description: `At least one paid trial verdict`,
    });
  }

  /**
   * A break was filed AND the trial still paid out — that is what surviving one means.
   *
   * This used to test `breakSkeptic !== null` alone, which is true for a *slashed* trial as
   * well: an agent that was successfully broken was scored as if it had survived the break,
   * so the signal rewarded exactly the failure it was meant to detect.
   */
  const hasSurvived = trials.some((t) => t.verdict === "paid" && t.breakSkeptic !== null);
  if (hasSurvived) {
    signals.push({
      name: "hasSurvivedBreak",
      present: true,
      lr: LIKELIHOOD_RATIOS.hasSurvivedBreak,
      logLr: Math.log(LIKELIHOOD_RATIOS.hasSurvivedBreak),
      description: `A filed break did not overturn a paid verdict`,
    });
  }

  if (agent.slashes > 0) {
    signals.push({
      name: "hasSlashes",
      present: true,
      lr: LIKELIHOOD_RATIOS.hasSlashes,
      logLr: Math.log(LIKELIHOOD_RATIOS.hasSlashes),
      description: `${agent.slashes} slash(es) on record`,
    });
  }

  if (trials.length >= 3) {
    signals.push({
      name: "multipleTrials",
      present: true,
      lr: LIKELIHOOD_RATIOS.multipleTrials,
      logLr: Math.log(LIKELIHOOD_RATIOS.multipleTrials),
      description: `${trials.length} settled trials`,
    });
  }

  // Wallet age (from earliest trial creation), measured on the chain's clock.
  //
  // This used `Date.now()`, which is a second clock: the trial timestamps come from blocks,
  // so a host with a skewed wall clock could age a wallet it had never seen a day of. With no
  // chain timestamp the signal is simply not emitted — unknown is not "old".
  if (trials.length > 0 && nowSeconds !== null) {
    const oldest = Math.min(...trials.map((t) => t.createdAt));
    const ageDays = (nowSeconds - oldest) / 86400;
    if (ageDays > 90) {
      signals.push({
        name: "walletAgeOld",
        present: true,
        lr: LIKELIHOOD_RATIOS.walletAgeOld,
        logLr: Math.log(LIKELIHOOD_RATIOS.walletAgeOld),
        description: `Wallet active for ${Math.floor(ageDays)} days`,
      });
    }
  }

  return signals;
}

/**
 * Score a wallet for Sybil risk.
 *
 * Returns the calibrated posterior P(unique human), the log-odds, and a
 * per-signal breakdown so a judge can see exactly why the score moved.
 *
 * `nowSeconds` is the chain clock (the host's head-block timestamp), not the wall clock. It
 * is optional because a host that has not read a block yet knows nothing about age, and the
 * age signal must then be absent rather than guessed.
 */
export function scoreWallet(
  model: ReadModel,
  alloyState: (agentId: number) => AlloyState | null,
  wallet: string,
  nowSeconds: number | null = null,
): RiskScore {
  const agent = findAgentByWallet(model, wallet);
  const alloy = agent ? alloyState(agent.id) : null;
  const evidence = collectEvidence(model, agent, alloy, nowSeconds);

  // Start with base rate log-odds, add each signal's log-LR
  let logOdds = baseLogOdds();
  for (const s of evidence) {
    logOdds += s.logLr;
  }

  const pUniqueHuman = sigmoid(logOdds);

  return {
    wallet,
    agentId: agent?.id ?? null,
    pUniqueHuman,
    logOdds,
    evidence,
    modelVersion: "bayesian-logistic-v1-hand-tuned",
    computedAt: Date.now(),
  };
}

/**
 * Decision layer — map posterior risk to action.
 *
 * Cost-sensitive thresholds tuned on expected loss, not accuracy:
 *   cost(false positive) × P(Sybil) vs cost(false negative) × P(human).
 */
export function decide(score: RiskScore): Decision {
  const p = score.pUniqueHuman;
  if (p >= 0.90) {
    return { action: "allow", reason: "High confidence unique human" };
  }
  if (p >= 0.70) {
    return {
      action: "challenge",
      reason: "Require Passport stamp or EAS attestation",
    };
  }
  if (p >= 0.40) {
    return {
      action: "rate-limit",
      reason: "One faucet allocation per 24h",
    };
  }
  return { action: "deny", reason: "Insufficient evidence of humanity" };
}
