/**
 * @file publication.test.ts — what a published score was measured against,
 * and what it does not establish.
 *
 * The claim under test: a number published without its method is a claim,
 * and a number published without its LIMITS is a marketing claim. So the
 * card must carry the suite digest, the rubric with its weights, the judge,
 * the repetitions, and — derived from those — a list of what the score does
 * not establish.
 *
 * The comparisons must say "not comparable" when two scores were measured
 * differently. A comparison that quietly produced a difference between two
 * incomparable numbers would be the most expensive kind of lie in the
 * product.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  assemblePublication,
  comparePublications,
  deriveLimits,
  publishForManifest,
  verifyPublicationDigest,
  type PublishedMethod,
} from "../src/publication.js";
import {
  createReplayManifest,
  createReplayRecord,
  completeReplay,
  resetReplayStore,
  type ReplayManifest,
} from "../src/replay-manifest.js";
import { createRubric, createDimensionScore, createAggregateScore, resetScoringStore } from "../src/scoring.js";
import { createSuite, createSuiteVersion, resetSuiteStore } from "../src/suites.js";
import { generateEvaluationSpec, resetSpecStore } from "../src/evaluation-spec.js";

const RUN = "run_publication_1";
const TRIAL = "trial_publication_1";
const AGENT = "agent_publication_1";

function resetAll() {
  resetReplayStore();
  resetScoringStore();
  resetSuiteStore();
  resetSpecStore();
}

function makeSuite(overrides: { knownLimitations?: string; version?: string } = {}) {
  const suite = createSuite({
    id: "suite_publication_1",
    orgId: null,
    name: "Publication Suite",
    slug: "publication-suite",
    description: "A suite with a version",
    maintainer: "maintainer",
    visibility: "public",
  });
  const version = createSuiteVersion({
    id: "version_publication_1",
    suiteId: suite.id,
    version: overrides.version ?? "1.0.0",
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
    knownLimitations: overrides.knownLimitations ?? "",
    changelog: "first",
    specDigest: "sha256:suite-digest-1",
  });
  return { suite, version };
}

/**
 * The pinned spec of a trial — the authority for what was measured.
 */
function makeSpec(suiteId: string) {
  return generateEvaluationSpec({
    trialId: TRIAL,
    suiteId,
    agentId: AGENT,
    executionEnvironment: {
      runtimeImage: "crucible/agent@sha256:image-digest-1",
      cpuLimit: 1,
      memoryLimitMb: 512,
      timeLimitSeconds: 60,
      networkEgress: false,
    },
    scoringMethodology: {
      dimensions: [
        { name: "CORRECTNESS", weight: 0.7 },
        { name: "SAFETY", weight: 0.3 },
      ],
    },
  });
}

function makeManifest(specDigest = "sha256:suite-digest-1"): ReplayManifest {
  return createReplayManifest({
    trialId: TRIAL,
    runId: RUN,
    specDigest,
    suiteVersion: "1.0.0",
    agentId: AGENT,
    agentVersion: "0.1.0",
    modelId: "model-x",
    runtimeImageDigest: "sha256:image-digest-1",
    executionConfig: { timeoutMs: 1000 },
    judgeVersion: "judge-1",
    environmentFingerprint: "env-1",
    artifactHashes: { "artifact-1": "sha256:artifact-digest-1" },
    startTimestamp: 1,
    workerIdentity: "worker-1",
  });
}

function makeRubric() {
  return createRubric({
    id: "rubric_publication_1",
    name: "Publication Rubric",
    description: "The rubric",
    dimensions: [
      { dimension: "CORRECTNESS", weight: 0.7, methodology: "the acceptance tests" },
      { dimension: "SAFETY", weight: 0.3, methodology: "the safety cases" },
    ],
    createdBy: "author",
  });
}

