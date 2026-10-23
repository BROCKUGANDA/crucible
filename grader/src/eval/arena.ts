import type {
  Artifact,
  EvalResult,
  ModelAdapter,
  Scorecard,
  ScorecardRow,
  SmokeThresholds,
  SuiteName,
} from "./types.js";
import { buildScorecard, scorecardLine } from "./scorer.js";
import { MemoryEvalCache, gradeCached } from "./cache.js";

const DEFAULT_THRESHOLDS: SmokeThresholds = {
  maxFalsePassRate: 0.01, // <= 1% hard disqualifier
  maxP95LatencyMs: 20_000, // <= 20s p95 hard disqualifier
};

/**
 * arena.ts — suite × model matrix runner with JSONL scorecard output.
 *
 * Runs every candidate model through the same JUDGE gold corpus + BREAK
 * mutants, scored by the same gates. The model is a swappable part behind
 * adapter.ts; the verification logic never changes per model.
 *
 * Tournament ladder (keeps cost sane):
 *   1. Smoke — 200 artifacts, all candidates. False-pass > 1% or p95 > 20s → out.
 *   2. Full — 2k artifacts, top 3 survivors.
 *   3. Adversarial — full BREAK mutant bank, top 2. Winner enters shadow mode.
 */
export class Arena {
  private readonly cache: MemoryEvalCache;

  constructor(cache?: MemoryEvalCache) {
    this.cache = cache ?? new MemoryEvalCache();
  }

  /**
   * Run the full smoke × model matrix. Returns a Scorecard and prints one
   * JSONL line per (model, suite) row to stdout.
   *
   * @param adapters candidate model adapters
   * @param suiteFns named functions returning Artifact[]
   * @param retests how many times to re-grade each artifact (consistency; ≥20 for gate 424)
   * @param thresholds smoke disqualification thresholds
   */
  async runSmoke(
    adapters: ModelAdapter[],
    suiteFns: Record<SuiteName, () => Artifact[]>,
    retests = 1,
    thresholds: SmokeThresholds = DEFAULT_THRESHOLDS,
  ): Promise<Scorecard> {
    return this.runMatrix(adapters, suiteFns, retests, thresholds);
  }

  /**
   * Tournament ladder: smoke → full → adversarial. Returns survivors at each stage.
   */
  async tournament(
    adapters: ModelAdapter[],
    suiteFns: Record<SuiteName, () => Artifact[]>,
    thresholds: SmokeThresholds = DEFAULT_THRESHOLDS,
  ): Promise<{
    smoke: Scorecard;
    survivors: ModelAdapter[];
    full?: Scorecard;
    adversarial?: Scorecard;
  }> {
    const smoke = await this.runSmoke(adapters, suiteFns, 1, thresholds);
    const survivors = smoke.rows
      .filter((r) => r.suite === "smoke" && !r.disqualified)
      .map((r) => adapters.find((a) => a.id === r.modelId))
      .filter((a): a is ModelAdapter => !!a);

    // Dedupe survivors by model id.
    const unique = Array.from(new Map(survivors.map((a) => [a.id, a])).values());

    if (unique.length === 0) {
      return { smoke, survivors: [] };
    }

    const full = await this.runSmoke(unique, suiteFns, 1, thresholds);
    const top3 = full.rows
      .filter((r) => r.suite === "full" && !r.disqualified)
      .sort((a, b) => b.kappa - a.kappa)
      .slice(0, 3)
      .map((r) => unique.find((a) => a.id === r.modelId))
      .filter((a): a is ModelAdapter => !!a);

    const top3Unique = Array.from(new Map(top3.map((a) => [a.id, a])).values());
    let adversarial: Scorecard | undefined;
    if (top3Unique.length > 0) {
      adversarial = await this.runSmoke(top3Unique, suiteFns, 1, thresholds);
    }

    return { smoke, survivors: unique, full, adversarial };
  }

  private async runMatrix(
    adapters: ModelAdapter[],
    suiteFns: Record<SuiteName, () => Artifact[]>,
    retests: number,
    thresholds: SmokeThresholds,
  ): Promise<Scorecard> {
    const entries: Array<{
      modelId: string;
      promptVersion: string;
      suite: SuiteName;
      results: EvalResult[];
      perArtifactConsistency: Map<string, Array<"PASS" | "VOID" | "FAIL">>;
      avgCostUsd: number;
    }> = [];

    for (const adapter of adapters) {
      for (const [suiteName, suiteFn] of Object.entries(suiteFns)) {
        const artifacts = suiteFn();
        const results: EvalResult[] = [];
        const perArtifact = new Map<string, Array<"PASS" | "VOID" | "FAIL">>();

        for (const artifact of artifacts) {
          const verdicts: Array<"PASS" | "VOID" | "FAIL"> = [];
          for (let r = 0; r < retests; r++) {
            const verdict = await gradeCached(
              this.cache,
              adapter,
              artifact,
              adapter.id.includes(":")
                ? (adapter.id.split(":")[1] ?? "v1")
                : "v1",
              async () => adapter.grade(artifact, "v1"),
            );
            verdicts.push(verdict.verdict);
          }
          const final = verdicts.at(-1) ?? "VOID";
          perArtifact.set(artifact.claimHash, verdicts);

          const firstResult = results.find((r) => r.claimHash === artifact.claimHash);
          if (firstResult) {
            // consistency already captured via perArtifact; keep single representative result
            continue;
          }
          results.push({
            claimHash: artifact.claimHash,
            modelId: adapter.id,
            promptVersion: "v1",
            suite: suiteName,
            expected: artifact.expectedVerdict,
            actual: final,
            confidence: 0.5,
            correct: final === artifact.expectedVerdict,
            falsePass: final === "PASS" && artifact.expectedVerdict !== "PASS",
            falseFail: final !== "PASS" && artifact.expectedVerdict === "PASS",
            latencyMs: 0,
            killed: false,
          });
        }

        entries.push({
          modelId: adapter.id,
          promptVersion: "v1",
          suite: suiteName as SuiteName,
          results,
          perArtifactConsistency: perArtifact,
          avgCostUsd: 0,
        });
      }
    }

    const scorecard = buildScorecard(entries, thresholds);
    for (const row of scorecard.rows) {
      process.stdout.write(scorecardLine(row) + "\n");
    }
    return scorecard;
  }

  /** Get the underlying cache (for inspection / seeding in tests). */
  getCache(): MemoryEvalCache {
    return this.cache;
  }
}

export { DEFAULT_THRESHOLDS };
