export type Verdict = "PASS" | "VOID" | "FAIL";

export type ModelId = string;
export type PromptVersion = string;
export type ClaimHash = string;
export type SuiteName = string;

/** A single graded artifact, with its gold label from the JUDGE corpus. */
export interface Artifact {
  claimHash: ClaimHash;
  /** The artifact the model grades (raw JSON / text / bytes). */
  payload: unknown;
  expectedVerdict: Verdict;
  suite: SuiteName;
  /** "boundary" artifacts sit near the decision threshold and weight 3x in kappa. */
  thresholdBand?: "boundary" | "normal";
  metadata?: Record<string, unknown>;
}

/** A single model's verdict on one artifact. */
export interface ModelVerdict {
  verdict: Verdict;
  confidence: number; // 0..1
  latencyMs: number;
  promptVersion: PromptVersion;
}

/** One model, swappable behind adapter.ts. Zero new wires per model — one JSON row + RFC. */
export interface ModelAdapter {
  id: ModelId;
  grade(artifact: Artifact, promptVersion: PromptVersion): Promise<ModelVerdict>;
}

/** Per-artifact eval result, cache-keyed by (claimHash, model, promptVersion). */
export interface EvalResult {
  claimHash: ClaimHash;
  modelId: ModelId;
  promptVersion: PromptVersion;
  suite: SuiteName;
  expected: Verdict;
  actual: Verdict;
  confidence: number;
  correct: boolean;
  falsePass: boolean; // actual == PASS && expected != PASS (protocol bleed — dollars)
  falseFail: boolean; // actual != PASS && expected == PASS (supply-side harm)
  latencyMs: number;
  killed: boolean; // BREAK mutant: did the model catch the break
}

/** One scorecard row per (model, suite). */
export interface ScorecardRow {
  modelId: ModelId;
  promptVersion: PromptVersion;
  suite: SuiteName;
  n: number;
  falsePassRate: number;
  falseFailRate: number;
  accuracy: number;
  kappa: number;
  killRate: number;
  consistency: number; // test-retest agreement, 0..1
  /**
   * Draws actually taken per artifact. `consistency` without this number is unreadable: 1.0
   * from one draw and 1.0 from twenty are different claims, and only one of them measured
   * anything. Derived from the verdict lists themselves, never from the requested count.
   */
  draws?: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgCostUsd: number;
  disqualified: boolean;
  disqualifyReason?: string;
}

/** Disqualification thresholds (gate 421). */
export interface SmokeThresholds {
  maxFalsePassRate: number; // hard disqualifier: <= 1%
  maxP95LatencyMs: number; // hard disqualifier: <= 20s
  /**
   * Gate 424, active only when supplied. A stage that does not set it publishes `consistency`
   * as a measurement and disqualifies on nothing; a stage that sets it fails a model whose
   * repeated draws disagree **or** whose draws were never taken — a single draw is not a
   * pass, it is an absence of evidence, and treating it as a pass is how the 98% gate became
   * decoration.
   */
  minAgreementRate?: number;
  minRetests?: number;
}

/** Full scorecard output. */
export interface Scorecard {
  rows: ScorecardRow[];
  generatedAt: number;
}
