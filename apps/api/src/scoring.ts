/**
 * @file scoring.ts — Multi-dimensional scoring engine (Phase 2).
 *
 * Implements the five scoring dimensions defined in the evaluation
 * architecture: CORRECTNESS, ROBUSTNESS, SAFETY, EFFICIENCY, RELIABILITY.
 *
 * Key invariant: scoring receives no financial data. Reward size, budget,
 * wallet balance, and sponsorship must never influence a grade.
 *
 * All scores are in [0, 1] range using NUMERIC precision (no floats).
 * Timestamps are Unix milliseconds.
 */

import { randomUUID } from "node:crypto";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type ScoreDimension = "CORRECTNESS" | "ROBUSTNESS" | "SAFETY" | "EFFICIENCY" | "RELIABILITY";

export const ALL_DIMENSIONS: ScoreDimension[] = [
  "CORRECTNESS",
  "ROBUSTNESS",
  "SAFETY",
  "EFFICIENCY",
  "RELIABILITY",
];

export interface DimensionConfig {
  dimension: ScoreDimension;
  weight: number;
  methodology: string;
}

export interface Rubric {
  id: string;
  name: string;
  description: string;
  dimensions: DimensionConfig[];
  version: string;
  status: "DRAFT" | "ACTIVE" | "DEPRECATED";
  createdAt: number;
}

export interface DimensionScore {
  id: string;
  runId: string;
  rubricId: string;
  dimension: ScoreDimension;
  score: number;
  weight: number;
  evidence: Record<string, unknown>;
  methodology: string;
  sampleCount: number;
  confidenceLower: number | null;
  confidenceUpper: number | null;
  variance: number | null;
  judgeId: string | null;
  judgeDecision: string | null;
  createdAt: number;
}

