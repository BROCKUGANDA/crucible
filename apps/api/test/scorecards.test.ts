import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CidStore } from "@crucible/cidstore";
import {
  buildEvalManifest,
  digestOfContent,
  manifestDigest,
  scorecardPublicationId,
  scorecardTypedData,
  type ScorecardPublication,
} from "@crucible/smith";
import { privateKeyToAccount } from "viem/accounts";
import type { ReadModel } from "@crucible/indexer";
import { createApp } from "../src/app.js";
import { createContentSource } from "../src/content.js";
import { createScorecardPublicationSource } from "../src/scorecard-publications.js";
import { writeScorecardPublication } from "../../../grader/src/eval/publication-store.js";

const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`);
const chainId = 31337;
const agentId = 7;
const runner = "0x0000000000000000000000000000000000000007" as const;
const suiteEpoch = `0x${"aa".repeat(32)}` as const;
const directories: string[] = [];

interface FixtureOptions {
  alterManifest?: boolean;
  manifestModelName?: string;
  publicationChainId?: number;
  runnerOnChain?: string;
  missingAgent?: boolean;
  authorizedSigner?: string;
  corpusDigest?: string;
  corpusArtifacts?: number;
  evidenceDigest?: string;
  trajectoryPayload?: unknown;
  omitTrajectoryFailure?: boolean;
  duplicate?: boolean;
  invalidSignature?: boolean;
  scorecardDigest?: string;
  subjectCohort?: string;
  unconfigured?: boolean;
}

async function fixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "crucible-scorecard-api-"));
  directories.push(root);
  const contentDir = join(root, "content");
  const publicationsDir = join(contentDir, "scorecards");
  mkdirSync(publicationsDir, { recursive: true });
  const store = new CidStore({
    dir: join(contentDir, "scorecards", "store"),
    maxBytes: Number.MAX_SAFE_INTEGER,
    maxEntries: Number.MAX_SAFE_INTEGER,
    maxEntryBytes: Number.MAX_SAFE_INTEGER,
  });
  const payload = { claim: "probe-one", evidence: "the exact fixture bytes" };
  const corpus = [{ claimHash: "claim-one", payload }];
  const corpusText = JSON.stringify(corpus);
  const corpusRef = {
    cid: store.put(corpusText),
    digest: options.corpusDigest ?? digestOfContent(corpusText),
  };
  const evidenceText = JSON.stringify(payload);
  const evidenceRef = {
    cid: store.put(evidenceText),
    digest: options.evidenceDigest ?? digestOfContent(evidenceText),
  };
  const manifest = buildEvalManifest({
    taskDigest: suiteEpoch,
    suiteDigest: suiteEpoch,
    evaluator: { id: "grader", version: "1.0.0" },
    model: { provider: "fixture-provider", name: "model-a", version: "2026-01-01" },
    environment: { imageDigest: suiteEpoch, networkPolicy: "none" },
    seed: "fixture-seed",
    scoring: { feeSchedule: "none", feeScheduleVersion: "0", decision: "deterministic-suite" },
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
  });
  const rowManifest = options.alterManifest
    ? { ...manifest, seed: "altered-seed" }
    : options.manifestModelName
      ? { ...manifest, model: { ...manifest.model, name: options.manifestModelName } }
      : manifest;
  const publicationChainId = options.publicationChainId ?? chainId;
  const record = {
    kind: "crucible/arena-scorecard",
    version: 1,
    generatedAt: 1_800_000_000_000,
    publication: {
      cohort: options.subjectCohort ?? "pilot-2026",
      chainId: publicationChainId,
      agentId,
      runner,
      issuedAt: 1_800_000_001,
      signer: signer.address,
    },
    corpus: { suite: "smoke", artifacts: options.corpusArtifacts ?? corpus.length },
    corpusEvidence: corpusRef,
    trajectories: [{
      modelId: "model-a",
      suite: "smoke",
      claimHash: "claim-one",
      expected: "PASS",
      actual: "FAIL",
      kind: "abstention-conflict",
      confidence: 0.3,
      payload: options.trajectoryPayload ?? payload,
      evidence: evidenceRef,
    }],
    rows: [{
      modelId: "model-a",
      suite: "smoke",
      suiteEpoch,
      manifest: rowManifest,
      manifestDigest: options.alterManifest ? manifestDigest(manifest) : manifestDigest(rowManifest),
      accuracy: 0.5,
      falsePassRate: 0,
      disqualified: false,
      abstention: { failures: options.omitTrajectoryFailure ? [] : [{ claimHash: "claim-one" }] },
    }],
  };
  const scorecardText = JSON.stringify(record);
  const scorecardCid = store.put(scorecardText);
  const message = {
    cohort: "pilot-2026",
    chainId: publicationChainId,
    agentId,
    runner,
    scorecardCid,
    scorecardDigest: options.scorecardDigest ?? digestOfContent(scorecardText),
    issuedAt: 1_800_000_001,
  };
  const signature = await signer.signTypedData(scorecardTypedData(message));
  const publication: ScorecardPublication = {
    schemaVersion: 1,
    id: scorecardPublicationId(message),
    signer: signer.address,
    message,
    signature: options.invalidSignature ? `0x${"33".repeat(65)}` as `0x${string}` : signature,
  };
  writeScorecardPublication(publicationsDir, publication);
  const source = createScorecardPublicationSource(publicationsDir);
  const stored = source()[0]!;
  const model = {
    trials: new Map(),
    agents: options.missingAgent
      ? new Map()
      : new Map([[agentId, { id: agentId, runner: options.runnerOnChain ?? runner }]]),
    runs: new Map(),
    disputes: new Map(),
    appliedLogs: new Set(),
    version: 0,
  } as unknown as ReadModel;
  const app = createApp({
    getModel: () => model,
    scorecardContentLookup: createContentSource(join(contentDir, "scorecards"), () => new Map()),
    proofSource: { chain: "foundry", chainId, trialsAddress: "0x0000000000000000000000000000000000000001" },
    scorecardPublications: () => options.duplicate ? [stored, stored] : source(),
    scorecardSigners: options.unconfigured ? [] : [options.authorizedSigner ?? signer.address],
  }, { rateLimit: false });
  return { app, publication, publicationsDir };
}

afterEach(() => {
  while (directories.length) {
    const root = directories.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("public scorecard verification", () => {
  it("serves a signed cohort result only after checking identity, manifests and pinned evidence", async () => {
    const { app, publication } = await fixture();

    const response = await app.request("/scorecards?cohort=pilot-2026&agentId=7");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.count).toBe(1);
    expect(body.cohorts).toEqual(["pilot-2026"]);
    expect(body.publications[0].id).toBe(publication.id);
    expect(body.publications[0].scorecard.rows[0].manifestDigest).toBeTruthy();
    const emptyCohort = await app.request("/scorecards?cohort=other");
    expect((await emptyCohort.json()).count).toBe(0);
    expect((await app.request("/scorecards?cohort=bad%20cohort")).status).toBe(400);
    const artifact = await app.request(`/scorecards/content/${publication.message.scorecardCid}`);
    expect(artifact.status).toBe(200);
    expect(await artifact.text()).toContain("crucible/arena-scorecard");
  });

  it("refuses a signed scorecard whose manifest no longer matches its digest", async () => {
    const { app } = await fixture({ alterManifest: true });
    const response = await app.request("/scorecards");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ reason: expect.stringMatching(/manifest digest mismatch/) });
  });

  it("requires the signed chain identity to match the API host", async () => {
    const { app } = await fixture({ publicationChainId: 31314 });
    const response = await app.request("/scorecards");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ reason: "publication chain does not match this API host" });
  });

  it("checks the manifest model identity even when its digest is valid", async () => {
    const { app } = await fixture({ manifestModelName: "model-b" });
    const response = await app.request("/scorecards");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ reason: expect.stringMatching(/manifest identity mismatch/) });
  });

  it("binds the publication to the currently registered runner for its agent id", async () => {
    const { app } = await fixture({ runnerOnChain: "0x0000000000000000000000000000000000000008" });
    const response = await app.request("/scorecards");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ reason: expect.stringMatching(/registered agent identity/) });
  });

  it("refuses an agent id that is not registered on the indexed chain", async () => {
    const { app } = await fixture({ missingAgent: true });
    const response = await app.request("/scorecards");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ reason: expect.stringMatching(/registered agent identity/) });
  });

  it("rejects a valid signature from an attestor outside the configured allowlist", async () => {
    const { app } = await fixture({ authorizedSigner: stranger.address });
    const response = await app.request("/scorecards");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ reason: expect.stringMatching(/not authorized/) });
  });

  it("rejects a malformed signature and an unconfigured signer source", async () => {
    const invalid = await fixture({ invalidSignature: true });
    const signatureResponse = await invalid.app.request("/scorecards");
    expect(signatureResponse.status).toBe(500);
    expect(await signatureResponse.json()).toMatchObject({ reason: expect.stringMatching(/signature is invalid/) });

    const unconfigured = await fixture({ unconfigured: true });
    expect((await unconfigured.app.request("/scorecards")).status).toBe(503);
  });

  it("rejects a signed digest that does not name the stored scorecard bytes", async () => {
    const { app } = await fixture({ scorecardDigest: `0x${"fe".repeat(32)}` });
    const response = await app.request("/scorecards");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ reason: expect.stringMatching(/scorecard digest does not match/) });
  });

  it("requires the artifact's recorded cohort to equal its signed cohort", async () => {
    const { app } = await fixture({ subjectCohort: "other-cohort" });
    const response = await app.request("/scorecards");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ reason: expect.stringMatching(/subject does not match/) });
  });

  it("verifies the corpus evidence digest", async () => {
    const badDigest = await fixture({ corpusDigest: `0x${"ab".repeat(32)}` });
    const digestResponse = await badDigest.app.request("/scorecards");
    expect(digestResponse.status).toBe(500);
    expect(await digestResponse.json()).toMatchObject({ reason: expect.stringMatching(/corpus evidence digest mismatch/) });
  });

  it("verifies the corpus artifact count", async () => {
    const badCount = await fixture({ corpusArtifacts: 2 });
    const countResponse = await badCount.app.request("/scorecards");
    expect(countResponse.status).toBe(500);
    expect(await countResponse.json()).toMatchObject({ reason: expect.stringMatching(/corpus count does not match/) });
  });

  it("refuses trajectory evidence whose digest does not match the pinned bytes", async () => {
    const { app } = await fixture({ evidenceDigest: `0x${"ff".repeat(32)}` });
    const response = await app.request("/scorecards");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ reason: expect.stringMatching(/trajectory evidence digest mismatch/) });
  });

  it("links trajectory payloads back to the corpus evidence", async () => {
    const changedPayload = await fixture({ trajectoryPayload: { claim: "different" } });
    const payloadResponse = await changedPayload.app.request("/scorecards");
    expect(payloadResponse.status).toBe(500);
    expect(await payloadResponse.json()).toMatchObject({ reason: expect.stringMatching(/payload does not match corpus evidence/) });
  });

  it("requires a trajectory to be named by its scorecard row", async () => {
    const unlinkedFailure = await fixture({ omitTrajectoryFailure: true });
    const failureResponse = await unlinkedFailure.app.request("/scorecards");
    expect(failureResponse.status).toBe(500);
    expect(await failureResponse.json()).toMatchObject({ reason: expect.stringMatching(/not named by its scorecard row/) });
  });

  it("rejects duplicate replay records and supports direct retrieval by publication id", async () => {
    const duplicate = await fixture({ duplicate: true });
    const replay = await duplicate.app.request("/scorecards");
    expect(replay.status).toBe(500);
    expect(await replay.json()).toMatchObject({ reason: expect.stringMatching(/replay appears more than once/) });

    const valid = await fixture();
    const direct = await valid.app.request(`/scorecards/${valid.publication.id}`);
    expect(direct.status).toBe(200);
    expect((await direct.json()).message.cohort).toBe("pilot-2026");
  });
});
