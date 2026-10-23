import type { Artifact, ModelAdapter, ModelVerdict, Verdict } from "./types.js";

const PASS: Verdict = "PASS";

/** Gate 428 — Cascade routing.
 *
 * Cheap fast model grades first; low-confidence or boundary-band verdicts escalate
 * to the frontier model. The signed verdict records *which* model decided —
 * graderVersion covers the whole config. Cuts cost ~5-10× with zero quality loss
 * on easy artifacts.
 */
export interface CascadeConfig {
  cheapModel: ModelAdapter;
  frontierModel: ModelAdapter;
  /** Escalate to frontier when confidence is below this (0..1). */
  escalationConfidence: number;
  /** Always escalate when confidence falls in this band. */
  boundaryBand: [number, number];
}

export interface CascadeVerdict extends ModelVerdict {
  decidedBy: string; // which adapter id made the final call
  escalated: boolean; // whether the frontier model was consulted
}

/**
 * Route a single artifact through the cascade.
 * Returns the verdict plus metadata on who decided.
 */
export class CascadeRouter {
  constructor(private readonly config: CascadeConfig) {}

  async grade(artifact: Artifact, promptVersion: string): Promise<CascadeVerdict> {
    const cheap = await this.config.cheapModel.grade(artifact, promptVersion);
    const inBoundary =
      cheap.confidence >= this.config.boundaryBand[0] &&
      cheap.confidence <= this.config.boundaryBand[1];
    const lowConfidence = cheap.confidence < this.config.escalationConfidence;

    if (!lowConfidence && !inBoundary) {
      return { ...cheap, decidedBy: this.config.cheapModel.id, escalated: false };
    }

    const frontier = await this.config.frontierModel.grade(artifact, promptVersion);
    return {
      ...frontier,
      decidedBy: this.config.frontierModel.id,
      escalated: true,
    };
  }

  /** Decide whether an artifact should be escalated without grading (for budgeting). */
  shouldEscalate(confidence: number): boolean {
    return (
      confidence < this.config.escalationConfidence ||
      (confidence >= this.config.boundaryBand[0] && confidence <= this.config.boundaryBand[1])
    );
  }
}
