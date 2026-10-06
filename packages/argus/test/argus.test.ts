import { describe, expect, it } from "vitest";
import { RUN_ARTIFACT_SCHEMA_VERSION, computeRunHash, type RunArtifact } from "@crucible/smith";
import { Argus, parseVote, resolvePrecedence, runRubric, RubricError } from "../src/index.js";

const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const RUNNER = "0x1111111111111111111111111111111111111111" as const;

function artifact(over: Partial<RunArtifact> = {}): RunArtifact {
  return {
    schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
    trialId: 1,
    agentId: 1,
    specCID: CID,
    testsCID: CID,
    repoCID: CID,
    commitSHA: "a".repeat(40),
    suiteCommand: "forge test --json",
    testResults: [
      { name: "test_A", status: "pass", durationMs: 5 },
      { name: "test_B", status: "pass", durationMs: 6 },
    ],
    logsCID: CID,
    durationMs: 1000,
    model: "m",
    startedAt: 1000,
    finishedAt: 2000,
    runnerAddress: RUNNER,
    chainId: 31337,
    verifyingContract: "0x2222222222222222222222222222222222222222",
    ...over,
  };
}

function forgeJson(names: string[], status: "pass" | "fail" = "pass"): string {
  return JSON.stringify({
    tests: names.map((n, i) => ({ name: n, status: status === "pass" ? "PASS" : "FAIL", durationMs: i + 1 })),
  });
}

function input(over: Partial<Parameters<Argus["verifyDeterministic"]>[0]> = {}) {
  const a = artifact();
  return {
    trialId: 1,
    artifact: a,
    onChainRunHash: computeRunHash(a),
    digestFor: () => "0x" + "33".repeat(32) as `0x${string}`,
    recoverSigner: async () => RUNNER,
    sigDeadline: 12345n,
    signature: `0x${"44".repeat(65)}` as `0x${string}`,
    fetchArtifact: async () => a,
    expectedRunner: RUNNER,
    rerunSuite: async () => forgeJson(["test_A", "test_B"]),
    ...over,
  } as Parameters<Argus["verifyDeterministic"]>[0];
}

describe("Argus deterministic phase", () => {
  it("upholds a run the pinned suite reproduces exactly", async () => {
    const r = await new Argus().verifyDeterministic(input());
    expect(r.verdict).toBe("agent-wins");
    expect(r.phase).toBe("deterministic");
    expect(r.steps.every((s) => s.passed)).toBe(true);
  });

  it("breaks a run whose artifact does not match its committed hash", async () => {
    const r = await new Argus().verifyDeterministic(
      input({ onChainRunHash: "0x" + "ff".repeat(32) as `0x${string}` }),
    );
    expect(r.verdict).toBe("break-wins");
    expect(r.steps[0]!.name).toBe("artifact-hash");
  });

  it("never re-runs the suite once the hash check fails", async () => {
    let ran = 0;
    await new Argus().verifyDeterministic(
      input({
        onChainRunHash: "0x" + "ff".repeat(32) as `0x${string}`,
        rerunSuite: async () => {
          ran += 1;
          return forgeJson(["test_A", "test_B"]);
        },
      }),
    );
    expect(ran).toBe(0);
  });

  it("breaks a run signed by an unregistered key", async () => {
    const r = await new Argus().verifyDeterministic(
      input({ expectedRunner: "0x9999999999999999999999999999999999999999" }),
    );
    expect(r.verdict).toBe("break-wins");
    expect(r.steps.map((s) => s.name)).toContain("runner-binding");
  });

  it("breaks a run whose signature recovers to a different address", async () => {
    const r = await new Argus().verifyDeterministic(
      input({ recoverSigner: async () => "0x8888888888888888888888888888888888888888" }),
    );
    expect(r.verdict).toBe("break-wins");
    expect(r.steps.map((s) => s.name)).toContain("signature");
  });

  it("breaks a run that was not green to begin with", async () => {
    const a = artifact({
      testResults: [{ name: "test_A", status: "fail", durationMs: 1 }],
    });
    const r = await new Argus().verifyDeterministic(
      input({ artifact: a, onChainRunHash: computeRunHash(a) }),
    );
    expect(r.verdict).toBe("break-wins");
    expect(r.steps.map((s) => s.name)).toContain("claimed-suite-green");
  });

  it("breaks a run that claims tests the pinned suite does not reproduce", async () => {
    const r = await new Argus().verifyDeterministic(
      input({ rerunSuite: async () => forgeJson(["test_A"]) }),
    );
    expect(r.verdict).toBe("break-wins");
    expect(r.reason).toMatch(/does not reproduce/);
  });

  it("breaks a run that omits tests the pinned suite actually runs", async () => {
    const r = await new Argus().verifyDeterministic(
      input({ rerunSuite: async () => forgeJson(["test_A", "test_B", "test_Sneaky"]) }),
    );
    expect(r.verdict).toBe("break-wins");
    expect(r.reason).toMatch(/omitted from its claim/);
  });

  it("ignores duration differences, which vary legitimately between runs", async () => {
    const r = await new Argus().verifyDeterministic(
      input({ rerunSuite: async () => forgeJson(["test_A", "test_B"]) }),
    );
    expect(r.verdict).toBe("agent-wins");
  });

  it("abstains rather than siding with the skeptic when the re-run cannot execute", async () => {
    const r = await new Argus().verifyDeterministic(
      input({
        rerunSuite: async () => {
          throw new Error("container unavailable");
        },
      }),
    );
    expect(r.verdict).toBe("abstain");
    expect(r.phase).toBe("abstain");
  });

  it("abstains when the re-run yields no parseable results", async () => {
    const r = await new Argus().verifyDeterministic(
      input({ rerunSuite: async () => "Error: could not compile" }),
    );
    expect(r.verdict).toBe("abstain");
  });
});

