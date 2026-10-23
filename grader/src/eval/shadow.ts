import type { Artifact, ModelAdapter, ModelVerdict, Verdict } from "./types.js";

const PASS: Verdict = "PASS";

/** Gate 430 — Shadow promotion.
 *
 * A candidate runs on 1% of live verdicts (shadow diff) for a week → divergence
 * report → RFC → GraderRegistry bump. The candidate never influences the live
 * verdict during shadowing.
 */
export interface ShadowRun {
  claimHash: string;
  productionModel: string;
  candidateModel: string;
  productionVerdict: Verdict;
  candidateVerdict: Verdict;
  diverged: boolean;
  productionConfidence: number;
  candidateConfidence: number;
}

export interface DivergenceReport {
  total: number;
  diverged: number;
  divergenceRate: number;
  byCandidate: Record<string, { diverged: number; total: number }>;
  disagreements: Array<{
    claimHash: string;
    productionVerdict: Verdict;
    candidateVerdict: Verdict;
  }>;
}

/**
 * ShadowRunner samples live artifacts and runs the candidate in parallel without
 * affecting the production verdict. sampleRate of 0.01 = 1% of traffic.
 */
export class ShadowRunner {
  constructor(private readonly sampleRate: number) {} // 0..1

  /**
   * Attempt to shadow-grade an artifact. Returns null when not sampled (the
   * candidate is not run, preserving the production path).
   */
  shouldSample(): boolean {
    return Math.random() < this.sampleRate;
  }

  /** Record a shadow run comparing production vs candidate verdicts. */
  record(
    claimHash: string,
    productionModel: string,
    candidateModel: string,
    production: ModelVerdict,
    candidate: ModelVerdict,
  ): ShadowRun {
    const diverged = production.verdict !== candidate.verdict;
    return {
      claimHash,
      productionModel,
      candidateModel,
      productionVerdict: production.verdict,
      candidateVerdict: candidate.verdict,
      diverged,
      productionConfidence: production.confidence,
      candidateConfidence: candidate.confidence,
    };
  }

  /** Build a divergence report from accumulated shadow runs. */
  divergenceReport(runs: ShadowRun[]): DivergenceReport {
    const total = runs.length;
    const diverged = runs.filter((r) => r.diverged).length;
    const byCandidate = new Map<string, { diverged: number; total: number }>();
    const disagreements: DivergenceReport["disagreements"] = [];

    for (const r of runs) {
      let acc = byCandidate.get(r.candidateModel);
      if (!acc) {
        acc = { diverged: 0, total: 0 };
        byCandidate.set(r.candidateModel, acc);
      }
      acc.total += 1;
      if (r.diverged) {
        acc.diverged += 1;
        disagreements.push({
          claimHash: r.claimHash,
          productionVerdict: r.productionVerdict,
          candidateVerdict: r.candidateVerdict,
        });
      }
    }

    const byCandidateObj: Record<string, { diverged: number; total: number }> = {};
    for (const [model, acc] of byCandidate) {
      byCandidateObj[model] = acc;
    }

    return {
      total,
      diverged,
      divergenceRate: total === 0 ? 0 : diverged / total,
      byCandidate: byCandidateObj,
      disagreements,
    };
  }
}
