import type {
  ClaimHash,
  EvalResult,
  Scorecard,
  ScorecardRow,
  SmokeThresholds,
  SuiteName,
  Verdict,
} from "./types.js";

const PASS: Verdict = "PASS";

/** Observed agreement proportion between expected and actual verdicts (binary PASS vs not-PASS). */
function observedAgreement(results: EvalResult[]): number {
  if (results.length === 0) return 0;
  const agree = results.filter((r) => (r.expected === PASS) === (r.actual === PASS)).length;
  return agree / results.length;
}

/** Expected agreement by chance for the binary PASS/not-PASS dichotomy. */
function chanceAgreement(results: EvalResult[]): number {
  if (results.length === 0) return 0;
  const n = results.length;
  const pExpectedPass = results.filter((r) => r.expected === PASS).length / n;
  const pActualPass = results.filter((r) => r.actual === PASS).length / n;
  return pExpectedPass * pActualPass + (1 - pExpectedPass) * (1 - pActualPass);
}

/** Cohen's kappa for binary PASS vs not-PASS. Range [-1, 1]; 1 = perfect agreement. */
export function kappa(results: EvalResult[]): number {
  const po = observedAgreement(results);
  const pe = chanceAgreement(results);
  const denom = 1 - pe;
  if (denom <= 0) return po === 1 ? 1 : 0;
  return (po - pe) / denom;
}

/** False-pass rate: model said PASS but gold was not PASS. Protocol bleed — dollars. */
export function falsePassRate(results: EvalResult[]): number {
  if (results.length === 0) return 0;
  return results.filter((r) => r.falsePass).length / results.length;
}

/** False-fail rate: model did not say PASS but gold was PASS. Supply-side harm. */
export function falseFailRate(results: EvalResult[]): number {
  if (results.length === 0) return 0;
  return results.filter((r) => r.falseFail).length / results.length;
}

export function accuracy(results: EvalResult[]): number {
  if (results.length === 0) return 0;
  return results.filter((r) => r.correct).length / results.length;
}

export function killRate(results: EvalResult[]): number {
  if (results.length === 0) return 0;
  return results.filter((r) => r.killed).length / results.length;
}

/** Test-retest agreement: fraction of artifacts where repeated runs agreed on verdict. */
export function consistency(perArtifact: Map<ClaimHash, Verdict[]>): number {
  if (perArtifact.size === 0) return 0;
  let stable = 0;
  for (const verdicts of perArtifact.values()) {
    const first = verdicts[0];
    if (first !== undefined && verdicts.every((v) => v === first)) stable += 1;
  }
  return stable / perArtifact.size;
}

export function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, rank)]!;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Build one scorecard row from a model's results on a suite. */
export function scorecardRow(
  modelId: string,
  promptVersion: string,
  suite: SuiteName,
  results: EvalResult[],
  perArtifactConsistency: Map<ClaimHash, Verdict[]>,
  avgCostUsd: number,
  thresholds: SmokeThresholds,
): ScorecardRow {
  const n = results.length;
  const fpRate = falsePassRate(results);
  const ffRate = falseFailRate(results);
  const acc = accuracy(results);
  const k = kappa(results);
  const kr = killRate(results);
  const con = consistency(perArtifactConsistency);
  const latencies = results.map((r) => r.latencyMs);
  const disqualified = fpRate > thresholds.maxFalsePassRate || p95(latencies) > thresholds.maxP95LatencyMs;

  return {
    modelId,
    promptVersion,
    suite,
    n,
    falsePassRate: fpRate,
    falseFailRate: ffRate,
    accuracy: acc,
    kappa: k,
    killRate: kr,
    consistency: con,
    avgLatencyMs: mean(latencies),
    p95LatencyMs: p95(latencies),
    avgCostUsd: avgCostUsd,
    disqualified,
    disqualifyReason: disqualified
      ? fpRate > thresholds.maxFalsePassRate
        ? `false-pass rate ${(fpRate * 100).toFixed(2)}% > ${(thresholds.maxFalsePassRate * 100).toFixed(2)}%`
        : `p95 latency ${p95(latencies).toFixed(0)}ms > ${thresholds.maxP95LatencyMs}ms`
      : undefined,
  };
}

/** Build the full scorecard across all model/suite results. */
export function buildScorecard(
  all: Array<{
    modelId: string;
    promptVersion: string;
    suite: SuiteName;
    results: EvalResult[];
    perArtifactConsistency: Map<ClaimHash, Verdict[]>;
    avgCostUsd: number;
  }>,
  thresholds: SmokeThresholds,
): Scorecard {
  const rows = all.map((entry) =>
    scorecardRow(
      entry.modelId,
      entry.promptVersion,
      entry.suite,
      entry.results,
      entry.perArtifactConsistency,
      entry.avgCostUsd,
      thresholds,
    ),
  );
  return { rows, generatedAt: Date.now() };
}

/** Serialize a scorecard row as one JSONL line. */
export function scorecardLine(row: ScorecardRow): string {
  return JSON.stringify(row);
}

/** Gate 432 — Public trust page scorecard line per deployed graderVersion. */
export function trustPageLine(
  graderVersion: string,
  modelId: string,
  kappa: number,
  killRate: number,
  falsePassRate: number,
): string {
  return `Warden ${graderVersion} — model ${modelId} · kappa ${kappa.toFixed(2)} · kill-rate ${(killRate * 100).toFixed(0)}% · false-pass ${(falsePassRate * 100).toFixed(1)}%`;
}