describe("needsRubric", () => {
  it("is true only for a clean abstain", async () => {
    const argus = new Argus();
    const aborted = await argus.verifyDeterministic(
      input({
        rerunSuite: async () => {
          throw new Error("down");
        },
      }),
    );
    expect(await argus.needsRubric(aborted)).toBe(true);

    const decided = await argus.verifyDeterministic(input());
    expect(await argus.needsRubric(decided)).toBe(false);
  });
});

describe("parseVote", () => {
  it("accepts a fenced JSON answer", () => {
    const v = parseVote("j1", '```json\n{"breakWins":true,"reason":"fails req 2"}\n```');
    expect(v).toMatchObject({ judgeId: "j1", breakWins: true, reason: "fails req 2" });
  });

  it("throws on non-JSON rather than defaulting to a pass", () => {
    expect(() => parseVote("j1", "I think it's fine")).toThrow(RubricError);
  });

  it("throws when breakWins is not a boolean", () => {
    expect(() => parseVote("j1", '{"breakWins":"yes"}')).toThrow(/boolean/);
  });
});

describe("runRubric", () => {
  const judges = (answers: string[]) =>
    answers.map((a, i) => ({ id: `j${i + 1}`, judge: async () => a }));

  it("resolves a 2-of-3 majority for the break", async () => {
    const out = await runRubric({
      judges: judges([
        '{"breakWins":true,"reason":"a"}',
        '{"breakWins":true,"reason":"b"}',
        '{"breakWins":false,"reason":"c"}',
      ]),
      spec: "s",
      artifactJson: "{}",
    });
    expect(out.resolved).toBe(true);
    expect(out.breakWins).toBe(true);
    expect(out.agreeCount).toBe(2);
  });

  it("does not resolve a split vote", async () => {
    const out = await runRubric({
      judges: judges([
        '{"breakWins":true,"reason":"a"}',
        '{"breakWins":false,"reason":"b"}',
        '{"breakWins":true,"reason":"c"}',
      ]),
      spec: "s",
      artifactJson: "{}",
    });
    expect(out.agreeCount).toBe(2);
    expect(out.breakWins).toBe(true);
  });

  it("abstains when two judges error, never counting them as agreement", async () => {
    const out = await runRubric({
      judges: [
        { id: "j1", judge: async () => '{"breakWins":false,"reason":"ok"}' },
        { id: "j2", judge: async () => { throw new Error("rate limited"); } },
        { id: "j3", judge: async () => { throw new Error("rate limited"); } },
      ],
      spec: "s",
      artifactJson: "{}",
    });
    expect(out.agreeCount).toBe(1);
    expect(out.resolved).toBe(false);
  });

  it("refuses fewer than three judges", async () => {
    await expect(
      runRubric({
        judges: [{ id: "j1", judge: async () => '{"breakWins":false}' }],
        spec: "s",
        artifactJson: "{}",
      }),
    ).rejects.toThrow(/three judges/);
  });
});

describe("resolvePrecedence", () => {
  it("lets a deterministic break stand even against a rubric majority for the agent", () => {
    const r = resolvePrecedence({
      deterministic: { verdict: "break-wins" },
      rubric: { breakWins: false, votes: [], agreeCount: 2, resolved: true, reason: "" },
    });
    expect(r).toEqual({ breakWins: true, source: "deterministic" });
  });

  it("lets a deterministic pass stand even against a rubric majority for the break", () => {
    const r = resolvePrecedence({
      deterministic: { verdict: "agent-wins" },
      rubric: { breakWins: true, votes: [], agreeCount: 2, resolved: true, reason: "" },
    });
    expect(r).toEqual({ breakWins: false, source: "deterministic" });
  });

  it("defers to the rubric only on a clean abstain", () => {
    const r = resolvePrecedence({
      deterministic: { verdict: "abstain" },
      rubric: { breakWins: true, votes: [], agreeCount: 3, resolved: true, reason: "" },
    });
    expect(r).toEqual({ breakWins: true, source: "rubric" });
  });

  it("abstains when the rubric did not resolve either", () => {
    const r = resolvePrecedence({
      deterministic: { verdict: "abstain" },
      rubric: { breakWins: true, votes: [], agreeCount: 1, resolved: false, reason: "" },
    });
    expect(r).toEqual({ breakWins: false, source: "abstain" });
  });
});
