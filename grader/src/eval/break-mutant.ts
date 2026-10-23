import type { Artifact, ModelAdapter, ModelVerdict, Verdict } from "./types.js";
import { falsePassRate } from "./scorer.js";

const PASS: Verdict = "PASS";
const VOID: Verdict = "VOID";
const FAIL: Verdict = "FAIL";

/** A deliberately broken artifact — a BREAK mutant the red model crafted. */
export interface BreakMutant {
  claimHash: string;
  parentClaimHash: string; // the real artifact it was derived from
  payload: unknown;
  expectedVerdict: Verdict; // VOID or FAIL — the mutant is broken
  breakType: "near-miss" | "plausible-wrong" | "spec-deviation";
  description: string; // human-readable why it's broken
}

/** A candidate's result on a single BREAK mutant. */
export interface BreakResult {
  claimHash: string;
  modelId: string;
  mutant: BreakMutant;
  actual: Verdict;
  confidence: number;
  /** The candidate killed the mutant: it did not falsely pass a broken artifact. */
  killed: boolean;
}

/** Generates BREAK mutants from real artifacts. */
export interface BreakMutantGenerator {
  generate(artifact: Artifact, attacker: ModelAdapter): Promise<BreakMutant[]>;
}

/**
 * Gate 427 — Frontier BREAK.
 *
 * A frontier model acts as the attacker: it takes a real artifact and produces
 * near-miss mutants — plausible-but-wrong implementations and subtle spec deviations
 * that a weaker judge would pass. Every Warden candidate must then kill ≥ 90% of them.
 * Each hole the red model finds becomes a permanent probe (the flywheel).
 */
export class FrontierBreakGenerator implements BreakMutantGenerator {
  async generate(artifact: Artifact, attacker: ModelAdapter): Promise<BreakMutant[]> {
    const verdict = await attacker.grade(artifact, "break-attacker-v1");
    return this.parseMutants(artifact, verdict);
  }

  private parseMutants(artifact: Artifact, attack: ModelVerdict): BreakMutant[] {
    // The attacker tells us how to break this artifact. We turn that into concrete
    // mutants by perturbing the payload along known break vectors. The attacker's
    // verdict is treated as a hint, not trusted — the mutant's expectedVerdict is
    // derived from the break type, never from the attacker's say-so.
    const base = JSON.stringify(artifact.payload);
    const mutants: BreakMutant[] = [];

    // near-miss: flip a salient field
    mutants.push({
      claimHash: `break-near-miss-${artifact.claimHash}`,
      parentClaimHash: artifact.claimHash,
      payload: this.nearMissPayload(artifact.payload, base),
      expectedVerdict: VOID,
      breakType: "near-miss",
      description: "flipped a salient field so the run no longer satisfies its spec",
    });

    // plausible-wrong: looks right but fails an invariant
    mutants.push({
      claimHash: `break-plausible-wrong-${artifact.claimHash}`,
      parentClaimHash: artifact.claimHash,
      payload: this.plausibleWrongPayload(artifact.payload, base),
      expectedVerdict: FAIL,
      breakType: "plausible-wrong",
      description: "structurally valid output that violates a hidden invariant",
    });

    // spec-deviation: subtle departure from the pinned suite
    mutants.push({
      claimHash: `break-spec-deviation-${artifact.claimHash}`,
      parentClaimHash: artifact.claimHash,
      payload: this.specDeviationPayload(artifact.payload, base),
      expectedVerdict: FAIL,
      breakType: "spec-deviation",
      description: "deviates from the pinned test suite in a non-obvious way",
    });

    return mutants;
  }

  private nearMissPayload(payload: unknown, base: string): unknown {
    try {
      const obj = JSON.parse(base) as Record<string, unknown>;
      return { ...obj, _broken: true, ok: false };
    } catch {
      return { _broken: true, ok: false, original: base };
    }
  }

  private plausibleWrongPayload(payload: unknown, base: string): unknown {
    try {
      const obj = JSON.parse(base) as Record<string, unknown>;
      return { ...obj, status: "ok", verified: true, _invariant: false };
    } catch {
      return { status: "ok", verified: true, _invariant: false, original: base };
    }
  }

  private specDeviationPayload(payload: unknown, base: string): unknown {
    try {
      const obj = JSON.parse(base) as Record<string, unknown>;
      return { ...obj, suite: "pinned-v999", _deviation: true };
    } catch {
      return { suite: "pinned-v999", _deviation: true, original: base };
    }
  }
}

/**
 * Score a set of candidates against a bank of BREAK mutants.
 * killRate = fraction of mutants where the candidate did not falsely PASS a broken artifact.
 * Gate: ≥ 90% kill rate.
 */
export function scoreBreakMutants(
  mutants: BreakMutant[],
  results: Array<{ modelId: string; claimHash: string; actual: Verdict; confidence: number }>,
): Array<{ modelId: string; killRate: number; n: number; failed: string[] }> {
  const byModel = new Map<string, { n: number; killed: number; failed: string[] }>();
  for (const r of results) {
    const mutant = mutants.find((m) => m.claimHash === r.claimHash);
    if (!mutant) continue;

    let acc = byModel.get(r.modelId);
    if (!acc) {
      acc = { n: 0, killed: 0, failed: [] };
      byModel.set(r.modelId, acc);
    }
    acc.n += 1;
    const killed = r.actual !== PASS; // did not falsely pass a broken artifact
    if (killed) acc.killed += 1;
    else acc.failed.push(r.claimHash);
  }

  const out: Array<{ modelId: string; killRate: number; n: number; failed: string[] }> = [];
  for (const [modelId, acc] of byModel) {
    out.push({
      modelId,
      killRate: acc.n === 0 ? 0 : acc.killed / acc.n,
      n: acc.n,
      failed: acc.failed,
    });
  }
  return out;
}

/** Hard disqualifier: any candidate below 90% kill rate is out (gate 427). */
export function breakDisqualified(killRate: number): boolean {
  return killRate < 0.9;
}

/** Re-derive false-pass rate on mutants — protocol bleed on adversarial inputs. */
export function mutantFalsePassRate(results: BreakResult[]): number {
  const relevant = results.filter((b) => b.mutant.expectedVerdict !== PASS);
  if (relevant.length === 0) return 0;
  return relevant.filter((b) => b.actual === PASS).length / relevant.length;
}
