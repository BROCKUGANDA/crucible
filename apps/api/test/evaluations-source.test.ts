import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { CidStore, DisclosureLog, VerificationReportStore } from "@crucible/cidstore";
import {
  buildEvalManifest,
  manifestDigest,
  verificationReportDigest,
  type EvalManifest,
  type VerificationReportEnvelope,
} from "@crucible/smith";
import { hydrateTimestamps, replay, type EventLike, type ReadModel } from "@crucible/indexer";
import { createEvaluationSource, type EvaluationSourceDeps } from "../src/evaluations-source.js";

/**
 * The host-side join, end to end over real bytes.
 *
 * Nothing here is a stubbed `EvaluationSource` — the routes that consume one are tested in
 * `evaluations.test.ts`, and what this file tests is the thing that decides whether those routes
 * say anything true: the assembly of a record out of the read model, the disclosure log and the
 * content store. So the fixtures are the real components writing real files in a temp directory,
 * and the read model is produced by folding the same logs Scribe would fold.
 *
 * Three properties carry the weight:
 *
 *   * **Absence is not exclusion.** A run nobody published, or nobody verified, yields no record.
 *     A record with `eligible: false` is a finding; a missing record is "we do not know yet", and
 *     the endpoint must not present those two the same way.
 *   * **Every number is re-derived, not trusted.** The announced manifest digest is checked
 *     against the pinned bytes. A disclosure that points at different bytes is a finding with a
 *     named reason, not a fact this host repeats.
 *   * **The same inputs give the same bytes.** Two assemblies over an unchanged world produce
 *     identical records, which is ADR-0008's rebuild guarantee applied to this projection.
 */

const SPONSOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const RUNNER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
const OPERATOR = "0x90F7947807cD61A09c50d7fA3b0A2A4d8d2F7F0b" as Address;
const TASK = `0x${"11".repeat(32)}` as Hex;
const SUITE = `0x${"22".repeat(32)}` as Hex;
const RUN_HASH = `0x${"9c".repeat(32)}` as Hex;
const TX = `0x${"5d".repeat(32)}` as Hex;
const RUN_BLOCK = 428n;
const RUN_SECONDS = 1_793_923_200;

function manifest(over: Partial<EvalManifest> = {}): EvalManifest {
  return buildEvalManifest({
    taskDigest: TASK,
    suiteDigest: SUITE,
    evaluator: { id: "argus", version: "1.4.0", rubricVersion: "3" },
    model: { provider: "hetzner", name: "qwen", version: "Qwen/Qwen3.6-35B-A3B" },
    environment: { imageDigest: `crucible/verifier@sha256:${"a".repeat(64)}` },
    seed: "panel-2026-10-27",
    scoring: { feeSchedule: "legacy-v1", feeScheduleVersion: "1", decision: "deterministic-suite" },
    startedAt: "2026-10-27T12:00:00.000Z",
    finishedAt: "2026-10-27T12:00:41.000Z",
    // Passed *into* the builder, not spliced onto its output: a manifest assembled with a moved
    // pin is a document the builder itself produced, so the swap test cannot be quietly reduced
    // to "the same bytes twice" — which is precisely how this file's first draft escaped the
    // mutation it was supposed to catch.
    ...over,
  }) as EvalManifest;
}

function envelope(over: Partial<VerificationReportEnvelope> = {}): VerificationReportEnvelope {
  return {
    schemaVersion: 1,
    runHash: RUN_HASH,
    reportVersion: 1,
    evaluator: { name: "argus", version: "1.4.0", imageDigest: "sha256:aaaa" },
    result: {
      verdict: "agent-wins",
      phase: "deterministic",
      steps: [{ name: "artifact-hash", passed: true }],
      reason: "the pinned suite ran green against the artifact",
    },
    createdAt: "2026-11-06T04:30:00Z",
    ...over,
  };
}