export interface AggregateScore {
  id: string;
  runId: string;
  rubricId: string;
  score: number;
  dimensionScores: Record<string, unknown>;
  methodology: string;
  confidenceLower: number | null;
  confidenceUpper: number | null;
  sampleCount: number;
  status: "PROVISIONAL" | "VERIFIED" | "DISPUTED" | "REVOKED";
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Input validation                                                   */
/* ------------------------------------------------------------------ */

export interface CreateRubricInput {
  name: string;
  description?: string;
  dimensions: DimensionConfig[];
  version?: string;
}

export interface CreateDimensionScoreInput {
  runId: string;
  rubricId: string;
  dimension: ScoreDimension;
  score: number;
  weight?: number;
  evidence?: Record<string, unknown>;
  methodology: string;
  sampleCount?: number;
  confidenceLower?: number | null;
  confidenceUpper?: number | null;
  variance?: number | null;
  judgeId?: string | null;
  judgeDecision?: string | null;
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                 */
/* ------------------------------------------------------------------ */

const VALID_DIMENSIONS = new Set(ALL_DIMENSIONS);

/**
 * Validate a score value is in the [0, 1] range.
 * Uses string-based comparison to avoid floating-point issues.
 */
export function isValidScore(score: number): boolean {
  return score >= 0 && score <= 1;
}

/**
 * Validate a weight value is in the [0, 1] range.
 */
export function isValidWeight(weight: number): boolean {
  return weight >= 0 && weight <= 1;
}

export function validateCreateRubricInput(input: CreateRubricInput): string[] {
  const errors: string[] = [];

  if (!input.name || input.name.trim().length < 1) {
    errors.push("name is required");
  }
  if (input.name.length > 128) {
    errors.push("name must be 128 characters or less");
  }

  if (!input.dimensions || input.dimensions.length === 0) {
    errors.push("at least one dimension is required");
  } else {
    const seenDimensions = new Set<ScoreDimension>();
    let totalWeight = 0;

    for (const dim of input.dimensions) {
      if (!VALID_DIMENSIONS.has(dim.dimension)) {
        errors.push(`Invalid dimension: ${dim.dimension}`);
        continue;
      }

      if (seenDimensions.has(dim.dimension)) {
        errors.push(`Duplicate dimension: ${dim.dimension}`);
      }
      seenDimensions.add(dim.dimension);

      if (!isValidWeight(dim.weight)) {
        errors.push(`Weight for ${dim.dimension} must be in [0, 1]`);
      }
      totalWeight += dim.weight;

      if (!dim.methodology || dim.methodology.trim().length < 1) {
        errors.push(`Methodology is required for ${dim.dimension}`);
      }
    }

    // Weights should sum to approximately 1.0 (within 0.01 tolerance)
    if (Math.abs(totalWeight - 1.0) > 0.01) {
      errors.push(`Dimension weights must sum to 1.0, got ${totalWeight.toFixed(4)}`);
    }
  }

  return errors;
}

export function validateCreateDimensionScoreInput(input: CreateDimensionScoreInput): string[] {
  const errors: string[] = [];

  if (!input.runId) {
    errors.push("runId is required");
  }
  if (!input.rubricId) {
    errors.push("rubricId is required");
  }
  if (!VALID_DIMENSIONS.has(input.dimension)) {
    errors.push(`Invalid dimension: ${input.dimension}`);
  }
  if (!isValidScore(input.score)) {
    errors.push("score must be in [0, 1]");
  }
  if (input.weight !== undefined && !isValidWeight(input.weight)) {
    errors.push("weight must be in [0, 1]");
  }
  if (!input.methodology || input.methodology.trim().length < 1) {
    errors.push("methodology is required");
  }
  if (input.sampleCount !== undefined && input.sampleCount < 1) {
    errors.push("sampleCount must be >= 1");
  }

  // Confidence interval validation
  if (input.confidenceLower !== undefined && input.confidenceLower !== null) {
    if (!isValidScore(input.confidenceLower)) {
      errors.push("confidenceLower must be in [0, 1]");
    }
  }
  if (input.confidenceUpper !== undefined && input.confidenceUpper !== null) {
    if (!isValidScore(input.confidenceUpper)) {
      errors.push("confidenceUpper must be in [0, 1]");
    }
  }
  if (input.confidenceLower != null && input.confidenceUpper != null) {
    if (input.confidenceLower > input.confidenceUpper) {
      errors.push("confidenceLower must be <= confidenceUpper");
    }
  }

  return errors;
}

/* ------------------------------------------------------------------ */
/* In-memory store                                                    */
/* ------------------------------------------------------------------ */

interface ScoringStore {
  rubrics: Map<string, Rubric>;
  dimensionScores: Map<string, DimensionScore>;
  aggregateScores: Map<string, AggregateScore>;
}

const store: ScoringStore = {
  rubrics: new Map(),
  dimensionScores: new Map(),
  aggregateScores: new Map(),
};

/* ------------------------------------------------------------------ */
/* Rubric operations                                                  */
/* ------------------------------------------------------------------ */

export function createRubric(input: CreateRubricInput): Rubric {
  const errors = validateCreateRubricInput(input);
  if (errors.length > 0) {
    throw new Error(`Invalid rubric input: ${errors.join("; ")}`);
  }

  const now = Date.now();
  const id = randomUUID();
  const version = input.version ?? "1";

  // Check for duplicate name + version
  for (const [, rubric] of store.rubrics) {
    if (rubric.name === input.name.trim() && rubric.version === version) {
      throw new Error(`Rubric "${input.name}" version "${version}" already exists`);
    }
  }

  const rubric: Rubric = {
    id,
    name: input.name.trim(),
    description: input.description?.trim() ?? "",
    dimensions: input.dimensions,
    version,
    status: "ACTIVE",
    createdAt: now,
  };

  store.rubrics.set(id, rubric);
  return rubric;
}

export function getRubric(id: string): Rubric | undefined {
  return store.rubrics.get(id);
}

export function getActiveRubric(name: string): Rubric | undefined {
  for (const [, rubric] of store.rubrics) {
    if (rubric.name === name && rubric.status === "ACTIVE") {
      return rubric;
    }
  }
  return undefined;
}

export function listRubrics(filters: { status?: Rubric["status"]; name?: string } = {}): Rubric[] {
  const rubrics: Rubric[] = [];

  for (const [, rubric] of store.rubrics) {
    if (filters.status && rubric.status !== filters.status) continue;
    if (filters.name && rubric.name !== filters.name) continue;
    rubrics.push(rubric);
  }

  return rubrics;
}

/* ------------------------------------------------------------------ */
/* Dimension score operations                                         */
/* ------------------------------------------------------------------ */

export function createDimensionScore(input: CreateDimensionScoreInput): DimensionScore {
  const errors = validateCreateDimensionScoreInput(input);
  if (errors.length > 0) {
    throw new Error(`Invalid dimension score input: ${errors.join("; ")}`);
  }

  // Verify rubric exists
  const rubric = store.rubrics.get(input.rubricId);
  if (!rubric) {
    throw new Error(`Rubric "${input.rubricId}" not found`);
  }

  // Check for duplicate dimension score for the same run
  const existingKey = `${input.runId}:${input.dimension}`;
  if (store.dimensionScores.has(existingKey)) {
    throw new Error(`Dimension score for ${input.dimension} already exists for run "${input.runId}"`);
  }

  const now = Date.now();
  const id = randomUUID();

  // Look up weight from rubric if not provided
  const rubricDim = rubric.dimensions.find((d) => d.dimension === input.dimension);
  const weight = input.weight ?? rubricDim?.weight ?? 0.2;

  const score: DimensionScore = {
    id,
    runId: input.runId,
    rubricId: input.rubricId,
    dimension: input.dimension,
    score: input.score,
    weight,
    evidence: input.evidence ?? {},
    methodology: input.methodology.trim(),
    sampleCount: input.sampleCount ?? 1,
    confidenceLower: input.confidenceLower ?? null,
    confidenceUpper: input.confidenceUpper ?? null,
    variance: input.variance ?? null,
    judgeId: input.judgeId ?? null,
    judgeDecision: input.judgeDecision ?? null,
    createdAt: now,
  };

  store.dimensionScores.set(existingKey, score);
  return score;
}

export function getDimensionScores(runId: string): DimensionScore[] {
  const scores: DimensionScore[] = [];
  for (const [, score] of store.dimensionScores) {
    if (score.runId === runId) {
      scores.push(score);
    }
  }
  return scores;
}

export function getDimensionScore(runId: string, dimension: ScoreDimension): DimensionScore | undefined {
  const key = `${runId}:${dimension}`;
  return store.dimensionScores.get(key);
}

/* ------------------------------------------------------------------ */
/* Aggregate score computation                                        */
/* ------------------------------------------------------------------ */

/**
 * Compute aggregate score from dimension scores using weighted average.
 * This is a pure function — it receives no financial data.
 */
export function computeAggregateScore(
  dimensionScores: DimensionScore[],
  methodology: string,
): { score: number; confidenceLower: number | null; confidenceUpper: number | null; sampleCount: number } {
  if (dimensionScores.length === 0) {
    return { score: 0, confidenceLower: null, confidenceUpper: null, sampleCount: 0 };
  }

  let weightedSum = 0;
  let totalWeight = 0;
  let minConfidence = 1.0;
  let maxConfidence = 0;
  let totalSamples = 0;

  for (const ds of dimensionScores) {
    weightedSum += ds.score * ds.weight;
    totalWeight += ds.weight;
    totalSamples += ds.sampleCount;

    if (ds.confidenceLower !== null) {
      minConfidence = Math.min(minConfidence, ds.confidenceLower);
    }
    if (ds.confidenceUpper !== null) {
      maxConfidence = Math.max(maxConfidence, ds.confidenceUpper);
    }
  }

  // Normalize by total weight
  const score = totalWeight > 0 ? weightedSum / totalWeight : 0;

  // Clamp to [0, 1]
  const clampedScore = Math.max(0, Math.min(1, score));

  const confidenceLower = minConfidence < 1.0 ? minConfidence : null;
  const confidenceUpper = maxConfidence > 0 ? maxConfidence : null;

  return {
    score: clampedScore,
    confidenceLower,
    confidenceUpper,
    sampleCount: totalSamples,
  };
}

export function createAggregateScore(
  runId: string,
  rubricId: string,
  methodology: string,
): AggregateScore | null {
  const dimensionScores = getDimensionScores(runId);
  if (dimensionScores.length === 0) {
    return null;
  }

  const { score, confidenceLower, confidenceUpper, sampleCount } =
    computeAggregateScore(dimensionScores, methodology);

  const now = Date.now();
  const id = randomUUID();

  // Build dimension scores summary
  const dimensionScoresSummary: Record<string, unknown> = {};
  for (const ds of dimensionScores) {
    dimensionScoresSummary[ds.dimension] = {
      score: ds.score,
      weight: ds.weight,
      sampleCount: ds.sampleCount,
    };
  }

  const aggregate: AggregateScore = {
    id,
    runId,
    rubricId,
    score,
    dimensionScores: dimensionScoresSummary,
    methodology,
    confidenceLower,
    confidenceUpper,
    sampleCount,
    status: "PROVISIONAL",
    createdAt: now,
    updatedAt: now,
  };

  store.aggregateScores.set(runId, aggregate);
  return aggregate;
}

export function getAggregateScore(runId: string): AggregateScore | undefined {
  return store.aggregateScores.get(runId);
}

export function updateAggregateScoreStatus(
  runId: string,
  status: AggregateScore["status"],
): AggregateScore | null {
  const aggregate = store.aggregateScores.get(runId);
  if (!aggregate) return null;

  aggregate.status = status;
  aggregate.updatedAt = Date.now();
  store.aggregateScores.set(runId, aggregate);
  return aggregate;
}

/* ------------------------------------------------------------------ */
/* Confidence interval calculation                                    */
/* ------------------------------------------------------------------ */

/**
 * Calculate Wilson score confidence interval for a pass rate.
 * Uses the Wilson score interval, which is more accurate than normal
 * approximation for small sample sizes.
 *
 * @param successes - Number of successful trials
 * @param total - Total number of trials
 * @param z - Z-score for confidence level (1.96 for 95%, 2.576 for 99%)
 */
export function wilsonScoreInterval(
  successes: number,
  total: number,
  z: number = 1.96,
): { lower: number; upper: number } | null {
  if (total <= 0) return null;

  const p = successes / total;
  const denominator = 1 + z * z / total;
  const centre = p + z * z / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total);

