/**
 * @file evidence-bundle-routes.test.ts — freezing a dispute's evidence.
 *
 * The rules under test at the route level:
 *
 *   - a caller may NOT bring its own evidence, gaps or digest;
 *   - sealing produces an immutable, content-addressed bundle;
 *   - the route says whether the bundle predates the dispute — the question
 *     that decides whether it is the evidence the parties saw;
 *   - the read side returns exactly what was sealed.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { createEvidenceBundleRoutes } from "../src/evidence-bundle-routes.js";
import { resetEvidenceBundleStore, evidenceBundleStoreKind } from "../src/evidence-bundle-store.js";
import {
  createReplayManifest,
  createReplayRecord,
  completeReplay,
  resetReplayStore,
} from "../src/replay-manifest.js";
import { resetScoringStore } from "../src/scoring.js";
import { resetSuiteStore } from "../src/suites.js";
import { resetSpecStore } from "../src/evaluation-spec.js";

process.env.AUTH_ALLOW_DEV_SECRET = "1";
process.env.AUTH_ORIGIN = "http://localhost:3000";

const DEV_SECRET = "crucible-local-dev-secret-not-for-production";
const CALLER = "0x" + "44".repeat(20);
const TRIAL = "42";

function headers(): Headers {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    address: CALLER,
    issuedAt: now,
    expiresAt: now + 3600,
    aud: "http://localhost:3000",
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", DEV_SECRET).update(encoded).digest("base64url");
  return new Headers({
    cookie: `crucible_session=${encoded}.${sig}`,
    "content-type": "application/json",
  });
}

const app = createEvidenceBundleRoutes();

describe("the evidence bundle routes", () => {
  beforeEach(() => {
    resetEvidenceBundleStore();
    resetReplayStore();
    resetScoringStore();
    resetSuiteStore();
    resetSpecStore();
  });

  it("seals a bundle for a trial", async () => {
    const res = await app.request(`/${TRIAL}/bundle`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      bundle: { id: string; trialKey: string; gaps: string[]; digest: string };
      predatesDispute: boolean | null;
      store: string;
      sealedBy: string;
    };
    expect(body.bundle.id.startsWith("bundle_")).toBe(true);
    expect(body.bundle.trialKey).toBe(TRIAL);
    expect(body.bundle.gaps.length).toBeGreaterThan(0);
    expect(body.store).toBe("memory");
    expect(body.sealedBy).toBe(CALLER.toLowerCase());
    // The chain has not said when this trial was disputed, so the route
    // says nothing about it rather than guessing.
    expect(body.predatesDispute).toBeNull();
  });

  it("refuses a caller who brings its own evidence", async () => {
    for (const field of ["gaps", "digest", "chain", "sealedAt", "score"]) {
      const res = await app.request(`/${TRIAL}/bundle`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ [field]: "anything" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("caller-supplied-evidence-refused");
    }
  });

  it("refuses an unauthenticated seal", async () => {
    const res = await app.request(`/${TRIAL}/bundle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("refuses a trial id that is not a number", async () => {
    const res = await app.request("/not-a-trial/bundle", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("sealing the same evidence twice yields the same bundle", async () => {
    const first = await app.request(`/${TRIAL}/bundle`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({}),
    });
    const second = await app.request(`/${TRIAL}/bundle`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({}),
    });
    const a = ((await first.json()) as { bundle: { id: string } }).bundle;
    const b = ((await second.json()) as { bundle: { id: string } }).bundle;
    expect(a.id).toBe(b.id);
  });

  it("lists the bundles of a trial and reads one back", async () => {
    const sealed = await app.request(`/${TRIAL}/bundle`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({}),
    });
    const id = ((await sealed.json()) as { bundle: { id: string } }).bundle.id;

    const list = await app.request(`/${TRIAL}/bundles`);
    const listBody = (await list.json()) as {
      bundles: { id: string; gaps: number; predatesDispute: boolean | null }[];
      store: string;
    };
    expect(listBody.bundles.length).toBe(1);
    expect(listBody.bundles[0]?.id).toBe(id);
    expect(listBody.store).toBe(evidenceBundleStoreKind());

    const read = await app.request(`/bundles/${id}`);
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { bundle: { id: string; gaps: string[] } };
    expect(readBody.bundle.id).toBe(id);
    expect(readBody.bundle.gaps.length).toBeGreaterThan(0);
  });

  it("answers 404 for a bundle that does not exist", async () => {
    const res = await app.request("/bundles/bundle_nothing_here");
    expect(res.status).toBe(404);
  });

  it("carries the measurement when one was recorded", async () => {
    const manifest = createReplayManifest({
      trialId: TRIAL,
      runId: "run_route_1",
      specDigest: "sha256:spec-route",
      suiteVersion: "1.0.0",
      agentId: "agent_route_1",
      runtimeImageDigest: "sha256:image-route",
      executionConfig: {},
      judgeVersion: "judge-1",
      environmentFingerprint: "env-1",
      artifactHashes: {},
      workerIdentity: "worker-1",
    });
    const replay = createReplayRecord(manifest.manifestId, 1, "w1");
    completeReplay(replay.replayId, "sha256:output");

    const res = await app.request(`/${TRIAL}/bundle`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as {
      bundle: { measurement: { replays: unknown[]; replaysAgreed: boolean | null } };
    };
    expect(body.bundle.measurement.replays.length).toBe(1);
    expect(body.bundle.measurement.replaysAgreed).toBe(true);
  });
});
