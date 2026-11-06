import { Hono } from "hono";
import { hashTypedData, recoverAddress, type Address, type Hex } from "viem";
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
import { ContentCorruptedError, type CidStore, type DisclosureLog, type VerificationReportStore } from "@crucible/cidstore";

/**
 * `GET /reproduce/:trialId` — check a published run from the evidence, without asking us.
 *
 * The lifecycle this repository keeps being measured against ends in **independent
 * reproduction**, and until now it had no endpoint: `/evaluations` answers from a projection
 * this process built, `/trials/:id` answers from the indexer's read model, `/content/:id` hands
 * out bytes. A skeptic with all three still has to take on trust that the bytes are the bytes
 * the chain committed, that the key which signed the run is the key the registry holds, and that
 * the report on offer is the report whose digest was published. Those are three separate trust
 * bets wearing one URL.
 *
 * So this route re-derives them from sources that do not share state with the read model: the
 * node answers for the trial and the agent, the content store answers for the bytes, the
 * disclosure log answers for the pointer and the signature. Nothing it reads comes from
 * `scribe.state`. A record can be projected correctly from a stale index; a reproduction is only
 * worth something if it goes to the chain.
 *
 * **What this does not check, and says so in the response.** It does not re-execute the suite —
 * that is `LiveVerifier`'s job inside an isolated bench, and it needs containers, salts and a
 * committee, none of which belong behind a public GET. The artifact's claimed pass counts are
 * therefore *reported*, not *verified*; the route reproduces the **bindings** (bytes → run hash
 * → signature → registered key → evidence → report digest) and hands the caller the CIDs and
 * digests to go and re-execute against.
 */

/** The two live reads this route performs, injected so it is testable without a node. */
export interface ReproduceReader {
  trial(trialId: bigint): Promise<{
    agentId: bigint;
    runHash: Hex;
    sponsor: Address;
    status: number;
  }>;
  agent(agentId: bigint): Promise<{ runner: Address }>;
}

export interface ReproduceDeps {
  chain: ReproduceReader;
  disclosure: DisclosureLog;
  store: CidStore;
  reports: VerificationReportStore;
  chainId: number;
  /** The escrow that emitted the run — the EIP-712 verifying contract. */
  verifyingContract: Address;
}

export interface ReproduceStep {
  name: string;
  passed: boolean;
  /** What the caller can check for themselves: the CID, the digest, the address. */
  detail: Record<string, unknown>;
  /** Why it failed, in words a reader who has not seen this code can act on. */
  failure?: string;
}

type Read = { ok: true; bytes: Uint8Array } | { ok: false; reason: "not-pinned" | "corrupt"; detail: string };

function readBytes(store: CidStore, cid: string): Read {
  try {
    const bytes = store.getBytes(cid);
    return bytes === null ? { ok: false, reason: "not-pinned", detail: `no bytes for ${cid} in this store` } : { ok: true, bytes };
  } catch (err) {
    if (err instanceof ContentCorruptedError) return { ok: false, reason: "corrupt", detail: err.message };
    throw err;
  }
}

function parseJson<T>(bytes: Uint8Array): T | null {
  try {
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) as T;
  } catch {
    return null;
  }
}

/** A run hash of zero is the contract's word for "nothing was submitted" — never a reproduction. */
const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;

async function reproduce(deps: ReproduceDeps, trialId: number): Promise<
  | { error: string; status: 404 | 502 }
  | { body: { trialId: number; reproduced: boolean; steps: ReproduceStep[]; chain: Record<string, unknown> } }
