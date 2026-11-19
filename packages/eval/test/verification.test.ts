import { describe, expect, it } from "vitest";
import {
  HARD_GATE_DIMENSIONS,
  checksDigest,
  computeVerdict,
  scoreVerdict,
  type RequiredCheck,
} from "../src/verification.js";
import { ENGINEERING_REQUIREMENTS } from "../src/workload-software.js";
import { getAdapter } from "../src/workload.js";

const REQUIREMENTS: readonly RequiredCheck[] = [
  { id: "build", required: true, dimension: "acceptance_correctness", expectation: "it builds" },
  { id: "hidden", required: true, dimension: "regression_resistance", expectation: "hidden suite passes" },
  { id: "security", required: true, dimension: "security_invariant", expectation: "no invariant violation" },
  { id: "perf", required: false, dimension: "performance", expectation: "inside budget" },
];

const RUBRIC = {
  id: "engineering-regression",
  version: "v1",
  dimensions: [
    { id: "acceptance_correctness", weight: 0.5 },
    { id: "regression_resistance", weight: 0.3 },
    { id: "security_invariant", weight: 0.2 },
  ],
};

describe("computeVerdict", () => {
  it("passes only when every required check has passing evidence", () => {
    const verdict = computeVerdict({
      requirements: REQUIREMENTS,
      evidence: [
        { id: "build", passed: true, detail: "built" },
        { id: "hidden", passed: true, detail: "hidden passed" },
        { id: "security", passed: true, detail: "no finding" },
      ],
      outcome: "completed",
      verifierVersion: "v",
    });
    expect(verdict.report.status).toBe("PASS");
    expect(verdict.report.reportDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is INCOMPLETE — not FAIL, not zero — when no evidence was reported", () => {
    const verdict = computeVerdict({
      requirements: REQUIREMENTS,
      evidence: undefined,
      outcome: "completed",
      verifierVersion: "v",
    });
    expect(verdict.report.status).toBe("INCOMPLETE");
    // Optional checks are named too, so an operator can see what was never run.
    expect(verdict.missingEvidence).toEqual(["build", "hidden", "security", "perf"]);
  });

  it("fails when a required check has evidence that failed", () => {
    const verdict = computeVerdict({
      requirements: REQUIREMENTS,
      evidence: [
        { id: "build", passed: true, detail: "built" },
        { id: "hidden", passed: false, detail: "hidden suite failed" },
        { id: "security", passed: true, detail: "no finding" },
      ],
      outcome: "completed",
      verifierVersion: "v",
    });
    expect(verdict.report.status).toBe("FAIL");
    expect(verdict.report.checks.find((c) => c.id === "hidden")!.passed).toBe(false);
  });

  it("reports an infrastructure failure rather than blaming the participant", () => {
    const verdict = computeVerdict({
      requirements: REQUIREMENTS,
      evidence: [
        { id: "build", passed: false, detail: "container died" },
        { id: "hidden", passed: false, detail: "container died" },
        { id: "security", passed: false, detail: "container died" },
      ],
      outcome: "failed",
      infrastructureFailure: "runner OOM-killed after 3 retries",
      verifierVersion: "v",
    });
    expect(verdict.report.status).toBe("INCOMPLETE");
    expect(verdict.infrastructureFailure).toMatch(/OOM/);
  });

  it("changes the digest when any check differs", () => {
    const a = computeVerdict({
      requirements: REQUIREMENTS,
      evidence: [
        { id: "build", passed: true, detail: "built" },
        { id: "hidden", passed: true, detail: "ok" },
        { id: "security", passed: true, detail: "ok" },
      ],
      outcome: "completed",
      verifierVersion: "v",
    });
    const b = computeVerdict({
      requirements: REQUIREMENTS,
      evidence: [
        { id: "build", passed: true, detail: "built" },
        { id: "hidden", passed: false, detail: "ok" },
        { id: "security", passed: true, detail: "ok" },
      ],
      outcome: "completed",
      verifierVersion: "v",
    });
    expect(a.report.reportDigest).not.toBe(b.report.reportDigest);
  });

  it("is stable for the same check set in a different order", () => {
    const checks = [
      { id: "b", passed: true, required: true, detail: "x" },
      { id: "a", passed: false, required: true, detail: "y" },
    ];
    expect(checksDigest(checks)).toBe(checksDigest([...checks].reverse()));
  });
});

describe("scoreVerdict", () => {
  it("withholds the aggregate when the report is incomplete", () => {
    const verdict = computeVerdict({
      requirements: REQUIREMENTS,
      evidence: undefined,
      outcome: "completed",
      verifierVersion: "v",
    });
    const scored = scoreVerdict({ report: verdict.report, rubric: RUBRIC, requirements: REQUIREMENTS });
    expect(scored.scorecard.aggregate).toBeNull();
    expect(scored.withheldReason).toMatch(/incomplete/);
  });

  it("weights the dimensions that were actually measured", () => {
    const verdict = computeVerdict({
      requirements: REQUIREMENTS,
      evidence: [
        { id: "build", passed: true, detail: "ok" },
        { id: "hidden", passed: false, detail: "failed" },
        { id: "security", passed: true, detail: "ok" },
      ],
      outcome: "completed",
      verifierVersion: "v",
    });
    const scored = scoreVerdict({ report: verdict.report, rubric: RUBRIC, requirements: REQUIREMENTS });
    expect(scored.scorecard.metrics.acceptance_correctness).toBe(1);
    expect(scored.scorecard.metrics.regression_resistance).toBe(0);
    expect(scored.scorecard.aggregate).toBeCloseTo(0.7, 5);
  });

  it("zeroes a hard-gate dimension rather than averaging the failure away", () => {
    const verdict = computeVerdict({
      requirements: REQUIREMENTS,
      evidence: [
        { id: "build", passed: true, detail: "ok" },
        { id: "hidden", passed: true, detail: "ok" },
        { id: "security", passed: false, detail: "invariant broke" },
      ],
      outcome: "completed",
      verifierVersion: "v",
    });
    const scored = scoreVerdict({
      report: verdict.report,
      rubric: RUBRIC,
      requirements: REQUIREMENTS,
      hardGateDimensions: HARD_GATE_DIMENSIONS.software,
    });
    expect(scored.scorecard.metrics.security_invariant).toBe(0);
    expect(scored.scorecard.aggregate).toBeCloseTo(0.8, 5);
  });

  it("never returns a scorecard whose id is not derived from the report", () => {
    const verdict = computeVerdict({
      requirements: REQUIREMENTS,
      evidence: [
        { id: "build", passed: true, detail: "ok" },
        { id: "hidden", passed: true, detail: "ok" },
        { id: "security", passed: true, detail: "ok" },
      ],
      outcome: "completed",
      verifierVersion: "v",
    });
    const scored = scoreVerdict({ report: verdict.report, rubric: RUBRIC, requirements: REQUIREMENTS });
    expect(scored.scorecard.scorecardId).toBe(`sc-${verdict.report.reportDigest.slice(7, 19)}`);
  });
});

describe("NEEDS_REVIEW", () => {
  const REVIEWABLE: readonly RequiredCheck[] = [
    { id: "build", required: true, dimension: "acceptance_correctness", expectation: "it builds" },
    {
      id: "finding",
      required: true,
      dimension: "security_invariant",
      expectation: "the reported finding reproduces",
      reviewOnFailure: true,
    },
  ];

  it("routes a failure a machine cannot settle to a reviewer", () => {
    const verdict = computeVerdict({
      requirements: REVIEWABLE,
      evidence: [
        { id: "build", passed: true, detail: "built" },
        { id: "finding", passed: false, detail: "PoC reproduced; severity unconfirmed" },
      ],
      outcome: "completed",
      verifierVersion: "v",
    });
    expect(verdict.report.status).toBe("NEEDS_REVIEW");
    expect(verdict.reviewRequired).toEqual(["finding"]);
  });

  it("still fails when any failure is one the machine can settle", () => {
    // The mark must not be a way to turn a failed build into "needs review".
    const verdict = computeVerdict({
      requirements: REVIEWABLE,
      evidence: [
        { id: "build", passed: false, detail: "does not compile" },
        { id: "finding", passed: false, detail: "PoC reproduced" },
      ],
      outcome: "completed",
      verifierVersion: "v",
    });
    expect(verdict.report.status).toBe("FAIL");
    expect(verdict.reviewRequired).toEqual([]);
  });

  it("withholds the score and says the finding is unconfirmed", () => {
    const verdict = computeVerdict({
      requirements: REVIEWABLE,
      evidence: [
        { id: "build", passed: true, detail: "built" },
        { id: "finding", passed: false, detail: "PoC reproduced" },
      ],
      outcome: "completed",
      verifierVersion: "v",
    });
    const scored = scoreVerdict({ report: verdict.report, rubric: RUBRIC, requirements: REVIEWABLE });
    expect(scored.scorecard.aggregate).toBeNull();
    expect(scored.withheldReason).toMatch(/reviewer/);
  });

  it("is reachable from an engineering task in detect mode, and not in repair mode", async () => {
    const adapter = getAdapter("SOFTWARE_ENGINEERING");
    const task = (mode: string) => ({
      slug: "s",
      version: "1",
      repositorySnapshot: "sha256:" + "e".repeat(64),
      baseCommit: "c",
      baselineCommand: ["t"],
      expectedExitCode: 1,
      mode,
      checks: [
        { id: "baseline_reproduction", required: true },
        { id: "public_regression", required: true },
        { id: "hidden_regression", required: true },
        { id: "forbidden_diff", required: true },
        { id: "security_invariant", required: true },
      ],
      rubricId: "r",
    });
    const context = {
      runId: "r",
      attemptId: "a",
      tenantId: "t",
      trialId: "tr",
      trialRevisionId: "v",
      workloadProfile: "SOFTWARE_ENGINEERING" as const,
      environmentDigest: "sha256:runner",
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: "k",
      abortSignal: new AbortController().signal,
    };

    const verdictFor = async (mode: string) => {
      const prepared = await adapter.prepare(task(mode), context);
      const executed = await adapter.execute(prepared, {} as never);
      executed.evidence = ENGINEERING_REQUIREMENTS.map((r) => ({
        id: r.id,
        passed: r.id !== "security_invariant",
        detail: r.id === "security_invariant" ? "candidate finding reproduced" : "passed",
      }));
      return adapter.verify(executed, {} as never);
    };

    expect((await verdictFor("contract_detect")).status).toBe("NEEDS_REVIEW");
    // The same evidence in a repair task is a defect, not a finding.
    expect((await verdictFor("regression_repair")).status).toBe("FAIL");
  });
});

describe("adapters are evidence-driven", () => {
  it("the engineering adapter refuses to claim a pass it did not observe", async () => {
    const adapter = getAdapter("SOFTWARE_ENGINEERING");
    const prepared = await adapter.prepare(
      {
        slug: "s",
        version: "1",
        repositorySnapshot: "sha256:" + "c".repeat(64),
        baseCommit: "c",
        baselineCommand: ["t"],
        expectedExitCode: 1,
        checks: [
          { id: "baseline_reproduction", required: true },
          { id: "public_regression", required: true },
          { id: "hidden_regression", required: true },
          { id: "forbidden_diff", required: true },
        ],
        rubricId: "r",
      },
      {
        runId: "r",
        attemptId: "a",
        tenantId: "t",
        trialId: "tr",
        trialRevisionId: "v",
        workloadProfile: "SOFTWARE_ENGINEERING",
        environmentDigest: "sha256:runner",
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        idempotencyKey: "k",
        abortSignal: new AbortController().signal,
      },
    );
    const executed = await adapter.execute(prepared, {} as never);
    const report = await adapter.verify(executed, {} as never);
    // No runner reported anything, so the honest verdict is INCOMPLETE.
    expect(report.status).toBe("INCOMPLETE");
    expect(report.reportDigest).not.toMatch(/placeholder/);
    const scorecard = await adapter.score(report, {
      id: "engineering-regression",
      version: "v1",
      dimensions: ENGINEERING_REQUIREMENTS.map((r) => ({ id: r.dimension, weight: 1 })),
    });
    expect(scorecard.aggregate).toBeNull();
  });

  it("the engineering adapter passes when a runner reports every required check", async () => {
    const adapter = getAdapter("SOFTWARE_ENGINEERING");
    const prepared = await adapter.prepare(
      {
        slug: "s",
        version: "1",
        repositorySnapshot: "sha256:" + "d".repeat(64),
        baseCommit: "c",
        baselineCommand: ["t"],
        expectedExitCode: 1,
        checks: [
          { id: "baseline_reproduction", required: true },
          { id: "public_regression", required: true },
          { id: "hidden_regression", required: true },
          { id: "forbidden_diff", required: true },
        ],
        rubricId: "r",
      },
      {
        runId: "r",
        attemptId: "a",
        tenantId: "t",
        trialId: "tr",
        trialRevisionId: "v",
        workloadProfile: "SOFTWARE_ENGINEERING",
        environmentDigest: "sha256:runner",
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        idempotencyKey: "k",
        abortSignal: new AbortController().signal,
      },
    );
    const executed = await adapter.execute(prepared, {} as never);
    executed.evidence = ENGINEERING_REQUIREMENTS.map((r) => ({
      id: r.id,
      passed: true,
      detail: `${r.id} passed`,
    }));
    const report = await adapter.verify(executed, {} as never);
    expect(report.status).toBe("PASS");
  });
});