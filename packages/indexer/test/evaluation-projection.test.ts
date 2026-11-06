import { describe, expect, it } from "vitest";
import { isAddress, type Address, type Hex } from "viem";
import { evaluationIdOf, type EvaluationRecord } from "@crucible/smith";
import {
  projectEvaluationRecord,
  projectEvaluationRecords,
  type EvaluationProjectionInput,
} from "../src/evaluation-projection.js";

const FUNDER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const RUNNER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
const IMPERSONATOR = "0x15D38573d2341afB722a5AaFcAB45B2dFe2E9a25" as Address;
const RUN_HASH = `0x${"9c".repeat(32)}` as Hex;
const MANIFEST_DIGEST = `0x${"11".repeat(32)}` as Hex;
const REPORT_DIGEST = `0x${"55".repeat(32)}` as Hex;
const TX = `0x${"5d".repeat(32)}` as Hex;

function input(over: Partial<EvaluationProjectionInput> = {}): EvaluationProjectionInput {
  return {
    run: {
      chainId: 31337,
      trialId: 14,
      agentId: 3,
      funderId: FUNDER,
      registeredRunner: RUNNER,
      runSigner: RUNNER,
      runHash: RUN_HASH,
      transactionHash: TX,
      blockNumber: 428,
      timestamp: 1_793_923_200_000,
    },
    evidence: {
      manifestCid: "bafkreihmanifest",
      manifestDigest: MANIFEST_DIGEST,
      manifestDigestOk: true,
      reportCid: "bafkreigreport",
      reportDigest: REPORT_DIGEST,
      reportDigestOk: true,
    },
    report: {
      verdict: "agent-wins",
      phase: "deterministic",
      replayabilityClass: "artifact-replayable",
      evaluatorVersion: "1.4.0",
      imageDigest: "sha256:aaaa",
      createdAt: "2026-11-06T04:30:00Z",
      reportVersion: 1,
    },
    ...over,
  };
}

describe("a clean run", () => {
  it("projects an eligible record whose id is its own identity", () => {
    const record = projectEvaluationRecord(input())!;
    expect(record.ranking.eligible).toBe(true);
    expect(record.ranking.exclusionReasons).toEqual([]);
    expect(record.evaluationId).toBe(evaluationIdOf({ chainId: 31337, trialId: 14, runHash: RUN_HASH }));
    expect(record.evidence.verificationReportDigest).toBe(REPORT_DIGEST);
    expect(record.verification.evaluatorImageDigest).toBe("sha256:aaaa");
    expect(isAddress(record.identity.runner)).toBe(true);
  });

  it("carries the cohort and the measurement when the caller has them", () => {
    const record = projectEvaluationRecord(
      input({ ranking: { cohortId: "swe-bench-verified-2026", score: 0.88, uncertainty: 0.02 } }),
    )!;
    expect(record.ranking.cohortId).toBe("swe-bench-verified-2026");
    expect(record.ranking.score).toBe(0.88);
    expect(record.ranking.uncertainty).toBe(0.02);
  });

  /**
   * "Unknown" is not zero.
   *
   * A leaderboard that filled a missing score with 0 ranks the unmeasured above the honest
   * failure, and this repository already refuses that shape for every figure it prints.
   */
  it("leaves a measurement it was not given absent rather than zero", () => {
    const record = projectEvaluationRecord(input())!;
    expect("score" in record.ranking).toBe(false);
    expect("uncertainty" in record.ranking).toBe(false);
    expect("cohortId" in record.ranking).toBe(false);
  });
});

describe("absence is not an exclusion", () => {
  it("projects nothing when the verification was never published", () => {
    expect(projectEvaluationRecord(input({ report: null }))).toBeNull();
  });

  it("projects nothing when the manifest cannot be resolved", () => {
    expect(
      projectEvaluationRecord(input({ evidence: { ...input().evidence, manifestCid: null } })),
    ).toBeNull();
    expect(
      projectEvaluationRecord(input({ evidence: { ...input().evidence, manifestDigest: null } })),
    ).toBeNull();
  });

  it("projects nothing when there is no runner key to attribute the run to", () => {
    expect(
      projectEvaluationRecord(input({ run: { ...input().run, registeredRunner: null, runSigner: null } })),
    ).toBeNull();
  });

  it("still projects a row when the bytes exist but do not check out", () => {
    const record = projectEvaluationRecord(
      input({ evidence: { ...input().evidence, manifestDigestOk: false } }),
    )!;
    expect(record.ranking.eligible).toBe(false);
    expect(record.ranking.exclusionReasons).toContain("MANIFEST_DIGEST_MISMATCH");
  });
});