/** The logs a paid, verified trial leaves behind, in the order the chain emits them. */
function logs(): EventLike[] {
  const at = (n: bigint, i: number, eventName: string, args: Record<string, unknown>): EventLike => ({
    blockNumber: n,
    transactionHash: TX,
    logIndex: i,
    address: "0x5fbdb2315678afecb367f032d93f642f63180aa3",
    eventName,
    args,
  });
  return [
    at(100n, 0, "AgentRegistered", {
      agentId: 3n,
      operator: OPERATOR,
      runner: RUNNER,
      metadataURI: "ipfs://x",
      stake: 1_000_000_000_000_000_000n,
    }),
    at(200n, 0, "TrialCreated", {
      id: 14n,
      sponsor: SPONSOR,
      specCID: TASK,
      testsCID: SUITE,
      reward: 2_000_000_000_000_000_000n,
      bond: 500_000_000_000_000_000n,
      deadline: 1_800_000_000n,
      breakWindow: 86_400n,
    }),
    at(400n, 0, "TrialClaimed", { id: 14n, agentId: 3n, bond: 500_000_000_000_000_000n }),
    at(RUN_BLOCK, 0, "RunSubmitted", { id: 14n, agentId: 3n, runHash: RUN_HASH }),
  ];
}

async function world(opts: {
  pinManifest?: boolean;
  announceManifest?: boolean;
  /**
   * Pin a *different* manifest than the digest announces — the bytes are real, they resolve, and
   * they are not the bytes the runner claimed. This is the case the digest check exists for; an
   * unresolvable CID is a different fault and is tested separately.
   */
  swapManifest?: boolean;
  publishReport?: boolean;
  model?: ReadModel;
}): Promise<{ deps: EvaluationSourceDeps; cleanup: () => Promise<void>; store: CidStore }> {
  const dir = await mkdtemp(join(tmpdir(), "crucible-eval-source-"));
  const store = new CidStore({ dir: join(dir, "store") });
  const disclosure = await DisclosureLog.open(dir);
  const reports = new VerificationReportStore(store);

  const model = opts.model ?? replay(logs());
  // `RunSubmitted` records a chain position; the wall clock arrives with the block, exactly as
  // Scribe's `hydrateTimestamps` delivers it. Without this pass `runAt` is still 428.
  hydrateTimestamps(model, new Map([[RUN_BLOCK, RUN_SECONDS]]));

  await disclosure.announceArtifact(RUN_HASH, { cid: store.putJson({ artifact: true }) });

  if (opts.announceManifest !== false) {
    const m = manifest();
    const announced = manifestDigest(m);
    const cid =
      opts.pinManifest === false
        ? "bafkrekqlies"
        : opts.swapManifest
          ? // Same shape, one pin moved: a suite epoch that is not the one scored under.
            store.putJson(manifest({ suiteDigest: `0x${"33".repeat(32)}` as Hex }))
          : store.putJson(m);
    await disclosure.announceManifest(RUN_HASH, { cid, digest: announced });
  }

  if (opts.publishReport !== false) {
    reports.append(envelope());
  }

  return {
    store,
    deps: {
      model: () => model,
      chainId: 31337,
      disclosure,
      reports,
      store,
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe("a fully published, fully verified run", () => {
  it("assembles one record whose identity comes from the chain, not the disclosure", async () => {
    const { deps, cleanup } = await world({});
    try {
      const records = createEvaluationSource(deps).records();
      expect(records).toHaveLength(1);
      const r = records[0]!;
      expect(r.runHash).toBe(RUN_HASH);
      expect(r.identity.chainId).toBe(31337);
      expect(r.identity.trialId).toBe(14);
      expect(r.identity.agentId).toBe(3);
      // The escrow's word for who put the reward up. The blueprint called this `funderId`, and in
      // this contract set a "funder" is the party a refund goes *to* — the sponsor is the funder.
      expect(r.identity.funderId.toLowerCase()).toBe(SPONSOR.toLowerCase());
      expect(r.identity.runner.toLowerCase()).toBe(RUNNER.toLowerCase());
      expect(r.identity.transactionHash).toBe(TX);
      expect(r.identity.blockNumber).toBe(428);
      expect(r.identity.timestamp).toBe(RUN_SECONDS);
      expect(r.ranking.eligible).toBe(true);
      expect(r.ranking.exclusionReasons).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("binds the manifest it can prove and the report it can name", async () => {
    const { deps, store, cleanup } = await world({});
    try {
      const [r] = createEvaluationSource(deps).records();
      const m = manifest();
      expect(r!.evidence.manifestDigest).toBe(manifestDigest(m));
      // The CID the disclosure points at resolves to these bytes, so the pointer is real.
      expect(store.getBytes(r!.evidence.manifestCid)).not.toBeNull();
      const env = envelope();
      expect(r!.evidence.verificationReportDigest).toBe(verificationReportDigest(env));
      expect(r!.verification.reportVersion).toBe(1);
      expect(r!.verification.verifiedAt).toBe("2026-11-06T04:30:00Z");
      expect(r!.verification.evaluatorVersion).toBe("1.4.0");
      expect(r!.verification.evaluatorImageDigest).toBe("sha256:aaaa");
    } finally {
      await cleanup();
    }
  });

  it("is the same bytes twice, because a rebuild may not depend on when it ran", async () => {
    const { deps, cleanup } = await world({});
    try {
      const source = createEvaluationSource(deps);
      expect(JSON.stringify(source.records())).toBe(JSON.stringify(source.records()));
    } finally {
      await cleanup();
    }
  });
});

describe("absence, which is not a finding", () => {
  /**
   * The absence the disclosure guard owns, isolated.
   *
   * The second run gets a published envelope but *no* disclosure record. Without that, deleting
   * the disclosure check leaves this test green — the report guard below it catches the same run
   * for a different reason, and the suite would report a property it never measured. Proven: with
   * both guards removed this file's first version stayed green on this case.
   */
  it("yields no record when the runner never disclosed the bytes", async () => {
    const { deps, cleanup } = await world({});
    try {
      const model = deps.model();
      const otherRun = `0x${"77".repeat(32)}` as Hex;
      model.runs.set(15, {
        trialId: 15,
        agentId: 3,
        runHash: otherRun,
        signature: null,
        blockNumber: 429,
        txHash: TX,
        artifactCID: null,
      });
      model.trials.set(15, { ...model.trials.get(14)!, id: 15, runHash: otherRun });
      // Verified, and still nothing to verify *against* — the artifact bytes were never announced.
      deps.reports.append(envelope({ runHash: otherRun }));

      const hashes = createEvaluationSource(deps).records().map((r) => r.runHash);
      expect(hashes).toEqual([RUN_HASH]);
    } finally {
      await cleanup();
    }
  });

  it("yields no record when nothing verified the run", async () => {
    const { deps, cleanup } = await world({ publishReport: false });
    try {
      expect(createEvaluationSource(deps).records()).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("yields no record when the manifest was never announced", async () => {
    const { deps, cleanup } = await world({ announceManifest: false });
    try {
      expect(createEvaluationSource(deps).records()).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe("evidence that exists and does not check out", () => {
  /**
   * GATE-EVAL-01, the case that actually moves bytes.
   *
   * The pointer resolves, the document parses, and it is not the document the digest names. A
   * test that only ever handed this host an unresolvable CID would stay green with the comparison
   * deleted — measured, not asserted: that is exactly what happened when this file's first version
   * was mutation-checked, and the two cases are kept apart from then on.
   */
  it("names MANIFEST_DIGEST_MISMATCH when the pinned bytes are a different manifest", async () => {
    const { deps, cleanup } = await world({ swapManifest: true });
    try {
      const records = createEvaluationSource(deps).records();
      expect(records).toHaveLength(1);
      expect(records[0]!.ranking.eligible).toBe(false);
      expect(records[0]!.ranking.exclusionReasons).toContain("MANIFEST_DIGEST_MISMATCH");
    } finally {
      await cleanup();
    }
  });

  it("names MANIFEST_DIGEST_MISMATCH when the announced CID resolves to nothing here", async () => {
    const { deps, cleanup } = await world({ pinManifest: false });
    try {
      const records = createEvaluationSource(deps).records();
      expect(records).toHaveLength(1);
      expect(records[0]!.ranking.exclusionReasons).toContain("MANIFEST_DIGEST_MISMATCH");
    } finally {
      await cleanup();
    }
  });

  /**
   * The consequence of not recovering a signer, asserted rather than glossed.
   *
   * `projectEvaluationRecord` names the record's runner as `registeredRunner ?? runSigner` and
   * returns nothing when both are null (`packages/indexer/src/evaluation-projection.ts:159-160`) —
   * correctly, since a record has to name *some* address. On this host `runSigner` is always null,
   * so an agent the registry has no row for produces no record at all rather than a
   * `RUNNER_UNREGISTERED` finding, and the reason is unreachable from here.
   *
   * The projection's own suite still exercises that branch by handing it a signer directly. What
   * this file has to keep true is the narrower claim: the endpoint never prints the accusation
   * without the recovery behind it, and it never prints an identity it cannot name.
   */
  it("yields no record — not an accusation — when the registry has no row for the agent", async () => {
    const model = replay(logs());
    hydrateTimestamps(model, new Map([[RUN_BLOCK, RUN_SECONDS]]));
    model.agents.delete(3);
    const { deps, cleanup } = await world({ model });
    try {
      const records = createEvaluationSource(deps).records();
      expect(records).toEqual([]);
      expect(records.some((r) => r.ranking.exclusionReasons.includes("RUNNER_UNREGISTERED"))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("never asserts an identity mismatch it did not recover", async () => {
    const { deps, cleanup } = await world({});
    try {
      const [r] = createEvaluationSource(deps).records();
      // `evaluations-source.ts` explains why the signer is not recovered on this path: every
      // viem recovery entry point is async, the routes are not, and the check that question
      // feeds is already Argus's step 4/5 and the chain's own `BadSigner` revert. The gate here
      // is that the host therefore *cannot* claim a mismatch — an endpoint that printed
      // IDENTITY_MISMATCH without recovering a signer would be accusing somebody on no evidence.
      expect(r!.ranking.exclusionReasons).not.toContain("IDENTITY_MISMATCH");
    } finally {
      await cleanup();
    }
  });

  it("drops a run whose trial has no row, rather than projecting an identity from nothing", async () => {
    const model = replay(logs());
    hydrateTimestamps(model, new Map([[RUN_BLOCK, RUN_SECONDS]]));
    model.runs.set(99, {
      trialId: 99,
      agentId: 3,
      runHash: `0x${"88".repeat(32)}`,
      signature: null,
      blockNumber: 500,
      txHash: TX,
      artifactCID: null,
    });
    const { deps, cleanup } = await world({ model });
    try {
      expect(createEvaluationSource(deps).records().map((r) => r.identity.trialId)).toEqual([14]);
    } finally {
      await cleanup();
    }
  });
});

describe("the history and the bytes behind it", () => {
  it("returns every published version in order, each reachable through the lookup", async () => {
    const { deps, cleanup } = await world({});
    try {
      const source = createEvaluationSource(deps);
      expect(source.history(RUN_HASH).map((e) => e.reportVersion)).toEqual([1]);

      deps.reports.append(
        envelope({ reportVersion: 2, previousReportDigest: verificationReportDigest(envelope()) }),
      );

      const two = source.history(RUN_HASH);
      expect(two.map((e) => e.reportVersion)).toEqual([1, 2]);
      // Every entry the history names has to resolve through the same host's lookup, or the
      // endpoint would be handing out CIDs that belong to somebody else's store.
      for (const entry of two) {
        expect(source.lookup(entry.cid).kind).toBe("text");
      }
      // And the newest version is the one the record cites.
      expect(source.records()[0]!.verification.reportVersion).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("says not-pinned for a CID this host does not hold, and never invents content", async () => {
    const { deps, cleanup } = await world({});
    try {
      const read = createEvaluationSource(deps).lookup("bafkrekqnothinghere");
      expect(read.kind).toBe("not-pinned");
    } finally {
      await cleanup();
    }
  });
});
