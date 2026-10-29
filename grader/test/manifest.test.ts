import { describe, expect, it } from "vitest";
import { compareManifests, manifestDigest, scoresComparable } from "@crucible/smith";
import {
  buildGraderManifest,
  defaultGraderManifest,
  graderManifest,
  incomparability,
  scoresComparable as rowsComparable,
  type ModelCard,
} from "../src/index.js";

/**
 * The grader consumes the manifest.
 *
 * A scorecard row says how a model did. It did not say what was asked, of
 * what, by whom, at which thresholds - so a published score was not
 * attributable to anything, and two rows over different corpora wearing the
 * same `suite` name were indistinguishable.
 *
 * These tests are about the row carrying the manifest, and about the guard
 * that refuses to compare two rows whose conditions differ. The
 * mutation proofs at the end are the point: a green that cannot be turned red
 * is decoration.
 */

const EPOCH = "ef9ce631818d566084f28c4b51dff017f384ad9062ef93fa4d824de3f4ec51aa";
const EPOCH_B = "912a9c4e621112b3b0c7171c2e82737f58b66dd92f3e1c7635e3a0d52c981681";

const CARD: ModelCard = {
  id: "hetzner-qwen",
  dialect: "openai-compat",
  snapshot: "Qwen/Qwen3.6-35B-A3B",
  pinnedAt: "2026-10-27",
  roles: ["contestant"],
  retention: {
    retention: "api-logs-retained",
    reviewedAt: "2026-10-27",
    source: "https://www.hetzner.com/legal/privacy-policy/",
  },
  budgetUsd: { stage: 2, day: 10 },
  costPerCallUsd: 0,
  maxCallsPerStage: 64,
  latencyP95Ms: 20000,
};

function inputs(over: Record<string, unknown> = {}) {
  return {
    modelId: "hetzner-qwen",
    provider: "openai-compat",
    card: CARD,
    suite: "abstention",
    suiteEpoch: EPOCH,
    corpusEpoch: EPOCH,
    promptVersion: "v1",
    seed: "panel-2026-10-27",
    evaluatorVersion: "1.0.0",
    thresholds: { maxFalsePassRate: "0.01", maxP95LatencyMs: "20000" },
    startedAt: "2026-10-27T12:00:00.000Z",
    finishedAt: "2026-10-27T12:00:41.000Z",
    ...over,
  } as Parameters<typeof graderManifest>[0];
}

describe("the grader's manifest", () => {
  it("pins the corpus, the evaluator, the model's exact snapshot and the seed", () => {
    const { manifest } = buildGraderManifest(inputs());
    expect(manifest.taskDigest).toBe(EPOCH);
    expect(manifest.suiteDigest).toBe(EPOCH);
    expect(manifest.evaluator.id).toBe("grader");
    expect(manifest.evaluator.version).toBe("1.0.0");
    expect(manifest.model.provider).toBe("openai-compat");
    expect(manifest.model.version).toBe("Qwen/Qwen3.6-35B-A3B");
    expect(manifest.seed).toBe("panel-2026-10-27");
    expect(manifest.sampling?.maxFalsePassRate).toBe("0.01");
  });

  it("records the seed the draw was taken with, not a placeholder", () => {
    // The seed is the reproducibility input. A grader run with a seeded draw
    // can be re-derived by anyone holding the seed and the corpus; a run
    // without one cannot, and the manifest has to say which it was.
    const seeded = buildGraderManifest(inputs({ seed: "trial-0001" }));
    const unseeded = buildGraderManifest(inputs({ seed: "unset" }));
    expect(seeded.manifest.seed).toBe("trial-0001");
    expect(unseeded.manifest.seed).toBe("unset");
    expect(seeded.digest).not.toBe(unseeded.digest);
  });

  it("refuses a model card whose snapshot is a moving alias", () => {
    expect(() =>
      buildGraderManifest(inputs({ card: { ...CARD, snapshot: "qwen-latest" } })),
    ).toThrow(/moving alias/);
  });

  it("carries no sandbox image, because the grader has none", () => {
    // The grader evaluates a model against a corpus it holds in memory. It
    // does not execute an agent in a sandbox, and a manifest that named a
    // sandbox image would be a claim about a measurement that was not made.
    const { manifest } = buildGraderManifest(inputs());
    expect(manifest.agent).toBeUndefined();
    expect(manifest.environment.networkPolicy).toBe("none");
  });

  it("is reproducible: the same inputs give the same digest", () => {
    expect(buildGraderManifest(inputs()).digest).toBe(buildGraderManifest(inputs()).digest);
  });

  it("changes its digest when the corpus changes", () => {
    expect(buildGraderManifest(inputs()).digest).not.toBe(
      buildGraderManifest(inputs({ suiteEpoch: EPOCH_B })).digest,
    );
  });

  it("changes its digest when the thresholds change", () => {
    // The thresholds decide whether a row is disqualified. Two rows scored
    // under different thresholds are not the same measurement, and a
    // leaderboard that mixed them would rank rows that were never on the
    // same footing.
    expect(buildGraderManifest(inputs()).digest).not.toBe(
      buildGraderManifest(
        inputs({ thresholds: { maxFalsePassRate: "0.02", maxP95LatencyMs: "20000" } }),
      ).digest,
    );
  });

  it("degrades rather than disappearing when the caller holds no card", () => {
    // A row with no manifest has no conditions at all. A row with a manifest
    // that names its corpus and says "the seed was not recorded" is
    // strictly more useful and strictly more honest than either.
    const { manifest } = defaultGraderManifest({
      modelId: "stub",
      suite: "smoke",
      suiteEpoch: EPOCH,
    });
    expect(manifest.taskDigest).toBe(EPOCH);
    expect(manifest.seed).toBe("unset");
    expect(manifest.model.name).toBe("stub");
  });

  it("does not claim an adapter id is a pinned version", () => {
    // An adapter id names which implementation answered. It says nothing
    // about which release of the model was called, and several adapter ids
    // end in a word the alias rule refuses - so using one as a version
    // would both overstate what was pinned and trip the rule.
    const { manifest } = defaultGraderManifest({
      modelId: "counting-stable",
      suite: "smoke",
      suiteEpoch: EPOCH,
    });
    expect(manifest.model.name).toBe("counting-stable");
    expect(manifest.model.version).toBe("unpinned");
  });
});

