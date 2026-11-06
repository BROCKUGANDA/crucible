import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  assertLineage,
  assertVerificationReportEnvelope,
  classifyReplay,
  ReportConflictError,
  verificationReportDigest,
  type VerificationReportEnvelope,
} from "../src/verification-envelope.js";

const RUN_HASH = `0x${"9c".repeat(32)}` as Hex;
const OTHER_RUN = `0x${"77".repeat(32)}` as Hex;

/** The report shape `packages/argus` returns; here it is opaque on purpose. */
const REPORT = { verdict: "agent-wins", phase: "deterministic", steps: [], reason: "suite green" };

/**
 * A second *well-formed* report with a different answer.
 *
 * Not `{ verdict: "break-wins" }` on its own: `assertVerificationReportEnvelope` validates the
 * payload's minimum shape (verdict, phase, steps, reason), so a thin object stops at validation
 * and never reaches the digest or the lineage check this file is testing. A malformed payload is
 * rejected before it can be compared — which is the behaviour, not an inconvenience.
 */
const BREAK_WINS = { verdict: "break-wins", phase: "deterministic", steps: [], reason: "the break reproduced" };

function envelope(over: Partial<VerificationReportEnvelope> = {}): VerificationReportEnvelope {
  const base: VerificationReportEnvelope = {
    schemaVersion: 1,
    runHash: RUN_HASH,
    reportVersion: 1,
    evaluator: { name: "argus", version: "1.4.0", rubricVersion: "3", imageDigest: "sha256:aaaa" },
    result: REPORT,
    createdAt: "2026-11-06T04:30:00Z",
    ...over,
  };
  return assertVerificationReportEnvelope(base);
}

function nextVersion(previous: VerificationReportEnvelope): VerificationReportEnvelope {
  return envelope({
    reportVersion: 2,
    previousReportDigest: verificationReportDigest(previous),
    result: { verdict: "abstain", phase: "abstain", steps: [], reason: "re-run could not reproduce" },
    createdAt: "2026-11-06T05:00:00Z",
  });
}

describe("the envelope digest", () => {
  it("is the same document however its keys were ordered", () => {
    const a = envelope();
    const b = assertVerificationReportEnvelope({
      createdAt: a.createdAt,
      result: a.result,
      evaluator: a.evaluator,
      reportVersion: a.reportVersion,
      runHash: a.runHash,
      schemaVersion: a.schemaVersion,
    });
    expect(verificationReportDigest(b)).toBe(verificationReportDigest(a));
  });

  it("moves when the verdict, the evaluator or the image moves", () => {
    const a = envelope();
    expect(verificationReportDigest(envelope({ result: BREAK_WINS }))).not.toBe(
      verificationReportDigest(a),
    );
    expect(
      verificationReportDigest(envelope({ evaluator: { name: "argus", version: "1.5.0" } })),
    ).not.toBe(verificationReportDigest(a));
    expect(
      verificationReportDigest(envelope({ evaluator: { name: "argus", version: "1.4.0", imageDigest: "sha256:bbbb" } })),
    ).not.toBe(verificationReportDigest(a));
  });
});

describe("assertVerificationReportEnvelope", () => {
  it("accepts a first version and refuses one that claims a predecessor", () => {
    expect(envelope().reportVersion).toBe(1);
    expect(() =>
      assertVerificationReportEnvelope({
        ...envelope(),
        previousReportDigest: `0x${"11".repeat(32)}`,
      }),
    ).toThrow(/version 1 cannot name a predecessor/);
  });

  it("refuses a later version that names no predecessor", () => {
    expect(() => envelope({ reportVersion: 2 })).toThrow(ReportConflictError);
    expect(() => envelope({ reportVersion: 2 })).toThrow(/must name its predecessor/);
  });

  it("refuses a zero, fractional or absent version", () => {
    for (const reportVersion of [0, 1.5, "2"]) {
      expect(() => envelope({ reportVersion: reportVersion as unknown as number })).toThrow(/reportVersion/);
    }
  });

  it("refuses an evaluator that is not the one this pipeline answers to", () => {
    expect(() => envelope({ evaluator: { name: "self-reported", version: "1" } as never })).toThrow(
      /evaluator.name/,
    );
    expect(() => envelope({ evaluator: { name: "argus", version: "" } })).toThrow(/evaluator.version/);
  });

  it("refuses a timestamp that is not UTC", () => {
    expect(() => envelope({ createdAt: "2026-11-06 04:30:00" })).toThrow(/createdAt/);
  });

  it("refuses an envelope with no result rather than projecting a verdict-shaped hole", () => {
    const { result: _result, ...without } = envelope();
    expect(() => assertVerificationReportEnvelope(without)).toThrow(/result/);
  });

  it("keeps only the evaluator fields it knows", () => {
    const padded = assertVerificationReportEnvelope({
      ...envelope(),
      evaluator: { name: "argus", version: "1.4.0", operatorNote: "trust me" },
    });
    expect(padded.evaluator).toEqual({ name: "argus", version: "1.4.0" });
  });
});

