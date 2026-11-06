import { describe, expect, it } from "vitest";
import { VerificationReportStore as CidVerificationReportStore } from "@crucible/cidstore";
import type { Hex } from "viem";
import {
  envelopeFromReport,
  recordReplayabilityOf,
  replayabilityClassOf,
  VerificationReportStore,
  type StoredVerificationReport,
} from "../src/persistence.js";
import type { VerifyReport } from "../src/argus.js";

const RUN = `0x${"9c".repeat(32)}` as Hex;
const OTHER_RUN = `0x${"7e".repeat(32)}` as Hex;

function report(over: Partial<VerifyReport> = {}): VerifyReport {
  return {
    verdict: "agent-wins",
    phase: "deterministic",
    steps: [],
    reason: "the pinned suite ran green against the artifact",
    ...over,
  } as VerifyReport;
}

function draft(over: Partial<Parameters<typeof envelopeFromReport>[0]> = {}): StoredVerificationReport {
  return envelopeFromReport({
    runHash: RUN,
    reportVersion: 1,
    evaluator: { version: "1.4.0", rubricVersion: "3", imageDigest: "sha256:aaaa" },
    report: report(),
    createdAt: "2026-11-06T04:30:00Z",
    ...over,
  });
}

/**
 * What argus owns here: the translation from a `VerifyReport` to an envelope, and the class the
 * record's word comes from.
 *
 * The version chain itself is tested in `packages/cidstore/test/report-store.test.ts`, next to
 * the class that implements it, and that file deliberately never imports this package.
 */
describe("the envelope this package builds", () => {
  it("carries a real VerifyReport through the envelope contract", () => {
    const e = draft();
    expect(e.evaluator.name).toBe("argus");
    expect(e.result.verdict).toBe("agent-wins");
    expect(e.result.phase).toBe("deterministic");
    expect(e.schemaVersion).toBe(1);
  });

  it("leaves `previousReportDigest` off version 1 and on from the draft, not from a default", () => {
    expect("previousReportDigest" in draft()).toBe(false);
    expect(
      "previousReportDigest" in draft({ reportVersion: 2, previousReportDigest: `0x${"11".repeat(32)}` as Hex }),
    ).toBe(true);
    // And the other direction is a refusal, not a silent drop: a version 1 that claims a
    // predecessor is a chain that started somewhere this envelope cannot see.
    expect(() => draft({ previousReportDigest: `0x${"11".repeat(32)}` as Hex })).toThrow(
      /version 1 cannot name a predecessor/,
    );
  });

  it("refuses an evaluator version that is empty, because a nameless verifier is not evidence", () => {
    expect(() => draft({ evaluator: { version: "" } })).toThrow(/evaluator.version/);
  });

  /**
   * One implementation, checked rather than commented.
   *
   * The class moved to `@crucible/cidstore` so a reader of published evidence would not have to
   * depend on the sandbox SDK, and argus re-exports it for the seat. The failure mode of a
   * re-export is the fork: somebody pastes the class back here, both exist, and the API and the
   * seat stop agreeing about what a version chain is while every test in each package passes.
   * Reference identity is the cheapest assertion that makes that impossible to miss.
   */
  it("is the same class the content store exports, not a copy", () => {
    expect(VerificationReportStore).toBe(CidVerificationReportStore);
  });
});

describe("the replayability class", () => {
  /**
   * `apps/juror/src/policy.ts` owns this rule for the seat's seal; this package cannot import
   * an app, so the mapping is restated and the agreement is asserted in
   * `apps/juror/test/policy.test.ts`. These are the same three rows from the other side.
   */
  it("follows the phase, never the verdict", () => {
    expect(replayabilityClassOf(report({ phase: "deterministic", verdict: "agent-wins" }))).toBe("artifact-replayable");
    expect(replayabilityClassOf(report({ phase: "deterministic", verdict: "break-wins" }))).toBe("artifact-replayable");
    expect(replayabilityClassOf(report({ phase: "rubric", verdict: "agent-wins" }))).toBe("generation-attested");
    expect(replayabilityClassOf(report({ phase: "abstain", verdict: "abstain" }))).toBe("undecided");
  });

  it("carries the class into the record's word without calling an attested run nondeterministic", () => {
    expect(recordReplayabilityOf(report({ phase: "deterministic" }))).toBe("deterministic");
    expect(recordReplayabilityOf(report({ phase: "rubric" }))).toBe("partial");
    expect(recordReplayabilityOf(report({ phase: "abstain" }))).toBe("nondeterministic");
  });
});
