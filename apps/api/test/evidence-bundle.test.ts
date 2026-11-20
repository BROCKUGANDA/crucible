/**
 * @file evidence-bundle.test.ts — the frozen evidence of a dispute.
 *
 * The claims under test:
 *
 *   - a bundle carries what the CHAIN said and what the PLATFORM measured,
 *     and never a value either of them did not say;
 *   - a bundle says what it does NOT contain, so an omission is not read as
 *     completeness;
 *   - a bundle is content-addressed and cannot be edited afterwards;
 *   - a bundle sealed AFTER the break is marked as not being the bundle the
 *     parties saw.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  assembleBundle,
  buildBundle,
  predatesDispute,
  verifyBundleDigest,
  type BundleMeasurement,
  type EvidenceBundle,
} from "../src/evidence-bundle.js";
import {
  createReplayManifest,
  createReplayRecord,
  completeReplay,
  resetReplayStore,
} from "../src/replay-manifest.js";
import { createRubric, createDimensionScore, createAggregateScore, resetScoringStore } from "../src/scoring.js";
import { createSuite, createSuiteVersion, resetSuiteStore } from "../src/suites.js";
import { generateEvaluationSpec, resetSpecStore } from "../src/evaluation-spec.js";

const TRIAL = "42";
const AGENT = "agent_bundle_1";

async function resetAll() {
  await resetReplayStore();
  resetScoringStore();
  resetSuiteStore();
  resetSpecStore();
}

/** A measurement: a pinned spec, three agreeing replays and a score. */
async function seedMeasurement() {
  const suite = createSuite({
    id: "suite_bundle_1",
    orgId: null,
    name: "Bundle Suite",
    slug: "bundle-suite",
    description: "d",
    maintainer: "m",
    visibility: "public",
  });
  createSuiteVersion(
    {
      id: "sv_bundle_1",
      suiteId: suite.id,
      version: "1.0.0",
      schemaVersion: 1,
      taskFamilies: ["coding"],
      capabilityDomains: ["correctness"],
      difficulty: "medium",
      evaluationProtocol: "deterministic",
      scoringRules: {},
      testFixtures: {},
      requiredTools: [],
      runtimeConstraints: {},
      safetyRequirements: {},
      expectedArtifacts: [],
      validationRules: {},
      knownLimitations: "does not test concurrency",
      changelog: "first",
    },
    "sha256:suite-digest-bundle",
  );
  const spec = generateEvaluationSpec({
    trialId: TRIAL,
    suiteId: suite.id,
    agentId: AGENT,
    executionEnvironment: {
      runtimeImage: "crucible/agent@sha256:image-digest-1",
      cpuLimit: 1,
      memoryLimitMb: 512,
      timeLimitSeconds: 60,
      networkEgress: false,
    },
    scoringMethodology: { dimensions: [{ name: "CORRECTNESS", weight: 1 }] },
  });
  const rubric = createRubric({
    id: "rubric_bundle_1",
    name: "Bundle Rubric",
    description: "d",
    dimensions: [{ dimension: "CORRECTNESS", weight: 1, methodology: "the acceptance tests" }],
    createdBy: "author",
  });
  createDimensionScore({
    runId: "run_bundle_1",
    rubricId: rubric.id,
    dimension: "CORRECTNESS",
    score: 0.9,
    methodology: "the acceptance tests",
    confidenceLower: 0.8,
    confidenceUpper: 1,
    sampleCount: 3,
  });
  createAggregateScore("run_bundle_1", rubric.id, "weighted");

  const manifest = await createReplayManifest({
    trialId: TRIAL,
    runId: "run_bundle_1",
    specDigest: spec.specDigest,
    suiteVersion: "1.0.0",
    agentId: AGENT,
    runtimeImageDigest: "sha256:image-digest-1",
    executionConfig: {},
    judgeVersion: "judge-1",
    environmentFingerprint: "env-1",
    artifactHashes: {},
    workerIdentity: "worker-1",
  });
  for (let n = 1; n <= 3; n += 1) {
    const replay = await createReplayRecord(manifest.manifestId, n, `worker-${n}`);
    await completeReplay(replay.replayId, "sha256:same-output");
  }
  return { spec, manifest };
}