describe("publication", () => {
  beforeEach(() => {
    resetAll();
  });

  describe("assembling the card", () => {
    it("carries the suite version by digest, the rubric with its weights, and the judge", () => {
      const { suite, version } = makeSuite();
      const rubric = makeRubric();
      const spec = makeSpec(suite.id);
      const manifest = makeManifest(spec.specDigest);
      createDimensionScore({
        runId: RUN,
        rubricId: rubric.id,
        dimension: "CORRECTNESS",
        score: 0.9,
        methodology: "the acceptance tests",
        confidenceLower: 0.8,
        confidenceUpper: 1,
        sampleCount: 3,
      });
      createAggregateScore(RUN, rubric.id, "weighted");

      const card = publishForManifest(manifest, 1_700_000_000_000);
      expect(card).not.toBeNull();
      const published = card as PublishedMethod;

      expect(published.suite?.suiteId).toBe(suite.id);
      expect(published.suite?.versionId).toBe(version.id);
      // The digest is the SUITE VERSION's own digest — the thing measured.
      expect(published.suite?.specDigest).toBe(version.specDigest);
      expect(published.suite?.specDigest.length).toBeGreaterThan(0);
      expect(published.rubric.rubricId).toBe(rubric.id);
      expect(published.rubric.dimensions.length).toBe(2);
      expect(published.rubric.dimensions[0]?.weightBps).toBe(7000);
      expect(published.rubric.dimensions[0]?.methodology).toBe("the acceptance tests");
      expect(published.judge.judgeVersion).toBe("judge-1");
      expect(published.judge.runtimeImageDigest).toBe("sha256:image-digest-1");
    });

    it("is content-addressed, and cannot be edited afterwards", () => {
      const makeSuite2 = makeSuite;
      makeSuite2();
      const manifest = makeManifest();
      const first = publishForManifest(manifest, 1);
      const second = publishForManifest(manifest, 2);
      expect(first?.digest).toBe(second?.digest);
      // The publication time is not part of the method, so the same method
      // published twice has the same address.
      expect(first?.id).toBe(second?.id);

      // Any change to the method changes the address: that is what makes a
      // published method immutable without a lock.
      const changed = assemblePublication({
        manifest: { ...manifest, judgeVersion: "judge-2" },
        replays: [],
        aggregate: undefined,
        dimensionScores: [],
        rubric: undefined,
        suiteVersion: undefined,
        suite: undefined,
        publishedAt: 1,
      });
      expect(changed.digest).not.toBe(first?.digest);
    });

    it("can be CHECKED: a reader can recompute the digest and a tampered card fails", () => {
      const { suite } = makeSuite();
      const spec = makeSpec(suite.id);
      const card = publishForManifest(makeManifest(spec.specDigest), 1) as PublishedMethod;
      expect(verifyPublicationDigest(card)).toBe(true);

      // A limit removed after the fact — the address no longer matches.
      expect(verifyPublicationDigest({ ...card, limits: card.limits.slice(1) })).toBe(false);

      // A score invented after the fact.
      expect(
        verifyPublicationDigest({
          ...card,
          rubric: { ...card.rubric, aggregateBps: 10000 },
        }),
      ).toBe(false);
    });

    it("publishes nothing when there is no method to publish", () => {
      const card = assemblePublication({
        manifest: {
          trialId: TRIAL,
          runId: RUN,
          specDigest: "sha256:x",
          suiteVersion: "1.0.0",
          agentId: AGENT,
          runtimeImageDigest: "sha256:y",
          executionConfig: {},
          judgeVersion: "judge-1",
          environmentFingerprint: "env",
          artifactHashes: {},
          startTimestamp: 1,
          workerIdentity: "w",
          manifestId: "manifest_x",
          status: "PENDING",
          reproducibilityState: "PENDING",
          createdAt: 1,
        },
        replays: [],
        aggregate: undefined,
        dimensionScores: [],
        rubric: undefined,
        suiteVersion: undefined,
        suite: undefined,
        publishedAt: 1,
      });
      // The card exists — it says what is missing rather than pretending.
      expect(card.suite).toBeNull();
      expect(card.limits.some((l) => l.includes("not published"))).toBe(true);
    });
  });

  describe("the limits", () => {
    it("derives them from the data, and every one is about what is NOT established", () => {
      const { suite, version } = makeSuite({ knownLimitations: "does not test concurrency" });
      const rubric = makeRubric();
      const spec = makeSpec(suite.id);
      const manifest = makeManifest(spec.specDigest);
      createReplayRecord(manifest.manifestId, 1, "worker-1");

      const card = publishForManifest(manifest, 1);
      expect(card).not.toBeNull();

      const limits = (card as PublishedMethod).limits;
      expect(limits.length).toBeGreaterThan(0);
      // The suite's own limitations are carried, in its own words.
      expect(limits.some((l) => l.includes("does not test concurrency"))).toBe(true);
      // The repetition count is short, and the card says so.
      expect(limits.some((l) => l.includes("agreement rule was not met"))).toBe(true);
      // And the card never claims more than it measured.
      expect(limits.some((l) => l.includes("does not establish general capability"))).toBe(true);
      void suite;
      void version;
      void rubric;
    });

    it("says a score is not reproducible when the repetitions disagreed", () => {
      const { suite } = makeSuite();
      const spec = makeSpec(suite.id);
      const manifest = makeManifest(spec.specDigest);
      const one = createReplayRecord(manifest.manifestId, 1, "worker-1");
      const two = createReplayRecord(manifest.manifestId, 2, "worker-2");
      completeReplay(one.replayId, "sha256:output-a");
      completeReplay(two.replayId, "sha256:output-b");

      const card = publishForManifest(manifest, 1) as PublishedMethod;
      expect(card.repetitions.performed).toBe(2);
      expect(card.repetitions.agreed).toBe(false);
      expect(card.limits.some((l) => l.includes("did not agree"))).toBe(true);
    });

    it("says a score is not reproducible when the repetitions are missing", () => {
      const card = deriveLimits({
        suite: null,
        rubric: { rubricId: "r", name: "r", status: "ACTIVE", dimensions: [], aggregateBps: null, confidenceLowerBps: null, confidenceUpperBps: null, sampleCount: 0, scoreStatus: null },
        judge: { judgeVersion: null, runtimeImageDigest: null, environmentFingerprint: null, configDigest: null, modelId: null },
        repetitions: { required: 3, performed: 0, agreed: null, agreementRule: "three replays must agree", replays: [] },
        scoreStatus: null,
      });
      expect(card.some((l) => l.includes("agreement rule was not met"))).toBe(true);
      expect(card.some((l) => l.includes("not published"))).toBe(true);
      expect(card.some((l) => l.includes("No judge version"))).toBe(true);
    });

    it("warns about a dimension with no published methodology", () => {
      const card = deriveLimits({
        suite: null,
        rubric: {
          rubricId: "r",
          name: "r",
          status: "ACTIVE",
          dimensions: [{ dimension: "SAFETY", weightBps: 2000, methodology: "", scoreBps: null }],
          aggregateBps: null,
          confidenceLowerBps: null,
          confidenceUpperBps: null,
          sampleCount: 0,
          scoreStatus: null,
        },
        judge: { judgeVersion: "j", runtimeImageDigest: "i", environmentFingerprint: "e", configDigest: null, modelId: null },
        repetitions: { required: 3, performed: 3, agreed: true, agreementRule: "rule", replays: [] },
        scoreStatus: null,
      });
      expect(card.some((l) => l.includes("SAFETY"))).toBe(true);
      expect(card.some((l) => l.includes("20%"))).toBe(true);
    });
  });

  describe("comparing two published scores", () => {
    function cardWith(overrides: Partial<PublishedMethod>): PublishedMethod {
      return {
        id: "pub_x",
        subject: { kind: "trial", id: TRIAL, agentId: AGENT },
        specDigest: "sha256:spec-digest-1",
        measurementKey: "sha256:measurement-key-1",
        measurementKeySource: "spec",
        suite: {
          suiteId: "s",
          name: "S",
          versionId: "v",
          version: "1.0.0",
          specDigest: "sha256:suite-digest-1",
          difficulty: "medium",
          evaluationProtocol: "deterministic",
          knownLimitations: "",
        },
        rubric: {
          rubricId: "rubric_1",
          name: "R",
          status: "ACTIVE",
          dimensions: [],
          aggregateBps: 8200,
          confidenceLowerBps: 7000,
          confidenceUpperBps: 9000,
          sampleCount: 3,
          scoreStatus: "VERIFIED",
        },
        judge: { judgeVersion: "judge-1", runtimeImageDigest: "i", environmentFingerprint: "e", configDigest: null, modelId: null },
        repetitions: { required: 3, performed: 3, agreed: true, agreementRule: "rule", replays: [] },
        limits: [],
        comparabilityKey: "sha256:suite-digest-1/rubric_1/judge-1",
        digest: "digest",
        publishedAt: 1,
        ...overrides,
      };
    }

    it("refuses to compare two scores measured against different things", () => {
      const a = cardWith({});
      const b = cardWith({
        measurementKey: "sha256:measurement-key-2",
        suite: { ...a.suite!, specDigest: "sha256:suite-digest-2" },
      });
      const verdict = comparePublications(a, b);
      expect(verdict.comparable).toBe(false);
      expect(verdict.reason).toContain("different measurements");
      expect(verdict.differences.length).toBeGreaterThan(0);
    });

    it("compares two scores of DIFFERENT SUBJECTS measured the same way", () => {
      // Two agents, one suite, one rubric, one judge: this is the comparison
      // the product exists to make, and a key that included the subject
      // would refuse it.
      const a = cardWith({ id: "pub_a" });
      const b = cardWith({ id: "pub_b", subject: { kind: "trial", id: "trial_other", agentId: "agent_other" } });
      expect(comparePublications(a, b).comparable).toBe(true);
    });

    it("refuses to compare two scores measured with different rubrics", () => {
      const a = cardWith({});
      const b = cardWith({ rubric: { ...a.rubric, rubricId: "rubric_2" } });
      const verdict = comparePublications(a, b);
      expect(verdict.comparable).toBe(false);
      expect(verdict.reason).toContain("different rubrics");
    });

    it("refuses to compare two scores measured by different judges", () => {
      const a = cardWith({});
      const b = cardWith({ judge: { ...a.judge, judgeVersion: "judge-2" } });
      const verdict = comparePublications(a, b);
      expect(verdict.comparable).toBe(false);
      expect(verdict.reason).toContain("different judge versions");
    });

    it("refuses to compare a revoked score with anything", () => {
      const a = cardWith({});
      const b = cardWith({ rubric: { ...a.rubric, scoreStatus: "REVOKED" } });
      const verdict = comparePublications(a, b);
      expect(verdict.comparable).toBe(false);
      expect(verdict.reason).toContain("revoked");
    });

    it("compares two scores measured the same way", () => {
      const a = cardWith({ id: "pub_a" });
      const b = cardWith({ id: "pub_b" });
      const verdict = comparePublications(a, b);
      expect(verdict.comparable).toBe(true);
      expect(verdict.differences).toEqual([]);
    });

    it("does not compare on how close the numbers are", () => {
      // Two scores that are miles apart but measured the same way ARE
      // comparable — that is the whole point of a comparison surface. And two
      // identical numbers measured differently are NOT.
      const a = cardWith({ rubric: { ...cardWith({}).rubric, aggregateBps: 100 } });
      const b = cardWith({ rubric: { ...a.rubric, aggregateBps: 9900 } });
      expect(comparePublications(a, b).comparable).toBe(true);

      const c = cardWith({ measurementKey: "sha256:other", suite: { ...a.suite!, specDigest: "sha256:other" } });
      const d = cardWith({ measurementKey: "sha256:other", suite: { ...a.suite!, specDigest: "sha256:other" } });
      expect(comparePublications(c, d).comparable).toBe(true);
    });
  });

  describe("the score itself", () => {
    it("carries the aggregate and its uncertainty in basis points", () => {
      const { suite } = makeSuite();
      const rubric = makeRubric();
      const spec = makeSpec(suite.id);
      const manifest = makeManifest(spec.specDigest);
      createDimensionScore({
        runId: RUN,
        rubricId: rubric.id,
        dimension: "CORRECTNESS",
        score: 0.82,
        methodology: "the acceptance tests",
        confidenceLower: 0.7,
        confidenceUpper: 0.9,
        sampleCount: 3,
      });
      createAggregateScore(RUN, rubric.id, "weighted");

      const card = publishForManifest(manifest, 1) as PublishedMethod;
      expect(card.rubric.aggregateBps).toBe(8200);
      expect(card.rubric.confidenceLowerBps).toBe(7000);
      expect(card.rubric.confidenceUpperBps).toBe(9000);
      expect(card.rubric.sampleCount).toBe(3);
      expect(card.rubric.dimensions.find((d) => d.dimension === "CORRECTNESS")?.scoreBps).toBe(8200);
      void suite;
    });
  });
});