> {
  let chainTrial: Awaited<ReturnType<ReproduceReader["trial"]>>;
  let chainAgent: Awaited<ReturnType<ReproduceReader["agent"]>>;
  try {
    chainTrial = await deps.chain.trial(BigInt(trialId));
    chainAgent = await deps.chain.agent(chainTrial.agentId);
  } catch (err) {
    return { error: `the node could not answer for trial ${trialId}: ${(err as Error).message}`, status: 502 };
  }

  const runHash = chainTrial.runHash;
  if (runHash === ZERO_HASH) {
    return { error: `trial ${trialId} has no submitted run to reproduce`, status: 404 };
  }

  const steps: ReproduceStep[] = [];
  const push = (step: ReproduceStep) => {
    steps.push(step);
    return step;
  };

  const record = deps.disclosure.artifactRecordFor(runHash);

  // 1. The disclosure pointer. Without it the bytes were never published, and every check below
  //    is unanswerable — this is the absence, named as such rather than as a failure to verify.
  if (!record) {
    push({
      name: "disclosure",
      passed: false,
      detail: { runHash },
      failure: "no runner announced the bytes behind this run hash, so there is nothing to reproduce",
    });
    return { body: { trialId, reproduced: false, steps, chain: chainFacts(deps, chainTrial, chainAgent) } };
  }
  push({
    name: "disclosure",
    passed: true,
    detail: { artifactCid: record.cid, manifestCid: record.manifestCid ?? null, signaturePublished: record.signature !== undefined },
  });

  // 2. bytes -> run hash. The chain committed a keccak digest; this fetches the content it points
  //    at and hashes it with the escrow's own function. This is the load-bearing step: it is what
  //    makes "the artifact says it passed 41 tests" a checkable claim instead of a sentence.
  const artifactRead = readBytes(deps.store, record.cid);
  let artifact: RunArtifact | null = null;
  if (!artifactRead.ok) {
    push({ name: "artifact-hash", passed: false, detail: { artifactCid: record.cid }, failure: artifactRead.detail });
  } else {
    artifact = parseJson<RunArtifact>(artifactRead.bytes);
    if (artifact === null) {
      push({ name: "artifact-hash", passed: false, detail: { artifactCid: record.cid }, failure: "the pinned bytes are not JSON" });
    } else {
      const computed = computeRunHash(artifact);
      push({
        name: "artifact-hash",
        passed: computed.toLowerCase() === runHash.toLowerCase(),
        detail: {
          artifactCid: record.cid,
          recomputedRunHash: computed,
          chainRunHash: runHash,
          // What the artifact itself asserts. Reported, deliberately not verified here — see the
          // header: a public GET does not re-execute anything.
          claimedTests: Array.isArray(artifact.testResults) ? artifact.testResults.length : null,
          claimedPassed: Array.isArray(artifact.testResults)
            ? artifact.testResults.filter((t) => (t as { passed?: boolean }).passed === true).length
            : null,
          claimedRunner: artifact.runnerAddress ?? null,
        },
        failure:
          computed.toLowerCase() === runHash.toLowerCase()
            ? undefined
            : `keccak256(JCS(artifact)) is ${computed}, the chain recorded ${runHash}`,
      });
    }
  }

  // 3. signature -> registered key. The chain checked this at `submitRun` and kept neither the
  //    signature nor the deadline, so the disclosure is the only surviving witness — and this
  //    route is async, so unlike the synchronous evaluation projection it can actually recover
  //    the signer rather than decline to name one.
  const digest =
    artifact === null
      ? null
      : hashTypedData({
          domain: domainFor(deps.verifyingContract, deps.chainId),
          primaryType: RUN_PRIMARY_TYPE,
          types: RUN_TYPES,
          message: {
            trialId: BigInt(trialId),
            // From the chain, never from the artifact: an artifact that names another agent would
            // otherwise be recovered against a message the escrow never saw, and the mismatch the
            // check exists to catch would disappear into the digest.
            agentId: chainTrial.agentId,
            runHash,
            sigDeadline: BigInt(record.sigDeadline ?? "0"),
          },
        });

  let recovered: Address | null = null;
  if (!record.signature || digest === null) {
    push({
      name: "signature",
      passed: false,
      detail: { sigDeadline: record.sigDeadline ?? null, registeredRunner: chainAgent.runner },
      failure: record.signature
        ? "the artifact bytes were not readable, so there is no message to recover a signer for"
        : "the runner published the artifact without its signature, so no signer can be recovered",
    });
  } else {
    try {
      recovered = await recoverAddress({ hash: digest, signature: record.signature as Hex });
      push({
        name: "signature",
        passed: recovered.toLowerCase() === chainAgent.runner.toLowerCase(),
        detail: {
          recoveredSigner: recovered,
          registeredRunner: chainAgent.runner,
          digest,
          sigDeadline: record.sigDeadline ?? null,
        },
        failure:
          recovered.toLowerCase() === chainAgent.runner.toLowerCase()
            ? undefined
            : `the signature recovers to ${recovered}, the registry holds ${chainAgent.runner} for agent ${chainTrial.agentId}`,
      });
    } catch (err) {
      push({
        name: "signature",
        passed: false,
        detail: { registeredRunner: chainAgent.runner, digest },
        failure: `the disclosed signature is not recoverable: ${(err as Error).message}`,
      });
    }
  }

  // 4. the manifest, and the report. Both are content-addressed side documents (ADR-0017 keeps the
  //    manifest out of the artifact so no signature moves), so each is checked by re-hashing the
  //    bytes the pointer names.
  if (record.manifestCid && record.manifestDigest) {
    const manifestRead = readBytes(deps.store, record.manifestCid);
    const parsed = manifestRead.ok ? parseJson<Parameters<typeof manifestDigest>[0]>(manifestRead.bytes) : null;
    const recomputed = parsed === null ? null : manifestDigest(parsed);
    const passed = recomputed !== null && recomputed.toLowerCase() === record.manifestDigest.toLowerCase();
    push({
      name: "manifest",
      passed,
      detail: {
        manifestCid: record.manifestCid,
        announcedDigest: record.manifestDigest,
        recomputedDigest: recomputed,
        suiteDigest: parsed?.suiteDigest ?? null,
        evaluatorVersion: (parsed?.evaluator as { version?: string } | undefined)?.version ?? null,
      },
      failure: passed ? undefined : manifestRead.ok ? "the pinned manifest does not hash to the digest the runner announced" : manifestRead.detail,
    });
  } else {
    push({
      name: "manifest",
      passed: false,
      detail: { manifestCid: record.manifestCid ?? null },
      failure: "no evaluation manifest was announced for this run",
    });
  }

  const envelope = deps.reports.latest(runHash);
  if (envelope === null) {
    push({
      name: "report",
      passed: false,
      detail: { runHash },
      failure:
        "no verification report is readable for this run — nothing has been graded, which is not the same as a bad grade. " +
        "Note the two are indistinguishable here by construction: the version chain is derived from the content store, so a " +
        "report the bounded store has evicted reads exactly like one that was never written. A second index would tell them " +
        "apart and would be the thing that disagreed with the store after the next restart.",
    });
  } else {
    const cid = deps.store.cidFor(canonicalize(envelope));
    push({
      name: "report",
      passed: true,
      detail: {
        reportCid: cid,
        reportVersion: envelope.reportVersion,
        reportDigest: verificationReportDigest(envelope),
        verdict: envelope.result.verdict,
        phase: envelope.result.phase,
        evaluatorVersion: envelope.evaluator.version,
        verifiedAt: envelope.createdAt,
      },
    });
  }

  return { body: { trialId, reproduced: steps.every((s) => s.passed), steps, chain: chainFacts(deps, chainTrial, chainAgent) } };
}