function emptyMeasurement(overrides: Partial<BundleMeasurement> = {}): BundleMeasurement {
  return {
    pinnedSpecDigest: null,
    measurementKey: null,
    manifestIds: [],
    replays: [],
    replaysAgreed: null,
    dimensions: [],
    aggregateBps: null,
    confidenceLowerBps: null,
    confidenceUpperBps: null,
    sampleCount: 0,
    scoreStatus: null,
    publicationId: null,
    ...overrides,
  };
}

describe("the evidence bundle", () => {
  beforeEach(async () => {
    await resetAll();
  });

  describe("what it carries", () => {
    it("carries the chain's facts and the platform's measurement, and nothing either did not say", async () => {
      const bundle = await assembleBundle({
        trialKey: TRIAL,
        sealedAt: 1_700_000_000_000,
        chain: {
          trialId: 42,
          sponsor: "0xsponsor",
          status: "Challenged",
          verdict: "Pending",
          specDigest: "0x" + "a".repeat(64),
          testsDigest: "0x" + "b".repeat(64),
          disclosedSpecCid: null,
          disclosedTestsCid: null,
          breakSkeptic: "0xskeptic",
          breakProofCid: null,
          disputeOpenedAt: 1_700_000_500,
        },
        spec: null,
        manifests: [],
        aggregate: null,
        dimensionScores: [],
      });

      expect(bundle.chain?.sponsor).toBe("0xsponsor");
      expect(bundle.chain?.disputeOpenedAt).toBe(1_700_000_500);
      expect(bundle.measurement.aggregateBps).toBeNull();
      expect(bundle.measurement.replaysAgreed).toBeNull();

      // Every field the chain did not provide is null, not a zero and not a
      // default.
      expect(bundle.chain?.disclosedSpecCid).toBeNull();
      expect(bundle.chain?.breakProofCid).toBeNull();
    });

    it("carries a real measurement: the replays, their agreement and the score", async () => {
      await seedMeasurement();
      const bundle = await buildBundle(TRIAL, 1_700_000_000_000);

      expect(bundle.measurement.replays.length).toBe(3);
      expect(bundle.measurement.replaysAgreed).toBe(true);
      expect(bundle.measurement.aggregateBps).toBe(9000);
      expect(bundle.measurement.confidenceLowerBps).toBe(8000);
      expect(bundle.measurement.pinnedSpecDigest).toBeTruthy();
      expect(bundle.measurement.measurementKey).toBeTruthy();
      expect(bundle.measurement.dimensions[0]?.scoreBps).toBe(9000);
    });
  });

  describe("what it says it does not contain", () => {
    it("says the suite was not disclosed, rather than omitting it", async () => {
      const bundle = await assembleBundle({
        trialKey: TRIAL,
        sealedAt: 1,
        chain: {
          trialId: 42,
          specDigest: "0x" + "a".repeat(64),
          disclosedSpecCid: null,
          breakSkeptic: "0xskeptic",
        },
        spec: null,
        manifests: [],
        aggregate: null,
        dimensionScores: [],
      });
      // The SPECIFIC gap: another gap ("the break's proof was not disclosed")
      // shares the words "not disclosed", and a check that matches either
      // one cannot tell the mutation that removes this one from the one
      // that removes that one.
      expect(bundle.gaps).toContain(
        "The sponsor has not disclosed the suite for this trial, so the pinned files behind the committed digest are not in this bundle.",
      );
    });

    it("says the break's own proof is missing, when it was filed without one", async () => {
      const bundle = await assembleBundle({
        trialKey: TRIAL,
        sealedAt: 1,
        chain: { breakSkeptic: "0xskeptic", breakProofCid: null },
        spec: null,
        manifests: [],
        aggregate: null,
        dimensionScores: [],
      });
      expect(bundle.gaps).toContain(
        "A break was filed but its proof was not disclosed, so the break's own evidence is missing from this bundle.",
      );
    });

    it("says there is no measurement when no manifest was recorded", async () => {
      await seedMeasurement();
      await resetReplayStore();
      const bundle = await buildBundle(TRIAL, 1);
      expect(bundle.gaps.some((g) => g.includes("No replay manifest"))).toBe(true);
    });

    it("says the score is missing rather than showing none", async () => {
      await seedMeasurement();
      resetScoringStore();
      const bundle = await buildBundle(TRIAL, 1);
      expect(bundle.gaps.some((g) => g.includes("No aggregate score"))).toBe(true);
      expect(bundle.measurement.aggregateBps).toBeNull();
    });

    it("says the replays did not agree, when they did not", async () => {
      await seedMeasurement();
      // A fourth, disagreeing replay on a fresh manifest.
      const manifest = await createReplayManifest({
        trialId: "77",
        runId: "run_77",
        specDigest: "sha256:x",
        suiteVersion: "1.0.0",
        agentId: AGENT,
        runtimeImageDigest: "sha256:image-digest-1",
        executionConfig: {},
        judgeVersion: "judge-1",
        environmentFingerprint: "env-1",
        artifactHashes: {},
        workerIdentity: "worker-1",
      });
      const a = await createReplayRecord(manifest.manifestId, 1, "w1");
      const b = await createReplayRecord(manifest.manifestId, 2, "w2");
      await completeReplay(a.replayId, "sha256:output-a");
      await completeReplay(b.replayId, "sha256:output-b");

      const bundle = await buildBundle("77", 1);
      expect(bundle.measurement.replaysAgreed).toBe(false);
      expect(bundle.gaps.some((g) => g.includes("did not agree"))).toBe(true);
    });
  });

  describe("its identity", () => {
    it("is content-addressed, so it cannot be edited afterwards", async () => {
      const base: Parameters<typeof assembleBundle>[0] = {
        trialKey: TRIAL,
        sealedAt: 1_700_000_000_000,
        chain: { trialId: 42, specDigest: "0x" + "a".repeat(64) },
        spec: null,
        manifests: [],
        aggregate: null,
        dimensionScores: [],
      };
      const first = await assembleBundle(base);
      // The address names WHAT was frozen, so sealing the same evidence
      // again is the same bundle — not a second row saying the same thing.
      const second = await assembleBundle({ ...base, sealedAt: 1_700_000_000_001 });
      expect(second.digest).toBe(first.digest);
      expect(second.id).toBe(first.id);

      // Any change to the content changes the address.
      const changed = await assembleBundle({
        ...base,
        chain: { trialId: 42, specDigest: "0x" + "c".repeat(64) },
      });
      expect(changed.digest).not.toBe(first.digest);
      expect(changed.id).not.toBe(first.id);
      expect(first.id.startsWith("bundle_")).toBe(true);
    });

    it("can be CHECKED: a reader can recompute the digest and a tampered bundle fails", async () => {
      const bundle = await assembleBundle({
        trialKey: TRIAL,
        sealedAt: 1_700_000_000_000,
        chain: { trialId: 42, specDigest: "0x" + "a".repeat(64) },
        spec: null,
        manifests: [],
        aggregate: null,
        dimensionScores: [],
      });
      expect(verifyBundleDigest(bundle)).toBe(true);

      // A gap removed after the fact: the address no longer matches the
      // contents, and the check says so.
      const tampered = { ...bundle, gaps: bundle.gaps.slice(1) };
      expect(verifyBundleDigest(tampered)).toBe(false);

      // A score invented after the fact: same answer.
      const forged = {
        ...bundle,
        measurement: { ...bundle.measurement, aggregateBps: 10000 },
      };
      expect(verifyBundleDigest(forged)).toBe(false);
    });
  });

  describe("whether it is the bundle the parties saw", () => {
    const bundle = async (sealedAtChainSeconds: number | null): Promise<EvidenceBundle> =>
      assembleBundle({
        trialKey: TRIAL,
        sealedAt: 1_700_000_000_000,
        sealedAtChainSeconds,
        chain: null,
        spec: null,
        manifests: [],
        aggregate: null,
        dimensionScores: [],
      });

    it("says a bundle sealed before the break predates it", async () => {
      // The seal and the dispute are compared on the CHAIN's clock. The
      // host's wall clock is a different clock, and mixing them inverts the
      // answer by a factor of a thousand.
      expect(predatesDispute(await bundle(1_700_000_400), 1_700_000_500)).toBe(true);
    });

    it("says a bundle sealed after the break does not predate it", async () => {
      expect(predatesDispute(await bundle(1_700_000_600), 1_700_000_500)).toBe(false);
    });

    it("says nothing when the chain has not said when the dispute opened", async () => {
      expect(predatesDispute(await bundle(1_700_000_400), null)).toBeNull();
    });

    it("says nothing when this host could not read the chain's clock", async () => {
      // Two clocks: the chain's and the host's. A seal compared against a
      // dispute across the two is a guess, and a guess here decides whether
      // a committee is reading the parties' evidence.
      expect(predatesDispute(await bundle(null), 1_700_000_500)).toBeNull();
    });
  });
});
