import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CidStore, ContentBridge, DisclosureLog } from "@crucible/cidstore";
import { ContentService } from "@crucible/forge-runner";
import { computeRunHash, digestOfContent, type RunArtifact } from "@crucible/smith";
import { privateKeyToAccount } from "viem/accounts";
import { LiveVerifier, type RunFacts } from "../src/live.js";

/**
 * The verifier, supplied by the content layer instead of by a test.
 *
 * `packages/argus` was already fully tested and still could not run: every input that
 * touches the outside world — the artifact bytes, the re-executed suite, the recovered
 * signer — was handed in by the test itself. These cases replace those with real
 * resolution and real signatures, and keep only the container as a seam, because this
 * machine has no Docker daemon. Everything asserted here happens on both paths: content
 * lookup, digest reconstruction, signature recovery, and the diff against the re-run.
 */

 let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "crucible-live-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const RUNNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// Anvil's published dev key #2, deliberately a different one from the runner's above. It used to
// be a hex string made up for the test, which gitleaks is right to treat as a leaked credential:
// a 64-hex literal that appears nowhere public looks exactly like a key that escaped into a
// fixture. These two are on the allowlist because every account they control is publicly known
// and holds only test ETH.
const OTHER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const CONTRACT = "0x5fbdb2315678afecb367f032d93f642f63180aa3" as const;

async function harness(rerunNames: string[], opts: { tier?: 0 | 1 | 2 | 3 | 4 } = {}) {
  const root = path.join(dir, Math.random().toString(36).slice(2));
  const content = new ContentService({
    bridge: new ContentBridge({
      store: new CidStore({ dir: path.join(root, "store") }),
      disclosure: await DisclosureLog.open(path.join(root, "disclosure")),
      digestOf: digestOfContent,
    }),
  });

  const written: string[] = [];
  const bench = {
    repoDir: "/bench",
    async writeFile(rel: string) {
      written.push(rel);
      return rel;
    },
    async runSuite() {
      return {
        stdout: JSON.stringify({
          tests: rerunNames.map((name, i) => ({ name, status: "PASS", durationMs: i + 1 })),
        }),
        code: 0,
      };
    },
    async cleanup() {},
  };

  let seenSpec: import("@crucible/forge-runner").SandboxSpec | undefined;
  const verifier = new LiveVerifier({ content, tier: opts.tier, makeBench: async (spec) => { seenSpec = spec; return bench; } });
  return { content, verifier, written, benchSpec: () => seenSpec };
}

function artifactOf(runner: string, names: string[]): RunArtifact {
  return {
    schemaVersion: "1.0.0",
    trialId: 1,
    agentId: 7,
    specCID: "",
    testsCID: "",
    repoCID: "",
    commitSHA: "0".repeat(40),
    suiteCommand: "forge test --json",
    testResults: names.map((name) => ({ name, status: "pass", durationMs: 1 })),
    logsCID: "",
    durationMs: 1000,
    model: "test-model",
    startedAt: 1,
    finishedAt: 2,
    runnerAddress: runner as `0x${string}`,
    chainId: 31337,
    verifyingContract: CONTRACT,
  };
}

/** Publish spec, suite and repo, then wire the artifact's cids to what was pinned. */
async function publish(content: ContentService, a: RunArtifact) {
  const spec = await content.pinText("Make the counter refuse to wrap.");
  const suite = await content.pinSuite({ files: { "test/Suite.t.sol": "contract Suite {}" } });
  const repo = await content.uploadRepo({
    repoDir: "/x",
    async runSuite() {
      return { stdout: "src/Forge.sol", code: 0 };
    },
    async writeFile() {
      return "src/Forge.sol";
    },
  });
  const full: RunArtifact = {
    ...a,
    specCID: spec.cid,
    testsCID: suite.cid,
    repoCID: repo,
    logsCID: await content.uploadLogs("Ran 2 tests. 0 failed."),
  };
  return full;
}

async function signAndAnnounce(
  content: ContentService,
  verifier: LiveVerifier,
  facts: RunFacts,
  artifact: RunArtifact,
  key: string,
) {
  // The hash is the caller's, not recomputed here: it is what the chain recorded, and a
  // signature made over a different one is exactly the bug this file is testing for.
  const runHash = facts.runHash;
  const account = privateKeyToAccount(key as `0x${string}`);
  const digest = verifier.digestFor(facts, artifact);
  const signature = await account.signTypedData({
    domain: { name: "Crucible", version: "1", chainId: facts.chainId, verifyingContract: facts.verifyingContract },
    types: {
      Run: [
        { name: "trialId", type: "uint256" },
        { name: "agentId", type: "uint256" },
        { name: "runHash", type: "bytes32" },
        { name: "sigDeadline", type: "uint64" },
      ],
    },
    primaryType: "Run",
    message: { trialId: BigInt(facts.trialId), agentId: BigInt(artifact.agentId), runHash, sigDeadline: facts.sigDeadline },
  });
  await content.publishArtifact(artifact, runHash, signature, String(facts.sigDeadline));
  return runHash;
}

