import type { Artifact, ModelAdapter, ModelVerdict, Verdict } from "./types.js";

const PASS: Verdict = "PASS";

/** Gate 429 — Ensemble mode.
 *
 * Two models must agree on subjective edges, else escalate to the dispute committee.
 * Costs latency — off by default, on for escrows above a value threshold.
 */
export interface EnsembleConfig {
  modelA: ModelAdapter;
  modelB: ModelAdapter;
  /** Ensemble is off by default. */
  enabled: boolean;
  /** Escrows at or above this wei value use ensemble; below it, single model. */
  valueThresholdWei: bigint;
}

export interface EnsembleVerdict extends ModelVerdict {
  decidedBy: string; // "ensemble" or the single model id
  escalated: boolean; // true when models disagreed → dispute committee
  agreed: boolean; // whether modelA and modelB agreed
  modelAVerdict: Verdict;
  modelBVerdict: Verdict;
}

/**
 * Grade an artifact under ensemble policy.
 * When enabled and above the value threshold, run both models. If they agree,
 * return the shared verdict. If they disagree, mark escalated so the dispute
 * committee (Argus) resolves it.
 */
export class EnsembleRouter {
  constructor(private readonly config: EnsembleConfig) {}

  async grade(
    artifact: Artifact,
    promptVersion: string,
    escrowValueWei: bigint,
  ): Promise<EnsembleVerdict> {
    // Single-model fast path: ensemble off or below value threshold.
    if (!this.config.enabled || escrowValueWei < this.config.valueThresholdWei) {
      const v = await this.config.modelA.grade(artifact, promptVersion);
      return {
        ...v,
        decidedBy: this.config.modelA.id,
        escalated: false,
        agreed: true,
        modelAVerdict: v.verdict,
        modelBVerdict: v.verdict,
      };
    }

    const [a, b] = await Promise.all([
      this.config.modelA.grade(artifact, promptVersion),
      this.config.modelB.grade(artifact, promptVersion),
    ]);

    const agreed = a.verdict === b.verdict;
    if (agreed) {
      return {
        ...a,
        decidedBy: "ensemble",
        escalated: false,
        agreed: true,
        modelAVerdict: a.verdict,
        modelBVerdict: b.verdict,
      };
    }

    // Disagree → escalate to dispute committee. Return modelA's verdict as the
    // provisional signal but flagged for Argus review.
    return {
      ...a,
      decidedBy: "ensemble",
      escalated: true,
      agreed: false,
      modelAVerdict: a.verdict,
      modelBVerdict: b.verdict,
    };
  }
}