describe("the row the arena produces", () => {
  it("carries the manifest and a digest that names it", async () => {
    // The unit that matters: a row that reaches a reader has to carry the
    // conditions it was produced under, and the digest has to be *that*
    // manifest's - not some other row's.
    const { Arena } = await import("../src/index.js");
    const { StubModelAdapter } = await import("../src/eval/adapters/stub.js");
    const adapter = new StubModelAdapter("v1");
    const scorecard = await new Arena().runSmoke(
      [adapter],
      { smoke: () => [] },
      1,
      { maxFalsePassRate: 0.01, maxP95LatencyMs: 20_000 },
    );
    expect(scorecard.rows.length).toBe(1);
    const row = scorecard.rows[0];
    expect(row.manifest).toBeDefined();
    expect(row.manifestDigest).toBe(manifestDigest(row.manifest));
    // And the digest is what a reader fetches the manifest by.
    expect(row.manifestDigest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("gives two rows over different corpora different manifest digests", async () => {
    // Two rows wearing the same `suite` name over different corpora are
    // different exams. The manifest digest has to say so.
    const { Arena } = await import("../src/index.js");
    const { StubModelAdapter } = await import("../src/eval/adapters/stub.js");
    const artifact = {
      claimHash: "c1",
      payload: { text: "x" },
      expectedVerdict: "PASS" as const,
      suite: "smoke",
      tier: "competence" as const,
      difficulty: "routine" as const,
    };
    const arena = new Arena();
    const first = await arena.runSmoke(
      [new StubModelAdapter("v1")],
      { smoke: () => [artifact] },
      1,
      { maxFalsePassRate: 0.01, maxP95LatencyMs: 20_000 },
    );
    const second = await arena.runSmoke(
      [new StubModelAdapter("v1")],
      {
        smoke: () => [{ ...artifact, claimHash: "c2", difficulty: "stressed" as const }],
      },
      1,
      { maxFalsePassRate: 0.01, maxP95LatencyMs: 20_000 },
    );
    expect(first.rows[0].manifestDigest).not.toBe(second.rows[0].manifestDigest);
    expect(first.rows[0].manifest.taskDigest).not.toBe(second.rows[0].manifest.taskDigest);
  });

  it("carries the CALLER's manifest, not a default one", async () => {
    // The default builder exists for a caller with no card and no seed. A
    // caller that *does* hold those facts - the provider, the pinned
    // snapshot, the draw's seed - must get them onto the row, or the whole
    // point of the manifest is lost: every published row would say "unpinned"
    // and "unset" while the run knew better.
    const { Arena } = await import("../src/index.js");
    const { StubModelAdapter } = await import("../src/eval/adapters/stub.js");
    const seen: string[] = [];
    const arena = new Arena(undefined, undefined, (ctx) => {
      seen.push(ctx.modelId);
      return buildGraderManifest(
        inputs({
          modelId: ctx.modelId,
          suite: ctx.suite,
          suiteEpoch: ctx.suiteEpoch,
          provider: "openai-compat",
          card: { ...CARD, id: ctx.modelId },
          seed: "the-real-seed",
        }),
      );
    });
    const scorecard = await arena.runSmoke(
      [new StubModelAdapter("v1", "hetzner-qwen")],
      { smoke: () => [] },
      1,
      { maxFalsePassRate: 0.01, maxP95LatencyMs: 20_000 },
    );
    // The builder was asked for this model.
    expect(seen).toEqual(["hetzner-qwen"]);
    // And the row carries what it returned.
    const row = scorecard.rows[0];
    expect(row.manifest.seed).toBe("the-real-seed");
    expect(row.manifest.model.provider).toBe("openai-compat");
    expect(row.manifest.model.version).toBe("Qwen/Qwen3.6-35B-A3B");
    // And the digest is that manifest's, not a default one's.
    expect(row.manifestDigest).toBe(manifestDigest(row.manifest));
    expect(row.manifestDigest).not.toBe(
      defaultGraderManifest({
        modelId: "hetzner-qwen",
        suite: "smoke",
        suiteEpoch: row.suiteEpoch,
      }).digest,
    );
  });
});

describe("comparing two rows", () => {
  const row = (over: Record<string, unknown> = {}) => {
    const { manifest, digest } = buildGraderManifest(inputs(over));
    return {
      modelId: "hetzner-qwen",
      promptVersion: "v1",
      suite: "abstention",
      suiteEpoch: EPOCH,
      manifestDigest: digest,
      manifest,
      n: 4,
      graded: 4,
      tiers: [],
      falsePassRate: 0,
      falseFailRate: 0,
      accuracy: 1,
      kappa: 1,
      killRate: 0,
      consistency: 1,
      avgLatencyMs: 1,
      p95LatencyMs: 1,
      avgCostUsd: 0,
      disqualified: false,
    };
  };

  it("says two rows over the same corpus are comparable", () => {
    expect(rowsComparable(row(), row())).toBe(true);
  });

  it("says two rows over different corpora are not, and names the field", () => {
    const differences = incomparability(row(), row({ suiteEpoch: EPOCH_B }));
    expect(differences.length).toBeGreaterThan(0);
    expect(differences.map((d) => d.path)).toContain("taskDigest");
    expect(rowsComparable(row(), row({ suiteEpoch: EPOCH_B }))).toBe(false);
  });

  it("treats a different model as the subject of the comparison, not a bar to it", () => {
    // Two rows that differ only in their model are exactly the rows a
    // leaderboard is made of. Comparing them with the model included would
    // report every pair of candidates as incomparable and refuse to rank
    // anything.
    const a = row();
    const b = row({ modelId: "other", card: { ...CARD, id: "other", snapshot: "Qwen/Qwen3.8-27B" } });
    expect(rowsComparable(a, b)).toBe(true);
    // And the underlying manifests DO differ - the model is recorded, it is
    // just not a comparability condition.
    expect(compareManifests(a.manifest, b.manifest).length).toBeGreaterThan(0);
  });

  it("says two rows scored under different thresholds are not comparable", () => {
    const a = row();
    const b = row({ thresholds: { maxFalsePassRate: "0.02", maxP95LatencyMs: "20000" } });
    expect(rowsComparable(a, b)).toBe(false);
    expect(incomparability(a, b).map((d) => d.path)).toContain("sampling.maxFalsePassRate");
  });

  it("says two rows graded under different seeds are not comparable", () => {
    expect(rowsComparable(row(), row({ seed: "other-seed" }))).toBe(false);
  });
});

describe("the manifest rules the grader leans on", () => {
  it("a score comparison excludes the model, a manifest comparison does not", () => {
    // Two different questions. "Is this the same evaluation?" needs the
    // model. "May these two numbers be set side by side?" must not - the
    // model is the thing being compared.
    const a = buildGraderManifest(inputs()).manifest;
    const b = buildGraderManifest(
      inputs({ card: { ...CARD, snapshot: "Qwen/Qwen3.8-27B" } }),
    ).manifest;
    expect(scoresComparable(a, b)).toBe(true);
    expect(manifestDigest(a)).not.toBe(manifestDigest(b));
  });
});

/**
 * The mutation proofs.
 */
describe("the claims are falsifiable", () => {
  it("a row that dropped the manifest digest is caught", () => {
    const { manifest, digest } = buildGraderManifest(inputs());
    expect(digest).toBe(manifestDigest(manifest));
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("a comparator that included the model is caught", () => {
    const a = buildGraderManifest(inputs()).manifest;
    const b = buildGraderManifest(
      inputs({ card: { ...CARD, snapshot: "Qwen/Qwen3.8-27B" } }),
    ).manifest;
    // If the model were a comparability condition, no leaderboard could
    // exist.
    expect(scoresComparable(a, b)).toBe(true);
  });

  it("a comparator that ignored the corpus is caught", () => {
    const a = buildGraderManifest(inputs()).manifest;
    const b = buildGraderManifest(inputs({ suiteEpoch: EPOCH_B })).manifest;
    expect(scoresComparable(a, b)).toBe(false);
  });

  it("a comparator that ignored the thresholds is caught", () => {
    const a = buildGraderManifest(inputs()).manifest;
    const b = buildGraderManifest(
      inputs({ thresholds: { maxFalsePassRate: "0.02", maxP95LatencyMs: "20000" } }),
    ).manifest;
    expect(scoresComparable(a, b)).toBe(false);
  });

  it("a builder that accepted a moving alias is caught", () => {
    expect(() =>
      buildGraderManifest(inputs({ card: { ...CARD, snapshot: "qpt-latest" } })),
    ).toThrow();
  });

  it("a builder that recorded the wrong seed is caught", () => {
    expect(buildGraderManifest(inputs({ seed: "panel-2026-10-27" })).manifest.seed).toBe(
      "panel-2026-10-27",
    );
    expect(buildGraderManifest(inputs({ seed: "other" })).digest).not.toBe(
      buildGraderManifest(inputs()).digest,
    );
  });
});
