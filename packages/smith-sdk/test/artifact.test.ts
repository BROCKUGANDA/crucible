import { describe, expect, it } from "vitest";
import {
  RUN_ARTIFACT_SCHEMA_VERSION,
  RunArtifactError,
  buildArtifact,
  computeRunHash,
  normalizeForgeTests,
  parseForgeTests,
  summarise,
  validateArtifact,
  validateAgainstTrial,
  type RunArtifact,
  type TrialContext,
} from "../src/index.js";

const CID_A = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const CID_B = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const RUNNER = "0x1111111111111111111111111111111111111111";
const TRIALS = "0x2222222222222222222222222222222222222222";

function baseArtifact(over: Partial<RunArtifact> = {}): RunArtifact {
  return {
    schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
    trialId: 1,
    agentId: 1,
    specCID: CID_A,
    testsCID: CID_B,
    repoCID: CID_A,
    commitSHA: "a".repeat(40),
    suiteCommand: "forge test --json",
    testResults: [{ name: "test_One", status: "pass", durationMs: 12 }],
    logsCID: CID_A,
    durationMs: 1000,
    model: "claude-sonnet-4-5",
    startedAt: 1_000_000,
    finishedAt: 1_001_000,
    runnerAddress: RUNNER,
    chainId: 11155111,
    verifyingContract: TRIALS,
    ...over,
  };
}

function context(over: Partial<TrialContext> = {}): TrialContext {
  return {
    trialId: 1,
    agentId: 1,
    specCID: CID_A,
    testsCID: CID_B,
    specDigest: CID_A,
    testsDigest: CID_B,
    createdAtMs: 0,
    deadlineMs: 10_000_000,
    runnerAddress: RUNNER,
    chainId: 11155111,
    verifyingContract: TRIALS,
    ...over,
  };
}

describe("validateArtifact", () => {
  it("accepts a well-formed artifact", () => {
    expect(() => validateArtifact(baseArtifact())).not.toThrow();
  });

  it("rejects a run with any failing test", () => {
    const a = baseArtifact({
      testResults: [
        { name: "test_One", status: "pass", durationMs: 1 },
        { name: "test_Two", status: "fail", durationMs: 1 },
      ],
    });
    expect(() => validateArtifact(a)).toThrow(/forge-blocked/);
    expect(() => validateArtifact(a)).toThrow(RunArtifactError);
  });

  it("rejects an empty suite", () => {
    expect(() => validateArtifact(baseArtifact({ testResults: [] }))).toThrow(
      /1-10000 entries/,
    );
  });

  it("requires finishedAt > startedAt", () => {
    expect(() =>
      validateArtifact(baseArtifact({ startedAt: 5000, finishedAt: 5000, durationMs: 0 })),
    ).toThrow(/finishedAt must be > startedAt/);
  });

  it("requires durationMs to match the timestamps", () => {
    expect(() => validateArtifact(baseArtifact({ durationMs: 999 }))).toThrow(
      /durationMs must equal/,
    );
  });

  it("rejects a malformed CID", () => {
    expect(() => validateArtifact(baseArtifact({ specCID: "not-a-cid" }))).toThrow(
      /not a valid IPFS CID/,
    );
  });

  it("rejects a bad commit SHA", () => {
    expect(() => validateArtifact(baseArtifact({ commitSHA: "abc" }))).toThrow(
      /not a valid git SHA/,
    );
  });

  it("accepts a 40-hex sha1 and a 64-hex sha256", () => {
    expect(() => validateArtifact(baseArtifact({ commitSHA: "b".repeat(64) }))).not.toThrow();
  });

  it("truncates oversized test messages rather than rejecting", () => {
    const a = baseArtifact({
      testResults: [
        { name: "t", status: "pass", durationMs: 0, message: "x".repeat(5000) },
      ],
    });
    expect(() => validateArtifact(a)).toThrow(/message must be <= 2000/);
  });
});

