import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { canTransition, ENGINEERING_REQUIREMENTS, type RunState } from "@crucible/eval";
import { __resetRunsForTests, createWorkloadRoutes } from "../src/workloads.js";

/**
 * The run lifecycle, served.
 *
 * These routes existed and the state machine existed; nothing joined them. A run
 * was created with whatever verdict the verifier returned and no record of how
 * it got there, so "the run passed" could not be checked against "the run was
 * verified first" — the diagram described a process no code enforced. The tests
 * below drive the API and assert the recorded path, not just the final status.
 */

const DEV_SECRET = "crucible-local-dev-secret-not-for-production";

// The API refuses the dev session secret unless the host says so explicitly;
// the other route suites set the same flag. It is a test-only switch, not a
// default: a deployment that never sets AUTH_SECRET cannot sign anybody in.
process.env.AUTH_ALLOW_DEV_SECRET = "1";

function cookieFor(address: string): string {
  const now = Date.now();
  const payload = {
    address,
    issuedAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000) + 60 * 60 * 24 * 7,
    aud: "http://localhost:3000",
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", DEV_SECRET).update(encoded).digest("base64url");
  return `__Host-crucible_session=${encoded}.${sig}`;
}

const CREATOR = "0x1111111111111111111111111111111111111111";

function app() {
  const instance = new Hono();
  // Client evidence is the demo/local switch; a production host refuses it and
  // the verdict is EVIDENCE_INCOMPLETE instead. That refusal has its own test.
  instance.route("/v1", createWorkloadRoutes({ allowClientEvidence: true }));
  return instance;
}

function task(over: Record<string, unknown> = {}) {
  return {
    slug: "worker-idempotency-repair",
    version: "1.0.0",
    repositorySnapshot: "sha256:" + "a".repeat(64),
    baseCommit: "abc123",
    baselineCommand: ["npm", "test"],
    expectedExitCode: 1,
    checks: [
      { id: "baseline_reproduction", required: true },
      { id: "public_regression", required: true },
      { id: "hidden_regression", required: true },
      { id: "forbidden_diff", required: true },
    ],
    rubricId: "engineering-regression",
    allowedPaths: ["src/**"],
    runnerImageDigest: "registry.example/runner@sha256:" + "b".repeat(64),
    ...over,
  };
}

type Event = { sequence: number; from: RunState; to: RunState };

function assertLegalPath(events: Event[]) {
  expect(events.length).toBeGreaterThan(0);
  events.forEach((event, index) => {
    expect(event.sequence).toBe(index + 1);
    // Every recorded move is one the machine allows. If this fails, the server
    // wrote a state it never proved.
    expect(canTransition(event.from, event.to), `${event.from} -> ${event.to}`).toBe(true);
    if (index > 0) expect(event.from).toBe(events[index - 1]!.to);
  });
}

describe("POST /v1/runs records a legal lifecycle", () => {
  beforeEach(() => __resetRunsForTests());

  it("goes queued → … → provisional result on a passing run", async () => {
    const instance = app();
    const res = await instance.request("/v1/runs", {
      method: "POST",
      headers: { cookie: cookieFor(CREATOR), "content-type": "application/json" },
      body: JSON.stringify({
        profile: "SOFTWARE_ENGINEERING",
        task: task(),
        // Every requirement the adapter will ask about. A partial set is
        // correctly INCOMPLETE, which is the next test's subject.
        evidence: ENGINEERING_REQUIREMENTS.map((requirement) => ({
          id: requirement.id,
          passed: true,
          detail: `${requirement.id} passed`,
        })),
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { run: { runId: string; status: string; state: string } };
    expect(body.run.status).toBe("PASS");
    expect(body.run.state).toBe("PROVISIONAL_RESULT");

    const events = await instance.request(`/v1/runs/${body.run.runId}/events`, {
      headers: { cookie: cookieFor(CREATOR) },
    });
    expect(events.status).toBe(200);
    const log = (await events.json()) as { state: string; events: Event[] };
    assertLegalPath(log.events);
    expect(log.events[0]!.from).toBe("QUEUED");
    expect(log.events.at(-1)!.to).toBe("PROVISIONAL_RESULT");
    // The verify step is in the record, not inferred from the final status.
    expect(log.events.some((e) => e.to === "VERIFYING")).toBe(true);
  });

  it("stops at EVIDENCE_INCOMPLETE when nothing observed the checks", async () => {
    const instance = app();
    const res = await instance.request("/v1/runs", {
      method: "POST",
      headers: { cookie: cookieFor(CREATOR), "content-type": "application/json" },
      body: JSON.stringify({ profile: "SOFTWARE_ENGINEERING", task: task() }),
    });
    const body = (await res.json()) as { run: { runId: string; status: string; state: string }; scorecard: { aggregate: number | null } };
    expect(body.run.status).toBe("INCOMPLETE");
    expect(body.run.state).toBe("EVIDENCE_INCOMPLETE");
    expect(body.scorecard.aggregate).toBeNull();

    const events = await instance.request(`/v1/runs/${body.run.runId}/events`, {
      headers: { cookie: cookieFor(CREATOR) },
    });
    const log = (await events.json()) as { events: Event[] };
    assertLegalPath(log.events);
    // A run with no evidence never reaches SCORING.
    expect(log.events.some((e) => e.to === "SCORING")).toBe(false);
  });

  it("stops at NEEDS_REVIEW for a detection task's unconfirmed finding", async () => {
    const instance = app();
    const res = await instance.request("/v1/runs", {
      method: "POST",
      headers: { cookie: cookieFor(CREATOR), "content-type": "application/json" },
      body: JSON.stringify({
        profile: "SOFTWARE_ENGINEERING",
        task: task({ mode: "contract_detect" }),
        evidence: ENGINEERING_REQUIREMENTS.map((requirement) => ({
          id: requirement.id,
          passed: requirement.id !== "security_invariant",
          detail:
            requirement.id === "security_invariant"
              ? "candidate finding reproduced; severity unconfirmed"
              : `${requirement.id} passed`,
        })),
      }),
    });
    const body = (await res.json()) as {
      run: { runId: string; status: string; state: string; withheldReason: string | null };
      scorecard: { aggregate: number | null };
    };
    expect(body.run.status).toBe("NEEDS_REVIEW");
    expect(body.run.state).toBe("NEEDS_REVIEW");
    expect(body.run.withheldReason).toMatch(/reviewer/);
    expect(body.scorecard.aggregate).toBeNull();
  });

  it("serves the run's artifacts by digest", async () => {
    const instance = app();
    const created = await instance.request("/v1/runs", {
      method: "POST",
      headers: { cookie: cookieFor(CREATOR), "content-type": "application/json" },
      body: JSON.stringify({ profile: "SOFTWARE_ENGINEERING", task: task() }),
    });
    const { run } = (await created.json()) as { run: { runId: string } };
    const res = await instance.request(`/v1/runs/${run.runId}/artifacts`, {
      headers: { cookie: cookieFor(CREATOR) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: unknown[] };
    // The adapter executed nothing and says so; an empty list is the answer, not
    // an omission the caller has to guess at.
    expect(Array.isArray(body.artifacts)).toBe(true);
  });
});
