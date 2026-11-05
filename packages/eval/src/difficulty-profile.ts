/**
 * @file difficulty-profile.ts — Adaptive difficulty engine.
 *
 * Builds on the existing primitives in packages/eval/src/ratings.ts
 * (conservative, defaultRating, tierFor) and gates.ts (targetDifficulty).
 * Does NOT replace them — extends them with multi-dimensional difficulty
 * assessment, calibration status, and agent fit.
 *
 * Difficulty must be measured, not merely declared by a sponsor. A sponsor's
 * difficulty selection is an input, never an authority.
 *
 * Three distinct concepts are kept separate:
 *   1. Estimated difficulty — predicted before the trial is run.
 *   2. Observed difficulty — measured from actual outcomes.
 *   3. Agent fit — how suitable a particular agent is for this trial.
 */

import { conservative, defaultRating, tierFor } from "./ratings.js";
import type { Rating } from "./ratings.js";
import { targetDifficulty } from "./gates.js";

/* ------------------------------------------------------------------ */
/* Difficulty dimensions                                              */
/* ------------------------------------------------------------------ */

export type DifficultyDimension =
  | "technical_complexity"
  | "reasoning_complexity"
  | "integration_complexity"
  | "environment_complexity"
  | "verification_complexity"
  | "adversarial_complexity"
  | "reliability_requirement"
  | "domain_specificity";

export interface DifficultyDimensionScore {
  dimension: DifficultyDimension;
  /** 0-1 normalised measure. Null = not measured / unknown. */
  value: number | null;
  /** How confident we are in this score. Null = unknown. */
  confidence: number | null;
  /** Basis for the score: "sponsor_declared", "measured", "expert_review", "provisional". */
  basis: string;
}

export interface DifficultyDimensions {
  scores: DifficultyDimensionScore[];
  /** Null when any dimension is unmeasured. Never fabricated. */
  composite: number | null;
}

export function emptyDifficultyDimensions(): DifficultyDimensions {
  const dimensions: DifficultyDimension[] = [
    "technical_complexity",
    "reasoning_complexity",
    "integration_complexity",
    "environment_complexity",
    "verification_complexity",
    "adversarial_complexity",
    "reliability_requirement",
    "domain_specificity",
  ];
  return {
    scores: dimensions.map((d) => ({
      dimension: d,
      value: null,
      confidence: null,
      basis: "provisional",
    })),
    composite: null,
  };
}

/* ------------------------------------------------------------------ */
/* Trial Difficulty Profile                                           */
/* ------------------------------------------------------------------ */

export type CalibrationStatus =
  | "provisional"
  | "calibrating"
  | "calibrated"
  | "stale";

export interface TrialDifficultyProfile {
  version: string;
  trialId: string;
  challengeVersion: string;
  difficultyModelVersion: string;
  domain: string;
  dimensions: DifficultyDimensions;

  // Estimated difficulty (pre-trial)
  estimatedDifficulty: number | null;
  estimatedConfidence: number | null;

  // Observed difficulty (post-trial, from actual outcomes)
  observedCompletionRate: number | null;
  observedFailureRate: number | null;
  baselineAgentCohort: string[] | null;
  sampleSize: number;
  confidenceInterval: [number, number] | null;

  // Model / harness conditions
  modelHarnessConditions: string[];
  evaluatorVersion: string;
  benchmarkDigest: string | null;

  // Calibration
  calibrationDate: number | null;
  calibrationStatus: CalibrationStatus;

  // Agent fit (computed per agent/trial pair, stored separately)
  lastComputedAt: number | null;
}

