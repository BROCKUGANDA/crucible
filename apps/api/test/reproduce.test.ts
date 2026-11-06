import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAddress, hashTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalize } from "json-canonicalize";
import {
  RUN_PRIMARY_TYPE,
  RUN_TYPES,
  computeRunHash,
  domainFor,
  manifestDigest,
  verificationReportDigest,
  type RunArtifact,
} from "@crucible/smith";
import { CidStore, DisclosureLog, VerificationReportStore } from "@crucible/cidstore";
import { reproduceRoutes, type ReproduceDeps } from "../src/reproduce.js";

/**
 * `GET /reproduce/:trialId`, against a node that is a function and a store that is real.
 *
 * The signature step is exercised with an actual EIP-712 signature produced by `viem` over the
 * same domain and types the contract uses. Faking the recovery would test this file's plumbing
 * and nothing else: the one thing a reader of this endpoint is buying is that the address we
 * name is the address the signature recovers to, and that claim is worth exactly as much as the
 * crypto behind it.
 *
 * Every step has a case that turns it red, and the cases are separated by which fact is wrong —
 * bytes, signature, manifest, report — because a response that lumps them into one "failed"
 * boolean would send a skeptic to the wrong repair.
 */

const SPONSOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const CONTRACT = getAddress("0x5fbdb2315678afecb367f032d93f642f63180aa3") as Address;
const CHAIN_ID = 31337;
const TRIAL_ID = 14;
const AGENT_ID = 3n;

// Anvil's key #0 is the registered runner; #1 is somebody else entirely.
const RUNNER_ACCOUNT = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const STRANGER_ACCOUNT = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

const SIG_DEADLINE = "1900000000";

function artifact(over: Partial<RunArtifact> = {}): RunArtifact {
  return {
    schemaVersion: 1,
    trialId: TRIAL_ID,
    agentId: Number(AGENT_ID),
    specCID: "bafkreihspec",
    testsCID: "bafkreihtests",
    repoCID: "bafkreihrepo",
    commitSHA: "8f3a1c2",
    suiteCommand: "npm test",
    testResults: [
      { name: "a", passed: true },
      { name: "b", passed: true },
      { name: "c", passed: false },
    ],
    logsCID: "bafkreihlogs",
    durationMs: 41_000,
    model: "qwen3-35b",
    startedAt: 1_793_923_000,
    finishedAt: 1_793_923_041,
    runnerAddress: RUNNER_ACCOUNT.address,
    chainId: CHAIN_ID,
    verifyingContract: CONTRACT,
    ...over,
  } as RunArtifact;
}

function manifest() {
  return {
    schemaVersion: 1,
    taskDigest: `0x${"11".repeat(32)}`,
    suiteDigest: `0x${"22".repeat(32)}`,
    evaluator: { id: "argus", version: "1.4.0", rubricVersion: "3" },
    model: { provider: "hetzner", name: "qwen", version: "Qwen/Qwen3.6-35B-A3B" },
    environment: { imageDigest: `crucible/verifier@sha256:${"a".repeat(64)}` },
    seed: "panel-2026-10-27",
    scoring: { feeSchedule: "legacy-v1", feeScheduleVersion: "1", decision: "deterministic-suite" },
    startedAt: "2026-10-27T12:00:00.000Z",
    finishedAt: "2026-10-27T12:00:41.000Z",
  };
}

function reportEnvelope(runHash: Hex) {
  return {
    schemaVersion: 1,
    runHash,
    reportVersion: 1,
    evaluator: { name: "argus" as const, version: "1.4.0", imageDigest: "sha256:aaaa" },
    result: {
      verdict: "agent-wins" as const,
      phase: "deterministic" as const,
      steps: [{ name: "artifact-hash", passed: true }],
      reason: "the pinned suite ran green against the artifact",
    },
    createdAt: "2026-11-06T04:30:00Z",
  };
}

interface Fixture {
  deps: ReproduceDeps;
  store: CidStore;
  reports: VerificationReportStore;
  runHash: Hex;
  cleanup: () => Promise<void>;
}