describe("the exclusion reasons this layer can actually see", () => {
  it("names a report whose bytes do not match its digest", () => {
    const record = projectEvaluationRecord(
      input({ evidence: { ...input().evidence, reportDigestOk: false } }),
    )!;
    expect(record.ranking.exclusionReasons).toContain("REPORT_DIGEST_MISMATCH");
    expect(record.ranking.eligible).toBe(false);
  });

  it("names a run signed by a key the agent never registered", () => {
    const record = projectEvaluationRecord(input({ run: { ...input().run, runSigner: IMPERSONATOR } }))!;
    expect(record.ranking.exclusionReasons).toContain("IDENTITY_MISMATCH");
  });

  it("names an agent with no runner on file, and attributes the row to the signer it does have", () => {
    const record = projectEvaluationRecord(input({ run: { ...input().run, registeredRunner: null } }))!;
    expect(record.ranking.exclusionReasons).toContain("RUNNER_UNREGISTERED");
    expect(record.identity.runner).toBe(RUNNER);
  });

  it("names evidence that was swapped after the fact", () => {
    const record = projectEvaluationRecord(input({ evidence: { ...input().evidence, tampered: true } }))!;
    expect(record.ranking.exclusionReasons).toContain("TAMPERED_EVIDENCE");
  });

  it("excludes an abstention and a successful break, and never the other way round", () => {
    const abstain = projectEvaluationRecord(
      input({ report: { ...input().report!, verdict: "abstain", phase: "abstain" } }),
    )!;
    expect(abstain.ranking.exclusionReasons).toContain("VERDICT_ABSTAIN");
    expect(abstain.ranking.eligible).toBe(false);

    const broken = projectEvaluationRecord(input({ report: { ...input().report!, verdict: "break-wins" } }))!;
    expect(broken.ranking.exclusionReasons).toContain("VERDICT_BREAK_WINS");
    expect(broken.ranking.eligible).toBe(false);
  });

  it("adds a caller's reason without letting it hide the verdict's", () => {
    const record = projectEvaluationRecord(
      input({
        report: { ...input().report!, verdict: "break-wins" },
        ranking: { reasons: ["COHORT_INCOMPATIBLE"] },
      }),
    )!;
    expect(record.ranking.exclusionReasons).toEqual(
      expect.arrayContaining(["COHORT_INCOMPATIBLE", "VERDICT_BREAK_WINS"]),
    );
  });

  it("lists each reason once however many paths arrived at it", () => {
    const record = projectEvaluationRecord(
      input({
        evidence: { ...input().evidence, tampered: true, reportDigestOk: false },
        ranking: { reasons: ["TAMPERED_EVIDENCE"] },
      }),
    )!;
    const seen = record.ranking.exclusionReasons;
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("the record never invents its own verdict", () => {
  it("copies the verifier's words rather than deriving them from the outcome", () => {
    const rubric = projectEvaluationRecord(
      input({
        report: {
          ...input().report!,
          verdict: "agent-wins",
          phase: "rubric",
          replayabilityClass: "generation-attested",
        },
      }),
    )!;
    expect(rubric.verification.replayability).toBe("partial");
    expect(rubric.verification.phase).toBe("rubric");
    expect(rubric.verification.verdict).toBe("agent-wins");
  });

  /**
   * ADR-0011's purity clause, asserted structurally.
   *
   * Money and benchmark are separate projections. The strongest cheap check that they stay
   * that way is that no field of this document is named for value: a future "rewardWei" added
   * to a record would mean an evaluation now carries an amount, which is the exact route by
   * which a payout could be mistaken for a score.
   */
  it("has no field that money can move", () => {
    const record = projectEvaluationRecord(
      input({ ranking: { cohortId: "c", score: 0.5, uncertainty: 0.1 } }),
    )!;
    const keys = JSON.stringify(record, (key, value) => (key === "" || /^[a-z]/.test(key) ? value : undefined))
      .match(/"[a-zA-Z]+":/g)!
      .map((k) => k.replace(/[":]/g, ""));
    for (const forbidden of ["reward", "wei", "bond", "stake", "payout", "fee", "balance", "amount"]) {
      expect(keys.filter((k) => k.toLowerCase().includes(forbidden))).toEqual([]);
    }
  });
});

describe("the projection is a fold, not a writer", () => {
  it("is a pure function of the inputs: no clock, no counter, no order luck", () => {
    const a = projectEvaluationRecord(input())!;
    const b = projectEvaluationRecord(input())!;
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("orders the map by chain position and run hash, whatever order it was handed", () => {
    const second = input({
      run: { ...input().run, trialId: 15, runHash: `0x${"bb".repeat(32)}` as Hex, blockNumber: 900 },
    });
    const first = input({ run: { ...input().run, trialId: 14, runHash: `0x${"aa".repeat(32)}` as Hex, blockNumber: 500 } });

    const forward = [...projectEvaluationRecords([first, second]).values()];
    const backward = [...projectEvaluationRecords([second, first]).values()];
    expect(forward.map((r) => r.identity.trialId)).toEqual([14, 15]);
    expect(backward.map((r) => r.identity.trialId)).toEqual([14, 15]);
  });

  it("keys the map by the lowercased id so a caller cannot miss a row on casing", () => {
    const record = projectEvaluationRecord(input())!;
    const map = projectEvaluationRecords([input()]);
    expect([...map.keys()]).toEqual([record.evaluationId.toLowerCase() as Hex]);
    expect(map.get(record.evaluationId.toLowerCase() as Hex)).toEqual(record as EvaluationRecord);
  });

  it("skips the runs with nothing bound without disturbing the ones that have", () => {
    const good = input();
    const unverified = input({
      run: { ...input().run, trialId: 99, runHash: `0x${"cd".repeat(32)}` as Hex },
      report: null,
    });
    const map = projectEvaluationRecords([good, unverified]);
    expect(map.size).toBe(1);
  });
});