export function newTrialDifficultyProfile(
  trialId: string,
  domain: string,
): TrialDifficultyProfile {
  if (!trialId || !domain) {
    throw new Error("difficulty-profile: trialId and domain are required");
  }
  return {
    version: "1.0",
    trialId,
    challengeVersion: "1.0",
    difficultyModelVersion: "1.0",
    domain,
    dimensions: emptyDifficultyDimensions(),
    estimatedDifficulty: null,
    estimatedConfidence: null,
    observedCompletionRate: null,
    observedFailureRate: null,
    baselineAgentCohort: null,
    sampleSize: 0,
    confidenceInterval: null,
    modelHarnessConditions: [],
    evaluatorVersion: "1.0",
    benchmarkDigest: null,
    calibrationDate: null,
    calibrationStatus: "provisional",
    lastComputedAt: null,
  };
}

/* ------------------------------------------------------------------ */
/* Agent fit                                                          */
/* ------------------------------------------------------------------ */

export type AgentFitBucket =
  | "under_challenging"
  | "suitable"
  | "specialist"
  | "uncalibrated";

export interface AgentTrialFit {
  agentId: string;
  trialId: string;
  domain: string;
  /** Predicted success probability for this agent on this trial. Null = unknown. */
  predictedSuccessProbability: number | null;
  fitBucket: AgentFitBucket;
  /** The agent's conservative rating in this domain. */
  domainConservativeRating: number | null;
  /** Whether the agent has sufficient evidence in this domain. */
  sufficientEvidence: boolean;
  lastComputedAt: number;
}

