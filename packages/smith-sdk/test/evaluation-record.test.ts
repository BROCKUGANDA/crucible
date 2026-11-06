import { describe, expect, it } from "vitest";
import { isAddress, type Address, type Hex } from "viem";
import {
  assertEvaluationRecord,
  canonicalEvaluationRecord,
  evaluationIdOf,
  evaluationRecordDigest,
  evaluateEligibility,
  EvaluationRecordError,
  replayabilityFromClass,
  type EvaluationRecord,
} from "../src/evaluation-record.js";

const FUNDER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const RUNNER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
const TX = `0x${"5d".repeat(32)}` as Hex;
const RUN_HASH = `0x${"9c".repeat(32)}` as Hex;
const DIGEST = `0x${"11".repeat(32)}` as Hex;

function record(over: Partial<Record<string, unknown>> = {}): EvaluationRecord {
  const base = {
    schemaVersion: 1,
    runHash: RUN_HASH,
    identity: {
      chainId: 31337,
      trialId: 14,
      agentId: 3,
      funderId: FUNDER,
      runner: RUNNER,
      transactionHash: TX,
      blockNumber: 428,
      timestamp: 1_793_923_200_000,
    },
    evidence: {
      manifestCid: "bafkreihexample",
      manifestDigest: DIGEST,
      verificationReportCid: "bafkreigexample",
      verificationReportDigest: `0x${"55".repeat(32)}` as Hex,
    },
    verification: {
      verdict: "agent-wins",
      phase: "deterministic",
      replayability: "deterministic",
      evaluatorVersion: "1.0.0",
      verifiedAt: "2026-11-06T04:30:00Z",
      reportVersion: 1,
    },
    ranking: { eligible: true, exclusionReasons: [], cohortId: "swe-bench-verified-2026", score: 0.88, uncertainty: 0.02 },
    ...over,
  } as Record<string, unknown>;
  const identity = base.identity as Record<string, unknown>;
  return assertEvaluationRecord({
    ...base,
    evaluationId: evaluationIdOf({
      chainId: Number(identity.chainId),
      trialId: Number(identity.trialId),
      runHash: base.runHash as Hex,
    }),
  });
}

describe("the evaluation id", () => {
  it("is a pure function of the three facts it names", () => {
    const a = evaluationIdOf({ chainId: 31337, trialId: 14, runHash: RUN_HASH });
    const b = evaluationIdOf({ chainId: 31337, trialId: 14, runHash: RUN_HASH });
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });

  /**
   * The reason this is `abi.encode` and not `encodePacked`.
   *
   * Packed encoding writes two integers as their shortest hex and concatenates, so `(1, 23)`
   * and `(12, 3)` both become `…0117…`-shaped bytes — one key, two evaluations. A public
   * route dereferences this value, so a collision is not a cosmetic bug.
   */
  it("does not collide when the digit boundaries move", () => {
    const one = evaluationIdOf({ chainId: 1, trialId: 23, runHash: RUN_HASH });
    const two = evaluationIdOf({ chainId: 12, trialId: 3, runHash: RUN_HASH });
    expect(one).not.toBe(two);
  });

  it("changes with the chain, the trial, or the run", () => {
    const base = { chainId: 31337, trialId: 14, runHash: RUN_HASH };
    expect(evaluationIdOf({ ...base, chainId: 11155111 })).not.toBe(evaluationIdOf(base));
    expect(evaluationIdOf({ ...base, trialId: 15 })).not.toBe(evaluationIdOf(base));
    expect(evaluationIdOf({ ...base, runHash: `0x${"12".repeat(32)}` as Hex })).not.toBe(evaluationIdOf(base));
  });
});

