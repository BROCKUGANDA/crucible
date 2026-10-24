import { createHash } from "node:crypto";
import type {
  ClaimHash,
  EvalResult,
  Scorecard,
  ScorecardRow,
  SmokeThresholds,
  SuiteEpoch,
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
  suiteEpoch: SuiteEpoch,
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
  const draws = maxDraws(perArtifactConsistency);
  const latencies = results.map((r) => r.latencyMs);

  /**
   * Gate 424 activates only when the stage asks for it. `minRetests` is the load-bearing half:
   * a single draw produces agreement 1.0 for free, so a threshold on agreement alone can be met
   * by measuring nothing. A row that was gated but drawn once is disqualified as unmeasured
   * rather than passed as stable.
   */
  const gated = thresholds.minRetests !== undefined || thresholds.minAgreementRate !== undefined;
  const agreementMin = thresholds.minAgreementRate ?? 0.98;
  const drawsMin = thresholds.minRetests ?? 20;
  const notMeasured = gated && draws < drawsMin;
  const unsteady = gated && !notMeasured && con < agreementMin;

  /**
   * Every gate that fired, in a fixed order, and `disqualified` derived from the same list so the
   * flag and the reason cannot drift apart.
   *
   * This used to be a precedence chain that named the first failing gate and dropped the rest. The
   * first real scorecard measured through `scripts/grade-arena.mjs` is what that cost: it published
   * `false-pass rate 22.22% > 1.00%` on a row whose p95 was 268638ms against a 20000ms budget —
   * thirteen times over — and nothing in the row said so. A reader who fixed the named gate and
   * re-ran would still be disqualified, with no way to know that from what they were given.
   *
   * `notMeasured` and `unsteady` are exclusive by construction above, so at most three reasons can
   * ever appear.
   */
  const reasons = [
    fpRate > thresholds.maxFalsePassRate &&
      `false-pass rate ${(fpRate * 100).toFixed(2)}% > ${(thresholds.maxFalsePassRate * 100).toFixed(2)}%`,
    p95(latencies) > thresholds.maxP95LatencyMs &&
      `p95 latency ${p95(latencies).toFixed(0)}ms > ${thresholds.maxP95LatencyMs}ms`,
    notMeasured &&
      `consistency not measured: ${draws} draw${draws === 1 ? "" : "s"} of ${drawsMin} required`,
    unsteady &&
      `test-retest agreement ${(con * 100).toFixed(1)}% < ${(agreementMin * 100).toFixed(0)}%`,
  ].filter((r): r is string => typeof r === "string");

  const disqualified = reasons.length > 0;
  const reason = disqualified ? reasons.join("; ") : undefined;

  return {
    modelId,
    promptVersion,
    suite,
    suiteEpoch,
    n,
    falsePassRate: fpRate,
    falseFailRate: ffRate,
    accuracy: acc,
    kappa: k,
    killRate: kr,
    consistency: con,
    draws,
    avgLatencyMs: mean(latencies),
    p95LatencyMs: p95(latencies),
    avgCostUsd: avgCostUsd,
    disqualified,
    disqualifyReason: reason,
  };
}

/**
 * The largest number of draws recorded for any artifact in the set. Derived from the verdict
 * lists rather than from the count the caller requested, because the gate has to survive a
 * caller that asked for twenty and got one — which is precisely what a cache-backed retest loop
 * does.
 */
export function maxDraws(perArtifact: Map<ClaimHash, Verdict[]>): number {
  let max = 0;
  for (const verdicts of perArtifact.values()) {
    if (verdicts.length > max) max = verdicts.length;
  }
  return max;
}

/** Build the full scorecard across all model/suite results. */
export function buildScorecard(
  all: Array<{
    modelId: string;
    promptVersion: string;
    suite: SuiteName;
    suiteEpoch: SuiteEpoch;
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
      entry.suiteEpoch,
      entry.results,
      entry.perArtifactConsistency,
      entry.avgCostUsd,
      thresholds,
    ),
  );
  return { rows, corpusEpoch: corpusEpochOf(rows), generatedAt: Date.now() };
}

/**
 * One digest for the whole exam set, derived from the rows rather than declared beside them.
 *
 * A card has one row per (model, suite), so the same suite appears once per candidate and its epoch
 * should be identical every time. Deduplicating by the pair keeps that; keeping a *disagreement* as
 * two entries is the part that matters, because the alternative — keying a map by suite name — would
 * silently pick one of two different corpora and publish a hash that describes neither.
 */
export function corpusEpochOf(rows: readonly ScorecardRow[]): SuiteEpoch {
  const pairs = [...new Set(rows.map((r) => `${r.suite}::${r.suiteEpoch}`))].sort();
  return createHash("sha256").update(JSON.stringify(pairs)).digest("hex");
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