describe("verifying a run through the content layer", () => {
  it("resolves the artifact, recovers the registered signer, and reproduces the claim", async () => {
    const runner = privateKeyToAccount(RUNNER_KEY).address;
    const names = ["test_A", "test_B"];
    const { content, verifier, written } = await harness(names);
    const artifact = await publish(content, artifactOf(runner, names));
    const facts: RunFacts = {
      trialId: 1,
      agentId: 7,
      runHash: computeRunHash(artifact),
      sigDeadline: 1_800_000_000n,
      chainId: 31337,
      verifyingContract: CONTRACT,
      runner,
    };
    await signAndAnnounce(content, verifier, facts, artifact, RUNNER_KEY);

    const report = await verifier.verify(facts);
    expect(report.verdict).toBe("agent-wins");
    expect(report.steps.map((s) => s.name)).toEqual([
      "artifact-hash",
      "runner-binding",
      "signature",
      "claimed-suite-green",
      "rerun",
      "result-diff",
    ]);
    // Both halves came out of the store, by the ids the artifact names — that is the whole
    // content layer, and nothing else in this repo has ever proved it.
    expect(written).toContain("test/Suite.t.sol");
    expect(written).toContain("src/Forge.sol");
  });
  it("re-executes a frontier-tier claim in the tier sandbox envelope", async () => {
    const runner = privateKeyToAccount(RUNNER_KEY).address;
    const names = ["test_A"];
    const { content, verifier, benchSpec } = await harness(names, { tier: 4 });
    const artifact = await publish(content, artifactOf(runner, names));
    const facts: RunFacts = {
      trialId: 1,
      agentId: 7,
      runHash: computeRunHash(artifact),
      sigDeadline: 1_800_000_000n,
      chainId: 31337,
      verifyingContract: CONTRACT,
      runner,
    };
    await signAndAnnounce(content, verifier, facts, artifact, RUNNER_KEY);
    const report = await verifier.verify(facts);
    expect(report.verdict).toBe("agent-wins");
    expect(benchSpec()?.timeoutSec).toBe(3600);
    expect(benchSpec()?.memory).toBe("8192m");
  });


  it("calls a claim the bench cannot reproduce a lie", async () => {
    const runner = privateKeyToAccount(RUNNER_KEY).address;
    const { content, verifier } = await harness(["test_A"]);
    const artifact = await publish(content, artifactOf(runner, ["test_A", "test_B"])) as RunArtifact;
    const facts: RunFacts = {
      trialId: 1,
      agentId: 7,
      runHash: computeRunHash(artifact as RunArtifact),
      sigDeadline: 1_800_000_000n,
      chainId: 31337,
      verifyingContract: CONTRACT,
      runner,
    };
    await signAndAnnounce(content, verifier, facts, artifact, RUNNER_KEY);

    const report = await verifier.verify(facts);
    expect(report.verdict).toBe("break-wins");
    expect(report.reason).toMatch(/does not reproduce/);
  });

  it("refuses a run signed by a key the registry does not hold", async () => {
    const registered = privateKeyToAccount(RUNNER_KEY).address;
    const impostor = privateKeyToAccount(OTHER_KEY).address;
    const names = ["test_A"];
    const { content, verifier } = await harness(names);
    // The artifact claims the registered runner; the signature is made by somebody else.
    const artifact = await publish(content, artifactOf(registered, names));
    const facts: RunFacts = {
      trialId: 1,
      agentId: 7,
      runHash: computeRunHash(artifact as RunArtifact),
      sigDeadline: 1_800_000_000n,
      chainId: 31337,
      verifyingContract: CONTRACT,
      runner: registered,
    };
    await signAndAnnounce(content, verifier, facts, artifact, OTHER_KEY);

    const report = await verifier.verify(facts);
    expect(report.verdict).toBe("break-wins");
    expect(report.reason).toMatch(/signature does not match/);
    expect(impostor).not.toBe(registered);
  });

  it("abstains when nothing was ever announced for the run hash", async () => {
    const { verifier } = await harness(["test_A"]);
    const report = await verifier.verify({
      trialId: 1,
      agentId: 7,
      runHash: `0x${"ee".repeat(32)}`,
      sigDeadline: 1n,
      chainId: 31337,
      verifyingContract: CONTRACT,
      runner: privateKeyToAccount(RUNNER_KEY).address,
    });
    // Not "break-wins": a run nobody published is an absence of evidence, and the skeptic
    // carries the burden. Handing the challenger a win for a missing disclosure is the
    // failure mode ADR-0005 exists to prevent.
    expect(report.verdict).toBe("abstain");
    expect(report.steps[0]?.name).toBe("disclosure");
  });
});