describe("assertEvaluationRecord", () => {
  it("accepts a well-formed eligible record", () => {
    const r = record();
    expect(r.ranking.eligible).toBe(true);
    expect(r.ranking.score).toBe(0.88);
    expect(isAddress(r.identity.runner)).toBe(true);
  });

  it("refuses a foreign schema version", () => {
    const r = record();
    expect(() => assertEvaluationRecord({ ...r, schemaVersion: 2 })).toThrow(EvaluationRecordError);
  });

  it("refuses an id that does not match its own identity", () => {
    const r = record();
    const forged = { ...r, identity: { ...r.identity, trialId: r.identity.trialId + 1 } };
    expect(() => assertEvaluationRecord(forged)).toThrow(/does not match keccak256/);
  });

  it("refuses a truncated transaction hash", () => {
    const r = record();
    expect(() =>
      assertEvaluationRecord({ ...r, identity: { ...r.identity, transactionHash: `0x${"ab".repeat(31)}` } }),
    ).toThrow(/identity.transactionHash/);
  });

  it("writes an address back in one form, whichever it arrived in", () => {
    const r = record();
    const lower = { ...r, identity: { ...r.identity, runner: RUNNER.toLowerCase() as Address } };
    const normalized = assertEvaluationRecord(lower);
    expect(normalized.identity.runner).toBe(RUNNER);
    // The reason this is not a cosmetic preference: the digest is taken over the canonical
    // bytes, so an address two services spell differently must not hash to two documents.
    expect(evaluationRecordDigest(normalized)).toBe(evaluationRecordDigest(r));
  });

  it("refuses a string that is not an address at all", () => {
    const r = record();
    expect(() =>
      assertEvaluationRecord({ ...r, identity: { ...r.identity, runner: "0x123" } }),
    ).toThrow(/identity.runner/);
    expect(() =>
      assertEvaluationRecord({ ...r, identity: { ...r.identity, funderId: "vitalik.eth" } }),
    ).toThrow(/identity.funderId/);
  });

  it("refuses a zero block or timestamp rather than printing them as data", () => {
    const r = record();
    expect(() => assertEvaluationRecord({ ...r, identity: { ...r.identity, blockNumber: 0 } })).toThrow(
      /identity.blockNumber/,
    );
    expect(() => assertEvaluationRecord({ ...r, identity: { ...r.identity, timestamp: 0 } })).toThrow(
      /identity.timestamp/,
    );
  });

  it("refuses a verifiedAt that is not UTC", () => {
    const r = record();
    expect(() =>
      assertEvaluationRecord({ ...r, verification: { ...r.verification, verifiedAt: "2026-11-06T04:30:00+03:00" } }),
    ).toThrow(/verifiedAt/);
    expect(() =>
      assertEvaluationRecord({ ...r, verification: { ...r.verification, verifiedAt: "6 Nov 2026" } }),
    ).toThrow(/verifiedAt/);
  });

  it("refuses an unknown verdict, phase or replayability word", () => {
    const r = record();
    expect(() => assertEvaluationRecord({ ...r, verification: { ...r.verification, verdict: "win" } })).toThrow(
      /verification.verdict/,
    );
    expect(() => assertEvaluationRecord({ ...r, verification: { ...r.verification, phase: "maybe" } })).toThrow(
      /verification.phase/,
    );
    expect(() =>
      assertEvaluationRecord({ ...r, verification: { ...r.verification, replayability: "kinda" } }),
    ).toThrow(/verification.replayability/);
  });

  it("refuses a reason that is not in the vocabulary, and a reason listed twice", () => {
    const ineligible = record({
      ranking: {
        eligible: false,
        exclusionReasons: ["VERDICT_ABSTAIN"],
        verdict: "abstain",
      },
      verification: { verdict: "abstain", phase: "abstain", replayability: "nondeterministic", evaluatorVersion: "1.0.0", verifiedAt: "2026-11-06T04:30:00Z", reportVersion: 1 },
    });
    expect(ineligible.ranking.eligible).toBe(false);
    expect(() =>
      assertEvaluationRecord({ ...ineligible, ranking: { ...ineligible.ranking, exclusionReasons: ["WE_FEEL_LIKE_IT"] } }),
    ).toThrow(/exclusionReasons\[0\]/);
    expect(() =>
      assertEvaluationRecord({
        ...ineligible,
        ranking: { ...ineligible.ranking, exclusionReasons: ["VERDICT_ABSTAIN", "VERDICT_ABSTAIN"] },
      }),
    ).toThrow(/must not repeat/);
  });
});

