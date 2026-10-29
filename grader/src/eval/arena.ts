import type {
  Artifact,
  EvalResult,
  ModelAdapter,
  ModelVerdict,
  Scorecard,
  ScorecardRow,
  SmokeThresholds,
  SuiteEpoch,
  SuiteName,
} from "./types.js";
import type { EvalManifest } from "@crucible/smith";
import { buildScorecard, scorecardLine } from "./scorer.js";
import { MemoryEvalCache, gradeCached, gradeFresh, type EvalCache } from "./cache.js";
import { suiteEpoch } from "./suites.js";
import type { SpendLedger } from "./frontier.js";
import { defaultGraderManifest, type ManifestBuilder } from "./manifest.js";

const DEFAULT_THRESHOLDS: SmokeThresholds = {
  maxFalsePassRate: 0.01, // <= 1% hard disqualifier
  maxP95LatencyMs: 20_000, // <= 20s p95 hard disqualifier
};

/**
 * Gate 424, enforced. Twenty draws per artifact at the adversarial stage, and a row is
 * disqualified if the draws disagree more than 2% of the time **or** if fewer than twenty draws
 * were taken at all — the second clause is the one that matters, because a single draw reports
 * perfect agreement and would otherwise sail through a gate it never faced.
 *
 * Twenty draws is twenty model calls, so this is deliberately attached to the stage that already
 * has only two candidates left, not to smoke where every candidate runs.
 */
const CONSISTENCY_RETESTS = 20;
const CONSISTENCY_THRESHOLDS: SmokeThresholds = {
  ...DEFAULT_THRESHOLDS,
  minAgreementRate: 0.98,
  minRetests: CONSISTENCY_RETESTS,
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
  private readonly cache: EvalCache;

  /**
   * Builds the evaluation manifest for each row.
   *
   * The arena knows the model, the suite and the corpus digest; it does not
   * know the provider, the model card, the seed or the thresholds. So the
   * builder is supplied by the caller - which holds those facts - and the
   * arena asks it per row. A row without a manifest would have no conditions
   * recorded at all, and a published score with no conditions is not
   * attributable to anything.
   */
  private readonly manifestFor: ManifestBuilder;

  /**
   * When supplied, the scorecard's cost column is measured instead of declared. The ledger is fed
   * by `withFrontierGuard` at the adapter boundary, so the arena reads back what the calls
   * actually cost rather than a number it invented - `avgCostUsd` used to be a literal `0`, which
   * is the same shape as a metric no code path can increment.
   *
   * The seam is `EvalCache`, not `MemoryEvalCache`. The hot tier is one process and one run, so a
   * tournament that was paid for yesterday paid for itself again today; `FileEvalCache` is the warm
   * tier that stops that, and a parameter typed to the concrete hot class is a warm tier with no
   * caller. Both implement the same interface and the arena asks for nothing else.
   */
  constructor(
    cache?: EvalCache,
    private readonly spend?: SpendLedger,
    manifestFor: ManifestBuilder = defaultGraderManifest,
  ) {
    this.cache = cache ?? new MemoryEvalCache();
    this.manifestFor = manifestFor;
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
      adversarial = await this.runSmoke(
        top3Unique,
        suiteFns,
        CONSISTENCY_RETESTS,
        CONSISTENCY_THRESHOLDS,
      );
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
      suiteEpoch: SuiteEpoch;
      results: EvalResult[];
      perArtifactConsistency: Map<string, Array<"PASS" | "VOID" | "FAIL">>;
      avgCostUsd: number;
      manifest: EvalManifest;
      manifestDigest: string;
    }> = [];
    for (const adapter of adapters) {
      for (const [suiteName, suiteFn] of Object.entries(suiteFns)) {
        const artifacts = suiteFn();
        // Hashed once per suite, from the artifacts the loop is about to grade — not from a
        // constant, and not from the suite's name. Two runs of the same name over two generations
        // of `suites.ts` produce two different epochs, which is the whole point of computing it here.
        const epoch = suiteEpoch(artifacts);
        const results: EvalResult[] = [];
        const perArtifact = new Map<string, Array<"PASS" | "VOID" | "FAIL">>();
        for (const artifact of artifacts) {
          const draws: Array<ModelVerdict & { cached: boolean }> = [];
          for (let r = 0; r < retests; r++) {
            // Draw 0 may be answered from the cache — it is the same fact a previous run paid
            // for. Every draw after it must reach the model, because agreement is a property of
            // the calls: re-reading a stored verdict twenty times reports 100% stability about
            // the cache, which is a real fact about the cache and a false one about the model.
            const gradeFn = r === 0 ? gradeCached : gradeFresh;
            draws.push(
              await gradeFn(
                this.cache,
                adapter,
                artifact,
                adapter.id.includes(":")
                  ? (adapter.id.split(":")[1] ?? "v1")
                  : "v1",
                epoch,
                async () => adapter.grade(artifact, "v1"),
              ),
            );
          }
          const last = draws.at(-1);
          const final = last?.verdict ?? "VOID";
          perArtifact.set(artifact.claimHash, draws.map((d) => d.verdict));

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
            suiteEpoch: epoch,
            expected: artifact.expectedVerdict,
            actual: final,
            // Both are read off the draw rather than written as literals. Every adapter measures
            // them — `Date.now() - start` in the three paid dialects, a deterministic figure in
            // the stub — and the cache files what they returned, so a hardcoded pair here made
            // the row disagree with the entry stored under the same key. `p95LatencyMs` read 0
            // for a model whose calls the ledger was billing, which left `maxP95LatencyMs`,
            // documented as a hard disqualifier, unable to fail. A draw served from the cache
            // carries the latency measured when that verdict was earned, which is what a hit
            // means at this layer: the same fact a previous run paid for.
            confidence: last?.confidence ?? 0,
            correct: final === artifact.expectedVerdict,
            falsePass: final === "PASS" && artifact.expectedVerdict !== "PASS",
            falseFail: final !== "PASS" && artifact.expectedVerdict === "PASS",
            latencyMs: last?.latencyMs ?? 0,
            killed: false,
            tier: artifact.tier,
            difficulty: artifact.difficulty,
            ...(artifact.safety === true ? { safety: true } : {}),
          });
        }

        const built = this.manifestFor({
            modelId: adapter.id,
            suite: suiteName as SuiteName,
            suiteEpoch: epoch,
          });
        entries.push({
          modelId: adapter.id,
          promptVersion: "v1",
          suite: suiteName as SuiteName,
          suiteEpoch: epoch,
          results,
          perArtifactConsistency: perArtifact,
          avgCostUsd: this.spend?.averageUsd(adapter.id) ?? 0,
          manifest: built.manifest,
          manifestDigest: built.digest,
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
  getCache(): EvalCache {
    return this.cache;
  }
}

export { CONSISTENCY_RETESTS, CONSISTENCY_THRESHOLDS, DEFAULT_THRESHOLDS };
