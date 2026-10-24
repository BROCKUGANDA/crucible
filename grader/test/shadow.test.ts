import { describe, expect, it } from "vitest";
import { ShadowRunner, DivergenceReport } from "../src/eval/shadow.js";
import { StubModelAdapter } from "../src/eval/adapters/stub.js";
import type { ModelVerdict } from "../src/eval/types.js";

const PASS = "PASS" as const;
const VOID = "VOID" as const;

describe("ShadowRunner (gate 430)", () => {
  const prod = new StubModelAdapter("prod-v1");
  const cand = new StubModelAdapter("cand-v1");

  it("shouldSample returns a boolean", () => {
    const runner = new ShadowRunner(0.01);
    const s = runner.shouldSample();
    expect([true, false]).toContain(s);
  });

  it("sampleRate 0 never samples", () => {
    const runner = new ShadowRunner(0);
    let sampled = false;
    for (let i = 0; i < 1000; i++) if (runner.shouldSample()) sampled = true;
    expect(sampled).toBe(false);
  });

  it("sampleRate 1 always samples", () => {
    const runner = new ShadowRunner(1);
    let notSampled = false;
    for (let i = 0; i < 100; i++) if (!runner.shouldSample()) notSampled = true;
    expect(notSampled).toBe(false);
  });

  it("record produces a ShadowRun with diverged flag", async () => {
    const runner = new ShadowRunner(0.5);
    const p: ModelVerdict = { verdict: PASS, confidence: 0.9, latencyMs: 10, promptVersion: "v1" };
    const c: ModelVerdict = { verdict: VOID, confidence: 0.4, latencyMs: 12, promptVersion: "v1" };
    const run = runner.record("claim-1", "prod-v1", "cand-v1", p, c);

    expect(run.claimHash).toBe("claim-1");
    expect(run.productionModel).toBe("prod-v1");
    expect(run.candidateModel).toBe("cand-v1");
    expect(run.productionVerdict).toBe(PASS);
    expect(run.candidateVerdict).toBe(VOID);
    expect(run.diverged).toBe(true);
  });

  it("divergenceReport computes rate and per-candidate breakdown", () => {
    const runner = new ShadowRunner(0.5);
    const p: ModelVerdict = { verdict: PASS, confidence: 0.9, latencyMs: 10, promptVersion: "v1" };
    const c: ModelVerdict = { verdict: PASS, confidence: 0.8, latencyMs: 10, promptVersion: "v1" };
    const d: ModelVerdict = { verdict: VOID, confidence: 0.4, latencyMs: 10, promptVersion: "v1" };

    const runs = [
      runner.record("c1", "prod", "cand", p, c),   // agree
      runner.record("c2", "prod", "cand", p, d),   // diverge
      runner.record("c3", "prod", "cand", p, d),   // diverge
    ];

    const report = runner.divergenceReport(runs) as DivergenceReport;
    expect(report.total).toBe(3);
    expect(report.diverged).toBe(2);
    expect(report.divergenceRate).toBeCloseTo(2 / 3, 6);
    expect(report.byCandidate["cand"].total).toBe(3);
    expect(report.byCandidate["cand"].diverged).toBe(2);
    expect(report.disagreements.length).toBe(2);
  });

  it("empty runs yield zero report", () => {
    const runner = new ShadowRunner(0.5);
    const report = runner.divergenceReport([]) as DivergenceReport;
    expect(report.total).toBe(0);
    expect(report.diverged).toBe(0);
    expect(report.divergenceRate).toBe(0);
  });
});