describe("the eligibility law", () => {
  it("refuses eligible with a verdict that did not win", () => {
    const r = record();
    expect(() =>
      assertEvaluationRecord({
        ...r,
        verification: { ...r.verification, verdict: "abstain" },
      }),
    ).toThrow(/requires verification.verdict = agent-wins/);
    expect(() =>
      assertEvaluationRecord({ ...r, verification: { ...r.verification, verdict: "break-wins" } }),
    ).toThrow(/agent-wins/);
  });

  it("refuses eligible alongside a reason", () => {
    const r = record();
    expect(() =>
      assertEvaluationRecord({ ...r, ranking: { ...r.ranking, exclusionReasons: ["TAMPERED_EVIDENCE"] } }),
    ).toThrow(/cannot be true while exclusionReasons is not empty/);
  });

  it("refuses ineligible with nothing said about why", () => {
    const r = record();
    expect(() => assertEvaluationRecord({ ...r, ranking: { ...r.ranking, eligible: false } })).toThrow(
      /must name at least one reason/,
    );
  });

  it("derives eligibility from facts instead of believing a flag", () => {
    expect(evaluateEligibility({ verdict: "agent-wins" })).toEqual({ eligible: true, exclusionReasons: [] });
    expect(evaluateEligibility({ verdict: "agent-wins", reasons: ["RUNNER_UNREGISTERED"] }).eligible).toBe(false);
    expect(evaluateEligibility({ verdict: "abstain" }).exclusionReasons).toContain("VERDICT_ABSTAIN");
    expect(evaluateEligibility({ verdict: "break-wins" }).exclusionReasons).toContain("VERDICT_BREAK_WINS");
    expect(evaluateEligibility({ verdict: null }).exclusionReasons).toContain("UNVERIFIED");
  });

  it("does not repeat a reason it was handed and one it derived", () => {
    const once = evaluateEligibility({ verdict: "abstain", reasons: ["VERDICT_ABSTAIN"] });
    expect(once.exclusionReasons).toEqual(["VERDICT_ABSTAIN"]);
  });
});

describe("scores and digests", () => {
  it("keeps a benchmark score inside the unit interval", () => {
    const r = record();
    expect(() => assertEvaluationRecord({ ...r, ranking: { ...r.ranking, score: 1.5 } })).toThrow(/ranking.score/);
    expect(() => assertEvaluationRecord({ ...r, ranking: { ...r.ranking, score: -0.5 } })).toThrow(/ranking.score/);
    expect(() => assertEvaluationRecord({ ...r, ranking: { ...r.ranking, score: Number.NaN } })).toThrow(
      /ranking.score/,
    );
    expect(() => assertEvaluationRecord({ ...r, ranking: { ...r.ranking, uncertainty: -1 } })).toThrow(
      /ranking.uncertainty/,
    );
  });

  it("refuses a number finer than the digest can write", () => {
    const r = record();
    expect(() => assertEvaluationRecord({ ...r, ranking: { ...r.ranking, score: 0.1234567890 } })).toThrow(
      /six decimal places/,
    );
  });

  it("hashes the record, not the order its keys were written in", () => {
    const r = record();
    const reshuffled = JSON.parse(
      Object.entries(r)
        .reverse()
        .reduce((acc, [k, v]) => `${acc}"${k}":${JSON.stringify(v)},`, "{")
        .replace(/,$/, "}"),
    ) as EvaluationRecord;
    expect(evaluationRecordDigest(reshuffled)).toBe(evaluationRecordDigest(r));
  });

  it("changes the digest when the score changes", () => {
    const r = record();
    const moved = { ...r, ranking: { ...r.ranking, score: 0.87 } };
    expect(evaluationRecordDigest(moved)).not.toBe(evaluationRecordDigest(r));
  });

  it("leaves the numbers alone for readers and fixes them only for hashing", () => {
    const r = record();
    const canonical = canonicalEvaluationRecord(r) as { ranking: { score: unknown; uncertainty: unknown } };
    expect(typeof canonical.ranking.score).toBe("string");
    expect(canonical.ranking.score).toBe("0.880000");
    expect(r.ranking.score).toBe(0.88);
  });

  it("omits a score it was never given rather than inventing zero", () => {
    const r = record();
    const bare = { ...r, ranking: { ...r.ranking, score: undefined, uncertainty: undefined } };
    const canonical = canonicalEvaluationRecord(bare) as { ranking: Record<string, unknown> };
    expect(canonical.ranking.score).toBeUndefined();
    expect(canonical.ranking.uncertainty).toBeUndefined();
  });
});

describe("the replayability vocabulary", () => {
  /**
   * ADR-0013 owns the durable word; this record borrows a wire word for it.
   *
   * `generation-attested` means the artifact, logs, signature and seat votes all replay and
   * only generation does not. Translating that to `nondeterministic` would tell a reader
   * there is nothing to re-check, which is the lie the ADR was written to stop.
   */
  it("maps the recorded class to the wire value exactly", () => {
    expect(replayabilityFromClass("artifact-replayable")).toBe("deterministic");
    expect(replayabilityFromClass("generation-attested")).toBe("partial");
    expect(replayabilityFromClass("undecided")).toBe("nondeterministic");
  });
});