export function newAgentTrialFit(
  agentId: string,
  trialId: string,
  domain: string,
): AgentTrialFit {
  return {
    agentId,
    trialId,
    domain,
    predictedSuccessProbability: null,
    fitBucket: "uncalibrated",
    domainConservativeRating: null,
    sufficientEvidence: false,
    lastComputedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* Calibration (IRT-style)                                            */
/* ------------------------------------------------------------------ */

/**
 * Item-response-theory style pass probability:
 *   P(pass) = 1 / (1 + e^(-a * (theta - b)))
 * where theta = agent ability, b = task difficulty, a = discrimination.
 *
 * This is a calibration approach, not an assumption that existing rating
 * units form a calibrated IRT scale. Do not fit parameters from
 * insufficient data.
 */
export function irtPassProbability(
  theta: number,
  b: number,
  a: number = 1.0,
): number {
  // P(pass) = sigmoid(a * (theta - b)). Numerically stable.
  const x = a * (theta - b);
  if (x >= 0) {
    return 1 / (1 + Math.exp(-x));
  }
  const ex = Math.exp(x);
  return ex / (1 + ex);
}

/**
 * Estimate task difficulty b from observed agent outcomes using a simple
 * method-of-moments approach. Requires sufficient data; otherwise returns
 * null and marks the profile provisional.
 *
 * @param agentProbabilities — each agent's conservative rating mapped to
 *   [0,1] ability via a logistic transform.
 * @param outcomes — each agent's pass/fail outcome.
 * @param minSampleSize — minimum observations required.
 */
export function estimateDifficultyFromOutcomes(
  agentAbilities: number[],
  outcomes: boolean[],
  minSampleSize: number = 20,
): { difficulty: number | null; confidence: number | null; sampleSize: number } {
  const n = agentAbilities.length;
  if (n < minSampleSize || n !== outcomes.length) {
    return { difficulty: null, confidence: null, sampleSize: n };
  }

  // Simple method of moments: difficulty b is the ability level at which
  // the observed pass rate equals the model pass rate.
  const passRate = outcomes.filter(Boolean).length / n;
  const meanAbility =
    agentAbilities.reduce((a, b) => a + b, 0) / n;

  // Invert: passRate = 1/(1+e^(-a*(meanAbility - b)))
  // => b = meanAbility + ln(passRate/(1-passRate))/a
  // (a = 1 discrimination)
  if (passRate <= 0 || passRate >= 1) {
    return { difficulty: null, confidence: null, sampleSize: n };
  }
  const difficulty = meanAbility + Math.log(passRate / (1 - passRate));

  // Confidence based on sample size (Wilson-style lower bound approximation).
  const se = Math.sqrt((passRate * (1 - passRate)) / n);
  const confidence = Math.max(0, Math.min(1, 1 - 1.96 * se));

  return { difficulty, confidence, sampleSize: n };
}

/* ------------------------------------------------------------------ */
/* Trial Heat classification                                          */
/* ------------------------------------------------------------------ */

export type TrialHeat = "kindling" | "tempering" | "forging" | "crucible" | "masterwork";

export interface HeatClassification {
  heat: TrialHeat;
  /** Why this heat was assigned. */
  rationale: string[];
  /** Whether the classification is provisional (low data). */
  provisional: boolean;
}

export function classifyHeat(
  profile: TrialDifficultyProfile,
): HeatClassification {
  const rationale: string[] = [];
  let provisional = true;
  let heat: TrialHeat = "kindling";

  const est = profile.estimatedDifficulty;
  const obs = profile.observedCompletionRate;
  const samples = profile.sampleSize;

  if (est === null && obs === null) {
    rationale.push("No estimated or observed difficulty available.");
    return { heat: "kindling", rationale, provisional: true };
  }

  if (samples > 0 && samples < 20) {
    rationale.push(`Small sample size (${samples}) — classification is provisional.`);
    provisional = true;
  } else if (samples >= 20) {
    provisional = false;
  }

  // Use observed completion rate when available, otherwise estimated difficulty.
  const signal = obs !== null ? obs : est !== null ? 1 - est : 0.5;

  if (signal >= 0.8) {
    heat = "kindling";
    rationale.push("High completion rate — introductory verified task.");
  } else if (signal >= 0.6) {
    heat = "tempering";
    rationale.push("Moderate-high completion — multi-step, well-defined task.");
  } else if (signal >= 0.4) {
    heat = "forging";
    rationale.push("Moderate completion — challenging work with dependencies.");
  } else if (signal >= 0.2) {
    heat = "crucible";
    rationale.push("Low completion — advanced work with high verification demands.");
  } else {
    heat = "masterwork";
    rationale.push("Very low completion — specialist or frontier-level work.");
  }

  if (provisional) {
    rationale.push("Classification is provisional pending more data.");
  }

  return { heat, rationale, provisional };
}

/* ------------------------------------------------------------------ */
/* Agent suitability                                                  */
/* ------------------------------------------------------------------ */

/**
 * Compute agent fit for a trial using the agent's domain conservative
 * rating and the trial's estimated difficulty.
 *
 * Uses the existing conservative() rating and targetDifficulty() from the
 * eval package. Does not replace them.
 */
export function computeAgentFit(
  agentRating: Rating | null,
  profile: TrialDifficultyProfile,
): AgentTrialFit {
  const fit = newAgentTrialFit(
    "unknown",
    profile.trialId,
    profile.domain,
  );

  if (!agentRating) {
    fit.fitBucket = "uncalibrated";
    fit.sufficientEvidence = false;
    return fit;
  }

  const domainConservative = conservative(agentRating);
  fit.domainConservativeRating = domainConservative;
  fit.sufficientEvidence = true; // has a rating = has some evidence

  const estDiff = profile.estimatedDifficulty;
  if (estDiff === null) {
    fit.fitBucket = "uncalibrated";
    fit.predictedSuccessProbability = null;
    return fit;
  }

  // Map conservative rating [roughly -50 to +100] to ability [0,1].
  const ability = 1 / (1 + Math.exp(-domainConservative / 25));
  const difficulty = Math.max(0, Math.min(1, estDiff));
  const prob = irtPassProbability(ability, difficulty);
  fit.predictedSuccessProbability = prob;

  if (prob > 0.8) {
    fit.fitBucket = "under_challenging";
  } else if (prob > 0.4) {
    fit.fitBucket = "suitable";
  } else if (prob > 0.15) {
    fit.fitBucket = "specialist";
  } else {
    fit.fitBucket = "uncalibrated";
  }

  return fit;
}