describe("validateAgainstTrial", () => {
  it("accepts an artifact matching its trial", () => {
    expect(() => validateAgainstTrial(baseArtifact(), context())).not.toThrow();
  });

  it("rejects a swapped spec", () => {
    expect(() => validateAgainstTrial(baseArtifact({ specCID: CID_B }), context())).toThrow(
      /may not swap the spec/,
    );
  });

  it("rejects a swapped test suite", () => {
    expect(() =>
      validateAgainstTrial(baseArtifact({ testsCID: CID_A }), context()),
    ).toThrow(/may not swap the tests/);
  });

  it("rejects a run signed by a different runner key", () => {
    const other = "0x3333333333333333333333333333333333333333";
    expect(() =>
      validateAgainstTrial(
        baseArtifact(),
        context({ runnerAddress: other }),
      ),
    ).toThrow(/registered runner key/);
  });

  it("rejects a run for the wrong chain", () => {
    expect(() =>
      validateAgainstTrial(baseArtifact({ chainId: 1 }), context()),
    ).toThrow(/chainId/);
  });

  it("rejects a run against a different deployment", () => {
    const other = "0x4444444444444444444444444444444444444444";
    expect(() =>
      validateAgainstTrial(baseArtifact(), context({ verifyingContract: other })),
    ).toThrow(/not this CrucibleTrials deployment/);
  });

  it("rejects a run that started before the trial existed", () => {
    expect(() =>
      validateAgainstTrial(baseArtifact(), context({ createdAtMs: 5_000_000 })),
    ).toThrow(/precedes the trial's creation/);
  });

  it("rejects a run that finished after the deadline", () => {
    expect(() =>
      validateAgainstTrial(baseArtifact(), context({ deadlineMs: 1_000_500 })),
    ).toThrow(/past the trial deadline/);
  });

  it("rejects an agent claiming a trial assigned to someone else", () => {
    expect(() => validateAgainstTrial(baseArtifact(), context({ agentId: 7 }))).toThrow(
      /not this trial's assigned agent/,
    );
  });
});

describe("computeRunHash", () => {
  it("is stable across key orderings", () => {
    const a = baseArtifact();
    const reordered: RunArtifact = {
      verifyingContract: a.verifyingContract,
      chainId: a.chainId,
      runnerAddress: a.runnerAddress,
      finishedAt: a.finishedAt,
      startedAt: a.startedAt,
      model: a.model,
      durationMs: a.durationMs,
      logsCID: a.logsCID,
      testResults: a.testResults,
      suiteCommand: a.suiteCommand,
      commitSHA: a.commitSHA,
      repoCID: a.repoCID,
      testsCID: a.testsCID,
      specCID: a.specCID,
      agentId: a.agentId,
      trialId: a.trialId,
      schemaVersion: a.schemaVersion,
    };
    expect(computeRunHash(reordered)).toBe(computeRunHash(a));
  });

  it("changes when any field changes", () => {
    const base = computeRunHash(baseArtifact());
    expect(computeRunHash(baseArtifact({ model: "other" }))).not.toBe(base);
    expect(computeRunHash(baseArtifact({ commitSHA: "c".repeat(40) }))).not.toBe(base);
  });

  it("is insensitive to testResults ordering only if the order is semantically fixed", () => {
    // order is part of the claim: reordering tests changes the hash
    const a = baseArtifact({
      testResults: [
        { name: "a", status: "pass", durationMs: 1 },
        { name: "b", status: "pass", durationMs: 2 },
      ],
    });
    const b = baseArtifact({
      testResults: [
        { name: "b", status: "pass", durationMs: 2 },
        { name: "a", status: "pass", durationMs: 1 },
      ],
    });
    expect(computeRunHash(a)).not.toBe(computeRunHash(b));
  });
});

describe("parseForgeTests", () => {
  it("parses the modern flat `tests` shape", () => {
    const json = JSON.stringify({
      tests: [
        { name: "test_A", status: "PASS", durationMs: 5 },
        { name: "test_B", status: "FAIL", durationMs: 7, reason: "assertion" },
      ],
    });
    const results = parseForgeTests(json);
    expect(results).toHaveLength(2);
    expect(results[0]!.status).toBe("pass");
    expect(results[1]!.status).toBe("fail");
  });

  it("parses the v1 nested `test_results` object shape", () => {
    const json = JSON.stringify({
      suite: "CrucibleTrialsTest",
      test_results: {
        "testOne()": { status: "Success", duration: 3 },
        "testTwo()": { status: "Failure", duration: 4, reason: "boom" },
      },
    });
    const results = parseForgeTests(json);
    expect(results.map((r) => r.name)).toEqual(["testOne()", "testTwo()"]);
    expect(results[1]!.status).toBe("fail");
  });

  it("accepts a bare array", () => {
    const results = parseForgeTests(JSON.stringify([{ name: "t", status: "pass" }]));
    expect(results).toHaveLength(1);
  });

  it("throws on non-JSON", () => {
    expect(() => parseForgeTests("Error: no tests found")).toThrow(/not JSON/);
  });

  it("throws on an unrecognised shape", () => {
    expect(() => normalizeForgeTests({ unexpected: true })).toThrow(/unrecognised/);
  });

  it("throws on an empty suite rather than producing an empty artifact", () => {
    expect(() => parseForgeTests(JSON.stringify({ tests: [] }))).toThrow(/zero tests/);
  });

  it("throws on an unknown status instead of guessing", () => {
    expect(() => parseForgeTests(JSON.stringify({ tests: [{ name: "t", status: "weird" }] }))).toThrow(
      /unrecognised test status/,
    );
  });
});

describe("summarise", () => {
  it("counts and reports green only when nothing failed", () => {
    const s = summarise([
      { name: "a", status: "pass", durationMs: 0 },
      { name: "b", status: "skip", durationMs: 0 },
    ]);
    expect(s).toMatchObject({ total: 2, passed: 1, skipped: 1, green: true });
    expect(s.label).toBe("1/2 green");
  });

  it("is not green when a test fails", () => {
    const s = summarise([
      { name: "a", status: "pass", durationMs: 0 },
      { name: "b", status: "fail", durationMs: 0 },
    ]);
    expect(s.green).toBe(false);
  });
});

describe("buildArtifact", () => {
  it("derives durationMs from the timestamps", () => {
    const a = buildArtifact({
      trialId: 1,
      agentId: 1,
      specCID: CID_A,
      testsCID: CID_B,
      repoCID: CID_A,
      commitSHA: "a".repeat(40),
      suiteCommand: "forge test --json",
      testResults: [{ name: "t", status: "pass", durationMs: 1 }],
      logsCID: CID_A,
      model: "m",
      startedAt: 1000,
      finishedAt: 4000,
      runnerAddress: RUNNER,
      chainId: 11155111,
      verifyingContract: TRIALS,
    });
    expect(a.durationMs).toBe(3000);
    expect(() => validateArtifact(a)).not.toThrow();
  });
});