function chainFacts(
  deps: ReproduceDeps,
  trial: { agentId: bigint; runHash: Hex; sponsor: Address; status: number },
  agent: { runner: Address },
): Record<string, unknown> {
  return {
    chainId: deps.chainId,
    verifyingContract: deps.verifyingContract,
    runHash: trial.runHash,
    agentId: Number(trial.agentId),
    sponsor: trial.sponsor,
    registeredRunner: agent.runner,
    // The escrow's own status word, so a reader can see this is a judgement about a run that
    // exists rather than a projection's opinion about one that does not.
    trialStatus: trial.status,
  };
}

export function reproduceRoutes(source: ReproduceDeps | null): Hono {
  const app = new Hono();

  app.get("/", (c) =>
    c.json(
      {
        configured: source !== null,
        // Readable, because "this host could not tell you" and "there was nothing to tell" are
        // different operational facts and an operator has to be able to place them apart.
        note:
          "GET /reproduce/:trialId re-derives a published run from the node, the content store and the disclosure log, independently of the indexer's read model. It does not re-execute the suite.",
      },
      source === null ? 503 : 200,
    ),
  );

  app.get("/:id", async (c) => {
    if (source === null) {
      return c.json({ error: "the reproduction source is not configured on this host" }, 503);
    }
    const raw = c.req.param("id");
    const trialId = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(trialId) || trialId < 1) {
      return c.json({ error: "trial id must be a positive integer" }, 400);
    }
    const outcome = await reproduce(source, trialId);
    if ("error" in outcome) return c.json({ error: outcome.error }, outcome.status);
    // `no-store`, always: a cached reproduction is a claim about bytes this host may have
    // evicted, and the whole value of this route is that it answers about right now.
    return c.json(outcome.body, 200, { "cache-control": "no-store" });
  });

  return app;
}