async function fixture(opts: {
  /** Bytes the disclosure points at, when they are not the artifact the chain hashed. */
  announceArtifact?: RunArtifact;
  /** Signature to publish; null omits the field entirely. */
  signature?: Hex | null;
  signer?: ReturnType<typeof privateKeyToAccount>;
  manifestOver?: () => unknown;
  pinReport?: boolean;
  maxBytes?: number;
} = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "crucible-reproduce-"));
  const store = new CidStore({ dir: join(dir, "store"), maxBytes: opts.maxBytes });
  const disclosure = await DisclosureLog.open(dir);
  const reports = new VerificationReportStore(store);

  const trueArtifact = artifact();
  const runHash = computeRunHash(trueArtifact);
  const announced = opts.announceArtifact ?? trueArtifact;
  const artifactCid = store.putJson(announced);

  const signer = opts.signer ?? RUNNER_ACCOUNT;
  const signature =
    opts.signature === null
      ? undefined
      : await signer.signTypedData({
          domain: domainFor(CONTRACT, CHAIN_ID),
          primaryType: RUN_PRIMARY_TYPE,
          types: RUN_TYPES,
          message: {
            trialId: BigInt(TRIAL_ID),
            agentId: AGENT_ID,
            runHash,
            sigDeadline: BigInt(SIG_DEADLINE),
          },
        });

  const m = opts.manifestOver?.() ?? manifest();
  const manifestCid = store.putJson(m);
  await disclosure.announceArtifact(runHash, {
    cid: artifactCid,
    ...(signature ? { signature } : {}),
    sigDeadline: SIG_DEADLINE,
  });
  // The announced digest is taken from the *honest* manifest even when different bytes are
  // pinned: that is what a poisoned pointer looks like. Announcing the digest of whatever happens
  // to be pinned makes the two agree by construction and the check unbreakable — which is exactly
  // how this file's first draft passed a test that could not fail.
  await disclosure.announceManifest(runHash, { cid: manifestCid, digest: manifestDigest(manifest() as never) });

  if (opts.pinReport !== false) reports.append(reportEnvelope(runHash) as never);

  const chain = {
    trial: async () => ({ agentId: AGENT_ID, runHash, sponsor: SPONSOR, status: 3 }),
    agent: async () => ({ runner: RUNNER_ACCOUNT.address }),
  };

  return {
    store,
    reports,
    runHash,
    deps: { chain, disclosure, store, reports, chainId: CHAIN_ID, verifyingContract: CONTRACT },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function get(deps: ReproduceDeps | null, path: string): Promise<Response> {
  return reproduceRoutes(deps).request(path);
}

async function body(deps: ReproduceDeps, trialId = TRIAL_ID): Promise<Record<string, any>> {
  const res = await get(deps, `/${trialId}`);
  return await res.json();
}

const step = (payload: Record<string, any>, name: string) => payload.steps.find((s: any) => s.name === name);

describe("a run that can be reproduced", () => {
  it("passes every step and reports the bindings a skeptic needs", async () => {
    const f = await fixture();
    try {
      const res = await get(f.deps, `/${TRIAL_ID}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const payload = await res.json();
      expect(payload.reproduced).toBe(true);
      expect(payload.steps.map((s: any) => s.name)).toEqual([
        "disclosure",
        "artifact-hash",
        "signature",
        "manifest",
        "report",
      ]);
      expect(payload.chain).toMatchObject({
        chainId: CHAIN_ID,
        verifyingContract: CONTRACT,
        runHash: f.runHash,
        agentId: Number(AGENT_ID),
        sponsor: SPONSOR,
        registeredRunner: RUNNER_ACCOUNT.address,
      });
      // The address is recovered, not echoed from the artifact.
      expect(step(payload, "signature").detail.recoveredSigner).toBe(RUNNER_ACCOUNT.address);
    } finally {
      await f.cleanup();
    }
  });

  it("reports what the artifact claims without certifying it", async () => {
    const f = await fixture();
    try {
      const detail = step(await body(f.deps), "artifact-hash").detail;
      // Three results, two passing — counted from the bytes, and explicitly not a verdict.
      expect(detail.claimedTests).toBe(3);
      expect(detail.claimedPassed).toBe(2);
    } finally {
      await f.cleanup();
    }
  });

  it("answers the same way twice, because a reproduction is not a roll", async () => {
    const f = await fixture();
    try {
      expect(JSON.stringify(await body(f.deps))).toBe(JSON.stringify(await body(f.deps)));
    } finally {
      await f.cleanup();
    }
  });
});

describe("which fact is wrong", () => {
  it("fails artifact-hash when the pinned bytes are not the run the chain recorded", async () => {
    // The disclosure points at a *different* artifact than the one the chain hashed: the bytes
    // resolve, they parse, and they are the wrong evidence. This is the poisoned-pointer case.
    const f = await fixture({ announceArtifact: artifact({ commitSHA: "deadbeef" }) });
    try {
      const payload = await body(f.deps);
      expect(payload.reproduced).toBe(false);
      const fail = step(payload, "artifact-hash");
      expect(fail.passed).toBe(false);
      expect(fail.failure).toContain("keccak256(JCS(artifact))");
      // And the failure is named where it belongs, not smeared across the other steps.
      expect(step(payload, "disclosure").passed).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it("fails signature when the run was signed by a key the registry does not hold", async () => {
    const f = await fixture({ signer: STRANGER_ACCOUNT });
    try {
      const payload = await body(f.deps);
      expect(payload.reproduced).toBe(false);
      const sig = step(payload, "signature");
      expect(sig.passed).toBe(false);
      expect(sig.detail.recoveredSigner).toBe(STRANGER_ACCOUNT.address);
      expect(sig.detail.registeredRunner).toBe(RUNNER_ACCOUNT.address);
      expect(sig.failure).toContain("the registry holds");
      // The bytes still reproduce: a foreign signer is an attribution failure, not lost evidence.
      expect(step(payload, "artifact-hash").passed).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it("fails signature, and says the runner published no signature, when the field is absent", async () => {
    const f = await fixture({ signature: null });
    try {
      const payload = await body(f.deps);
      const sig = step(payload, "signature");
      expect(sig.passed).toBe(false);
      expect(sig.failure).toContain("without its signature");
      expect(sig.detail.recoveredSigner).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  });

  it("reports nothing reproducible when the bytes were never disclosed", async () => {
    const f = await fixture();
    try {
      // A trial whose run hash the disclosure has never heard of.
      const strangerRun = `0x${"77".repeat(32)}` as Hex;
      const deps = { ...f.deps, chain: { trial: async () => ({ agentId: AGENT_ID, runHash: strangerRun, sponsor: SPONSOR, status: 3 }), agent: async () => ({ runner: RUNNER_ACCOUNT.address }) } };
      const payload = await body(deps);
      expect(payload.reproduced).toBe(false);
      expect(payload.steps).toHaveLength(1);
      expect(payload.steps[0].name).toBe("disclosure");
      expect(payload.steps[0].failure).toContain("nothing to reproduce");
    } finally {
      await f.cleanup();
    }
  });

  it("fails manifest when the announced digest does not match the pinned manifest", async () => {
    const f = await fixture({ manifestOver: () => ({ ...manifest(), suiteDigest: `0x${"33".repeat(32)}` }) });
    try {
      const payload = await body(f.deps);
      const man = step(payload, "manifest");
      expect(man.passed).toBe(false);
      // The two numbers are both handed back, because "they differ" is not actionable.
      expect(man.detail.announcedDigest).not.toBe(man.detail.recomputedDigest);
    } finally {
      await f.cleanup();
    }
  });

  it("distinguishes never graded from graded and failed", async () => {
    const f = await fixture({ pinReport: false });
    try {
      const payload = await body(f.deps);
      const rep = step(payload, "report");
      expect(rep.passed).toBe(false);
      expect(rep.failure).toContain("not the same as a bad grade");
      expect(payload.reproduced).toBe(false);
      // The evidence is all still there — the run reproduces up to the point where nobody graded
      // it, so the operator is sent to the committee and not to the runner.
      for (const name of ["disclosure", "artifact-hash", "signature", "manifest"]) {
        expect(step(payload, name).passed, name).toBe(true);
      }
    } finally {
      await f.cleanup();
    }
  });

  /**
   * The cost of deriving the chain from the content, asserted so it stays a known price.
   *
   * `CidStore` is bounded and evicts oldest-first, so a report published last autumn can be gone
   * while every other document remains. The route then answers "no verification report is
   * readable" — which is also exactly what it answers when nobody ever published one, because
   * there is no secondary index to contradict the bytes. The failure mode is deliberately shared
   * and the message says so: an index that survived eviction would be a second record able to
   * disagree with the store after a restart, and this repository has already paid for that once.
   */
  it("names the two absences it cannot tell apart, rather than guessing which one it is", async () => {
    const f = await fixture({ pinReport: false });
    try {
      const rep = step(await body(f.deps), "report");
      expect(rep.failure).toContain("evicted");
      expect(rep.failure).toContain("never written");
    } finally {
      await f.cleanup();
    }
  });

  it("trusts the node over the disclosure when the two disagree", async () => {
    // The chain is the authority: an honest-looking projection built on a run hash the escrow
    // never recorded must not be able to reproduce.
    const f = await fixture();
    try {
      const forgedRun = computeRunHash(artifact({ commitSHA: "not-what-the-chain-saw" }));
      const deps = {
        ...f.deps,
        chain: {
          trial: async () => ({ agentId: AGENT_ID, runHash: forgedRun, sponsor: SPONSOR, status: 3 }),
          agent: async () => ({ runner: RUNNER_ACCOUNT.address }),
        },
      };
      const payload = await body(deps);
      expect(payload.reproduced).toBe(false);
      expect(payload.steps[0].name).toBe("disclosure");
    } finally {
      await f.cleanup();
    }
  });
});

describe("the route's own refusals", () => {
  it("says 503 with a reason when no source is configured, and 200 on the index", async () => {
    const off = await get(null, "/");
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ configured: false });

    const f = await fixture();
    try {
      const on = await get(f.deps, "/");
      expect(on.status).toBe(200);
      expect((await on.json()).configured).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it("refuses a trial id that is not a positive integer", async () => {
    const f = await fixture();
    try {
      for (const bad of ["0", "-4", "abc", "1.5", "1e9"]) {
        const res = await get(f.deps, `/${bad}`);
        expect(res.status).toBe(400);
      }
    } finally {
      await f.cleanup();
    }
  });

  it("404s a trial with nothing submitted rather than reproducing a zero hash", async () => {
    const f = await fixture();
    try {
      const deps = {
        ...f.deps,
        chain: {
          trial: async () => ({ agentId: AGENT_ID, runHash: `0x${"00".repeat(32)}` as Hex, sponsor: SPONSOR, status: 1 }),
          agent: async () => ({ runner: RUNNER_ACCOUNT.address }),
        },
      };
      const res = await get(deps, `/${TRIAL_ID}`);
      expect(res.status).toBe(404);
      expect((await res.json()).error).toContain("no submitted run");
    } finally {
      await f.cleanup();
    }
  });

  it("502s when the node cannot answer, instead of serving an empty reproduction", async () => {
    const f = await fixture();
    try {
      const deps = {
        ...f.deps,
        chain: {
          trial: async () => {
            throw new Error("connection refused");
          },
          agent: async () => ({ runner: RUNNER_ACCOUNT.address }),
        },
      };
      const res = await get(deps, `/${TRIAL_ID}`);
      expect(res.status).toBe(502);
      expect((await res.json()).error).toContain("connection refused");
    } finally {
      await f.cleanup();
    }
  });
});
