/**
 * @file studio-routes.test.ts — the Studio's route, end to end.
 *
 * The rule under test at the route level:
 *
 *   - three replays or the request is refused;
 *   - a caller may NOT bring its own verdict, score or status;
 *   - three replays that agree on real evidence are REPRODUCIBLE;
 *   - three replays that agree on the ABSENCE of evidence are INCONCLUSIVE.
 *
 * The last one is the case a lazy implementation gets wrong, and it is the
 * one this file exists for.
 */

process.env.AUTH_ALLOW_DEV_SECRET = "1";
process.env.AUTH_ORIGIN = "http://localhost:3000";

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { createStudioRoutes } from "../src/studio-routes.js";

const DEV_SECRET = "crucible-local-dev-secret-not-for-production";
const CALLER = "0x" + "44".repeat(20);

function headers(): Headers {
  const now = Date.now();
  const payload = {
    address: CALLER,
    issuedAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000) + 3600,
    aud: "http://localhost:3000",
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", DEV_SECRET).update(encoded).digest("base64url");
  return new Headers({
    cookie: `__Host-crucible_session=${encoded}.${sig}`,
    "content-type": "application/json",
  });
}

const app = createStudioRoutes();

function post(body: unknown) {
  return app.request("/reproducibility", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
}

const evidence = (id: string, passed = true) => [
  { id, passed, detail: `check ${id}`, artifactDigest: `sha256:${id}` },
];

/**
 * A task that passes the real validator.
 *
 * The engineering profile requires a pinned repository digest, a baseline
 * command and four named checks, and it refuses a placeholder digest. That
 * refusal is the point — a study of reproducibility needs a pinned task, or
 * the three replays are three different tasks.
 */
const DIGEST = `sha256:${"ab".repeat(32)}`;
const TASK = {
  slug: "studio-check",
  version: "1.0.0",
  repositorySnapshot: DIGEST,
  baseCommit: "0".repeat(40),
  baselineCommand: ["npm", "test"],
  expectedExitCode: 0,
  checks: [
    { id: "baseline_reproduction", command: "npm test" },
    { id: "public_regression", command: "npm test" },
    { id: "hidden_regression", command: "npm test" },
    { id: "forbidden_diff", command: "git diff --name-only" },
  ],
  allowedPaths: ["src/**"],
  forbiddenPaths: ["tests/**"],
  mode: "regression_repair",
};

describe("POST /studio/reproducibility", () => {
  it("refuses a request with no credential", async () => {
    const res = await app.request("/reproducibility", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ replays: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses anything but three replays", async () => {
    const res = await post({ replays: [{ evidence: evidence("a") }, { evidence: evidence("a") }] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("exactly 3");
  });

  it("refuses a caller-supplied verdict", async () => {
    const res = await post({
      verdict: "REPRODUCIBLE",
      replays: [1, 2, 3].map(() => ({ evidence: evidence("a") })),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("stamp_client_verdict_refused");
  });

  it("refuses an unknown profile", async () => {
    const res = await post({
      profile: "NOT_A_PROFILE",
      replays: [1, 2, 3].map(() => ({ evidence: evidence("a") })),
    });
    expect(res.status).toBe(400);
  });

  it("refuses a task the verifier would refuse, instead of reporting it as a finding", async () => {
    const res = await post({
      profile: "SOFTWARE_ENGINEERING",
      task: { slug: "no-digest" },
      replays: [1, 2, 3].map(() => ({ evidence: evidence("a") })),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not a valid pinned task");
    expect(Array.isArray(body.details)).toBe(true);
  });

  it("says REPRODUCIBLE when three replays produce the same evidence", async () => {
    const res = await post({
      profile: "SOFTWARE_ENGINEERING",
      task: TASK,
      replays: [1, 2, 3].map(() => ({ label: "worker", evidence: evidence("acceptance") })),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdict).toBe("REPRODUCIBLE");
    expect(body.comparable).toBe(3);
    expect(body.distinctFingerprints).toBe(1);
    expect(body.replays).toHaveLength(3);
  });

  it("says INCONCLUSIVE when the replays produced no evidence at all", async () => {
    const res = await post({
      profile: "SOFTWARE_ENGINEERING",
      task: TASK,
      replays: [1, 2, 3].map(() => ({ label: "worker", evidence: [] })),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdict).toBe("INCONCLUSIVE");
    expect(body.comparable).toBe(0);
    expect(body.explanation).toContain("no evidence");
  });

  it("says NOT_REPRODUCIBLE when the replays disagree", async () => {
    const res = await post({
      profile: "SOFTWARE_ENGINEERING",
      task: TASK,
      replays: [
        { label: "worker-a", evidence: evidence("acceptance", true) },
        { label: "worker-b", evidence: evidence("acceptance", true) },
        { label: "worker-c", evidence: evidence("acceptance", false) },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdict).toBe("NOT_REPRODUCIBLE");
    expect(body.distinctFingerprints).toBe(2);
  });

  it("counts a replay with no evidence as incomparable rather than agreeing", async () => {
    const res = await post({
      profile: "SOFTWARE_ENGINEERING",
      task: TASK,
      replays: [
        { label: "worker-a", evidence: evidence("acceptance", true) },
        { label: "worker-b", evidence: evidence("acceptance", true) },
        { label: "worker-c", evidence: [] },
      ],
    });
    const body = await res.json();
    expect(body.verdict).toBe("INCONCLUSIVE");
    expect(body.comparable).toBe(2);
    expect(body.replays[2].comparable).toBe(false);
    expect(body.replays[2].reason).toContain("no evidence");
  });
});
