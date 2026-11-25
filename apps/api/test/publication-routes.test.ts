/**
 * @file publication-routes.test.ts — publishing a method card, end to end.
 *
 * The rule under test at the route level:
 *
 *   - a caller may NOT bring its own score, verdict, limits or digest; a
 *     publication states what the PLATFORM measured;
 *   - publishing with nothing to publish is refused, with a reason;
 *   - the read side returns exactly what was published;
 *   - comparing two cards produces an explicit verdict, and "not comparable"
 *     is a verdict, not an error.
 *
 * The store is the in-memory one: the durable path has its own test file
 * (publication-pg.test.ts) against a real PostgreSQL.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createPublicationRoutes } from "../src/publication-routes.js";
import { resetPublicationStore } from "../src/publication-store.js";
import {
  createReplayManifest,
  createReplayRecord,
  completeReplay,
  resetReplayStore,
} from "../src/replay-manifest.js";
import { createRubric, createDimensionScore, createAggregateScore, resetScoringStore } from "../src/scoring.js";
import { createSuite, createSuiteVersion, resetSuiteStore } from "../src/suites.js";
import { generateEvaluationSpec, resetSpecStore } from "../src/evaluation-spec.js";

const TRIAL = "trial_pub_route_1";
const RUN = "run_pub_route_1";
const AGENT = "agent_pub_route_1";

const app = createPublicationRoutes();

async function seed(digestSuffix = "1"): Promise<{
  manifestId: string;
  rubricId: string;
}> {
  await resetReplayStore();
  resetScoringStore();
  resetSuiteStore();
  resetSpecStore();

  const suite = createSuite({
    id: "suite_pub_route_1",
    orgId: null,
    name: "Route Suite",
    slug: `route-suite-${digestSuffix}`,
    description: "d",
    maintainer: "m",
    visibility: "public",
  });
  createSuiteVersion(
    {
      id: "sv_pub_route_1",
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
    `sha256:suite-digest-${digestSuffix}`,
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
    scoringMethodology: {
      dimensions: [
        { name: "CORRECTNESS", weight: 0.7 },
        { name: "SAFETY", weight: 0.3 },
      ],
    },
  });

  const rubric = createRubric({
    id: "rubric_pub_route_1",
    name: "Route Rubric",
    description: "d",
    dimensions: [
      { dimension: "CORRECTNESS", weight: 0.7, methodology: "the acceptance tests" },
      { dimension: "SAFETY", weight: 0.3, methodology: "the safety cases" },
    ],
    createdBy: "author",
  });
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

  const manifest = await createReplayManifest({
    trialId: TRIAL,
    runId: RUN,
    specDigest: spec.specDigest,
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

  for (let n = 1; n <= 3; n++) {
    const replay = await createReplayRecord(manifest.manifestId, n, `worker-${n}`);
    await completeReplay(replay.replayId, "sha256:same-output");
  }

  return { manifestId: manifest.manifestId, rubricId: rubric.id };
}

describe("publication routes", () => {
  beforeEach(() => {
    resetPublicationStore();
  });

  it("publishes the method of a trial", async () => {
    await seed();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trialId: TRIAL }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      publication: {
        id: string;
        suite: { specDigest: string; knownLimitations: string };
        rubric: { rubricId: string; aggregateBps: number };
        judge: { judgeVersion: string };
        repetitions: { performed: number; agreed: boolean };
        limits: string[];
      };
      store: string;
    };
    expect(body.publication.suite.specDigest).toBe("sha256:suite-digest-1");
    expect(body.publication.rubric.aggregateBps).toBe(9000);
    expect(body.publication.judge.judgeVersion).toBe("judge-1");
    expect(body.publication.repetitions.performed).toBe(3);
    expect(body.publication.repetitions.agreed).toBe(true);
    expect(body.publication.limits.length).toBeGreaterThan(0);
    expect(body.store).toBe("memory");
  });

  it("refuses a caller who brings its own score", async () => {
    await seed();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trialId: TRIAL, score: 0.99 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("caller-supplied-verdict-refused");
  });

  it("refuses a caller who brings its own verdict or limits", async () => {
    await seed();
    for (const field of ["verdict", "limits", "digest", "publishedAt"]) {
      const res = await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trialId: TRIAL, [field]: "anything" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain(field);
    }
  });

  it("refuses to publish a trial with no manifest, and says why", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trialId: "trial_that_never_ran" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("no-manifest");
  });

  it("reads back exactly what was published", async () => {
    await seed();
    const publish = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trialId: TRIAL }),
    });
    const published = ((await publish.json()) as { publication: { id: string } }).publication;

    const res = await app.request(`/${published.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { publication: { id: string; limits: string[] } };
    expect(body.publication.id).toBe(published.id);
    expect(body.publication.limits.length).toBeGreaterThan(0);
  });

  it("publishes the same method twice as the same card", async () => {
    await seed();
    const first = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trialId: TRIAL }),
    });
    const second = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trialId: TRIAL }),
    });
    const a = ((await first.json()) as { publication: { id: string } }).publication;
    const b = ((await second.json()) as { publication: { id: string } }).publication;
    expect(a.id).toBe(b.id);
  });

  it("lists the published cards of a subject", async () => {
    await seed();
    await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trialId: TRIAL }),
    });
    const res = await app.request(`/?subjectId=${TRIAL}`);
    const body = (await res.json()) as { publications: { subject: { id: string } }[] };
    expect(body.publications.length).toBe(1);
    expect(body.publications[0]?.subject.id).toBe(TRIAL);
  });

  it("compares two cards and says they are comparable when they were measured the same way", async () => {
    await seed();
    const publish = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trialId: TRIAL }),
    });
    const id = ((await publish.json()) as { publication: { id: string } }).publication.id;

    const res = await app.request(`/compare?a=${id}&b=${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      comparison: { comparable: boolean; reason: string; recordedAt: number };
    };
    expect(body.comparison.comparable).toBe(true);
    expect(body.comparison.reason).toContain("measured the same way");
  });

  it("refuses a comparison against a publication that does not exist", async () => {
    const res = await app.request("/compare?a=pub_missing&b=pub_missing");
    expect(res.status).toBe(404);
  });
});