describe("assertLineage", () => {
  it("accepts a chain where each link digests the one before", () => {
    const first = envelope();
    const second = nextVersion(first);
    expect(() => assertLineage(null, first)).not.toThrow();
    expect(() => assertLineage(first, second)).not.toThrow();
  });

  it("refuses a first version when the store already has one", () => {
    expect(() => assertLineage(envelope(), envelope())).toThrow(/a version already exists/);
  });

  it("refuses a version whose predecessor is missing", () => {
    // What the store does: it looks up `reportVersion - 1` and passes what it found, or null.
    expect(() => assertLineage(null, envelope({ reportVersion: 2, previousReportDigest: `0x${"11".repeat(32)}` }))).toThrow(
      /version 1 is not in the store/,
    );
  });

  it("refuses a chain that skips a version", () => {
    const first = envelope();
    const third = envelope({
      reportVersion: 3,
      previousReportDigest: verificationReportDigest(first),
    });
    expect(() => assertLineage(first, third)).toThrow(/the predecessor is version 1, not 2/);
  });

  it("refuses a predecessor from another run", () => {
    const first = envelope();
    const alien = envelope({ runHash: OTHER_RUN });
    const second = envelope({
      reportVersion: 2,
      previousReportDigest: verificationReportDigest(alien),
    });
    expect(() => assertLineage(alien, second)).toThrow(/another run/);
    expect(() => assertLineage(first, second)).toThrow(/previousReportDigest does not match/);
  });

  it("refuses a re-attached link: right version, wrong digest", () => {
    const first = envelope();
    const tampered = envelope({
      reportVersion: 2,
      previousReportDigest: `0x${"00".repeat(32)}`,
    });
    expect(() => assertLineage(first, tampered)).toThrow(/does not match the digest of the stored predecessor/);
  });

  it("carries the run and version it is complaining about", () => {
    const second = envelope({ reportVersion: 2, previousReportDigest: `0x${"00".repeat(32)}` });
    const error = (() => {
      try {
        assertLineage(envelope(), second);
        return null;
      } catch (err) {
        return err as ReportConflictError;
      }
    })();
    expect(error).toBeInstanceOf(ReportConflictError);
    expect(error?.runHash).toBe(RUN_HASH);
    expect(error?.reportVersion).toBe(2);
  });
});

describe("classifyReplay", () => {
  it("treats an identical delivery as a no-op", () => {
    expect(classifyReplay(envelope(), envelope())).toBe("replayed");
  });

  /**
   * The rule that makes an at-least-once writer safe to run beside a skeptic.
   *
   * A second verification of the same version that differs in *anything* — a new timestamp, a
   * new evaluator build, a different verdict — is a conflict, not an update. Silently keeping
   * the later write is how a re-run would erase the answer somebody already cited.
   */
  it("treats any difference as a conflict, including a cosmetic one", () => {
    const a = envelope();
    expect(classifyReplay(a, envelope({ createdAt: "2026-11-06T04:30:01Z" }))).toBe("conflict");
    expect(classifyReplay(a, envelope({ result: BREAK_WINS }))).toBe("conflict");
  });
});