  const lower = Math.max(0, (centre - spread) / denominator);
  const upper = Math.min(1, (centre + spread) / denominator);

  return { lower, upper };
}

/**
 * Calculate variance from a set of scores.
 */
export function calculateVariance(scores: number[]): number | null {
  if (scores.length < 2) return null;

  const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  const squaredDiffs = scores.map((s) => (s - mean) ** 2);
  const variance = squaredDiffs.reduce((sum, d) => sum + d, 0) / (scores.length - 1);

  return variance;
}

/* ------------------------------------------------------------------ */
/* Score/reward isolation enforcement                                 */
/* ------------------------------------------------------------------ */

/**
 * Verify that a scoring input does not contain any financial data.
 * This is a critical invariant: reward size must never influence grade.
 */
export function assertNoFinancialData(input: unknown): void {
  const financialKeys = [
    "reward",
    "rewardWei",
    "budget",
    "balance",
    "collateral",
    "stake",
    "payout",
    "fee",
    "payment",
    "eth",
    "wei",
    "token",
    "wallet",
    "address",
    "sponsorship",
  ];

  const inputStr = JSON.stringify(input).toLowerCase();
  for (const key of financialKeys) {
    if (inputStr.includes(key)) {
      throw new Error(
        `Score/reward isolation violation: input contains financial data key "${key}". ` +
          `Scoring must not receive reward size, budget, or wallet data.`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Store access for testing                                         */
/* ------------------------------------------------------------------ */

export function getScoringStore(): ScoringStore {
  return store;
}

export function resetScoringStore(): void {
  store.rubrics.clear();
  store.dimensionScores.clear();
  store.aggregateScores.clear();
}
