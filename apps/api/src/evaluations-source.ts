import { type Address, type Hex } from "viem";
import { canonicalize } from "json-canonicalize";
import { manifestDigest, verificationReportDigest, type EvalManifest } from "@crucible/smith";
import { ContentCorruptedError, type CidStore, type DisclosureLog, type StoredEnvelope, type VerificationReportStore } from "@crucible/cidstore";
import {
  projectEvaluationRecords,
  type EvaluationRankingInput,
  type EvaluationProjectionInput,
} from "@crucible/indexer";
import type { EvaluationRecord } from "@crucible/smith";
import type { ReadModel, RunRow } from "@crucible/indexer";
import type { ContentLookup, ContentRead } from "./content.js";
import type { EvaluationSource } from "./evaluations.js";

/**
 * The host-side join behind `GET /evaluations` and `GET /leaderboards`.
 *
 * Everything it reads already exists and already has an owner. Nothing here decides anything: it
 * gathers the facts each component published, hands them to `projectEvaluationRecords`, and
 * serves what comes back. Eligibility is derived in the projection, the verdict comes from Argus,
 * the run hash comes from the chain, and the disclosure log is the only place a run's signature
 * survives — `submitRun` recovers the signer, compares it against the registered runner key and
 * keeps neither the signature nor the deadline (`crucible-contracts/contracts/CrucibleTrials.sol:533-548`).
 *
 * Provenance of every field, stated once:
 *
 *   chainId             — the node this process is dialled into (`server.ts`)
 *   trialId / agentId   — the read model's `RunRow`, i.e. the `RunSubmitted` log
 *   runHash             — the same row, which is what `submitRun` recorded
 *   transactionHash     — the same row
 *   blockNumber         — the same row (`RunRow.blockNumber`: a chain position, not a clock)
 *   timestamp           — `trial.runAt`, hydrated to the block's Unix **seconds**
 *   funderId            — `trial.sponsor`, the address that put the reward up. In this contract
 *                         set a "funder" is the party a refund goes *to*
 *                         (`crucible-contracts/contracts/RewardMath.sol:15-16`), so the sponsor is
 *                         the funder and the word follows the escrow.
 *   registeredRunner    — `agent.runner` from the registry (`model.ts:112`), never the artifact's
 *                         claim about who signed it
 *   runSigner           — **not recovered here**; see `RUN_SIGNER_NOT_RECOVERED`
 *   manifestCid / Digest— the disclosure record the runner's publisher wrote (CRU-002B)
 *   reportCid / Digest  — the envelope the seat appended (CRU-002C)
 *
 * **What is refused rather than guessed.** A missing fact stays missing, and what follows from it
 * is the projection's, not this file's to soften: a run with no published manifest or no published
 * report gets **no record at all**, so "never verified" stays an absence rather than becoming an
 * exclusion — the distinction `evaluation-projection.ts` exists to preserve. An agent the registry
 * has no row for gets the same treatment, because a record has to name a runner and this host
 * cannot name one (see `RUN_SIGNER_NOT_RECOVERED` below for why the recovered signer is not
 * available here, and what it costs). Both digests are re-hashed from the bytes on hand rather than
 * trusted, because an announced number is a claim, not a check.
 */

export interface EvaluationSourceDeps {
  /** The in-memory read model. Called per request and never cached: ADR-0008. */
  model: () => ReadModel;
  chainId: number;
  disclosure: DisclosureLog;
  reports: VerificationReportStore;
  /** The store the manifests and envelopes live in, so `/evidence` can hand out bytes. */
  store: CidStore;
  /**
   * Score and cohort for a run, from the authoritative scorecards.
   *
   * Keyed on `(agentId, manifestDigest)` rather than on `runHash`, because that is the pair both
   * sides can actually prove: a scorecard publication names a cohort, an agent and a manifest —
   * never a trial or a run — and `manifestDigest` is recomputed from the row's own manifest by the
   * publication verifier and from the pinned bytes by this file. `scorecard-ranking.ts` is that
   * join, and it states there why the key is not invented.
   *
   * `manifestDigest` here is the digest this host *verified*, and it is null whenever the announced
   * digest and the pinned bytes disagree — so a run whose evidence failed its own check cannot
   * carry a score in on the number that just got refused. Null from the callback means "no
   * measured score", which the record carries as an absent field rather than a zero: a 0.0
   * accuracy is a measurement, a missing one is not.
   */
  ranking?: (args: { agentId: number; manifestDigest: Hex | null }) => EvaluationRankingInput | null;
}

/** What one read of a pinned document can conclude, kept apart because the repairs differ. */
type Pinned =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "not-pinned" }
  | { kind: "corrupt"; reason: string };

function readPinned(store: CidStore, cid: string): Pinned {
  try {
    const bytes = store.getBytes(cid);
    return bytes === null ? { kind: "not-pinned" } : { kind: "ok", bytes };
  } catch (err) {
    if (err instanceof ContentCorruptedError) return { kind: "corrupt", reason: err.message };
    throw err;
  }
}

/**
 * The address that signed this run, recovered from the bytes the runner published.
 *
 * **Not used, and this is the honest reason.** Every recovery entry point viem 2.57 exposes —
 * `recoverTypedDataAddress`, `recoverAddress`, `recoverPublicKey` — resolves a promise, and
 * `EvaluationSource.records()` is synchronous because the Hono routes that call it are. Handing
 * back a half-finished recovery, or importing a second secp256k1 implementation to dodge the
 * await, are both worse than the gap: the first publishes an identity that was never recovered,
 * the other is a second source of truth about who a signature belongs to.
 *
 * So the attribution question is answered where it is already answered — inside Argus. Step 4
 * compares the artifact's claimed runner against the registry key (`packages/argus/src/argus.ts:95-105`)
 * and step 5 recovers the signer and compares it against the artifact
 * (`packages/argus/src/argus.ts:109-133`); a run that fails either is not an `agent-wins`, and
 * the verdict the envelope carries is the durable form of that check. The chain itself already
 * refused such a run before it landed: `submitRun` reverts `BadSigner()` when the recovered
 * address is not the registered key, so a mismatched signature has no block to be projected from.
 *
 * What the host *can* see is `registeredRunner === null` — no registry row for the agent — and
 * what follows from it is stated in `evaluations-source.test.ts`: the projection needs *some*
 * address to name, gets none, and returns no record. So `RUNNER_UNREGISTERED` is not a finding
 * this endpoint can print; it is an absence. The projection's own suite reaches that reason by
 * handing a recovered signer in directly, which is the honest split — the branch exists, this
 * host is not the thing that fills it.
 *
 * The exit path, if a per-run recovered signer is ever wanted as a published fact of its own: the
 * seat that already recovered it writes it into `VerificationReportEnvelope.evaluator` as a
 * structured field at schema version 2, and this file reads it instead of computing it. ADR-0024
 * keeps that open rather than pretending the identity join is closed.
 */
export const RUN_SIGNER_NOT_RECOVERED: Address | null = null;

/** The CID an envelope is stored under, or would be — the store's own sha256 over canonical bytes. */
function envelopeCid(store: CidStore, envelope: unknown): string {
  return store.cidFor(canonicalize(envelope));
}

function evidenceLookup(deps: EvaluationSourceDeps): ContentLookup {
  return (id: string): ContentRead => {
    const pinned = readPinned(deps.store, id);
    if (pinned.kind === "not-pinned") return { kind: "not-pinned" };
    if (pinned.kind === "corrupt") return { kind: "corrupt", reason: pinned.reason };
    try {
      return { kind: "text", text: new TextDecoder("utf8", { fatal: true }).decode(pinned.bytes) };
    } catch {
      return { kind: "bytes", bytes: pinned.bytes };
    }
  };
}

/**
 * One run, as far as this host can see it — or nothing.
 *
 * Returns null for the two absence cases (no disclosure record, no published envelope) and a
 * full projection input otherwise. Split out so a test can ask about a single run without
 * building a whole read model, and so the loop below stays a walk rather than a decision tree.
 */
function inputForRun(
  deps: EvaluationSourceDeps,
  model: ReadModel,
  run: RunRow,
): EvaluationProjectionInput | null {
  const trial = model.trials.get(run.trialId);
  if (!trial) return null;
  const record = deps.disclosure.artifactRecordFor(run.runHash);
  if (!record) return null;
  const envelope = deps.reports.latest(run.runHash as Hex);
  if (!envelope) return null;

  const agent = model.agents.get(run.agentId);

  // Two fields the row types call optional and the projection never leaves empty: `txHash` and
  // `runAt` are both written by the same `RunSubmitted` fold that created this row, so reaching
  // one without the other means the read model is in a state this host was not built to read.
  // Refusing the row is the only honest option — a fabricated `0x000…` transaction or a zero
  // timestamp would either hash into a record that cites nothing or be rejected downstream as
  // Unix epoch, and neither is a fact anybody can check.
  if (run.txHash === null || trial.runAt === null) return null;

  const manifestCid = record.manifestCid ?? null;
  const manifestDigestAnnounced = record.manifestDigest ? (record.manifestDigest as Hex) : null;
  let manifestDigestOk = false;
  // The digest recomputed from the bytes, kept separate from the announced one on purpose: the
  // score join is keyed on the number this host proved, not the number the runner quoted. When the
  // two disagree the evidence is already refused below, and a score must not ride in on the
  // announced value.
  let verifiedManifestDigest: Hex | null = null;
  if (manifestCid !== null && manifestDigestAnnounced !== null) {
    const pinned = readPinned(deps.store, manifestCid);
    if (pinned.kind === "ok") {
      try {
        const parsed = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(pinned.bytes)) as EvalManifest;
        // `manifestDigest` is the escrow's own function, so this is the number a verifier would
        // compute — not a second implementation free to drift from the first.
        const computed = manifestDigest(parsed);
        manifestDigestOk = computed.toLowerCase() === manifestDigestAnnounced.toLowerCase();
        if (manifestDigestOk) verifiedManifestDigest = computed;
      } catch {
        manifestDigestOk = false;
      }
    }
  }

  const reportCid = envelopeCid(deps.store, envelope);
  const pinnedReport = readPinned(deps.store, reportCid);
  const reportDigest = verificationReportDigest(envelope);
  // The envelope this host is holding re-hashes to the digest computed over it, and the bytes at
  // that CID are the bytes it was written from — `store.getBytes` already refuses to answer when
  // they do not match the id's own digest, so `corrupt` here means the store disagrees with itself.
  const reportDigestOk = pinnedReport.kind === "ok";

  const signer = RUN_SIGNER_NOT_RECOVERED;

  const ranking = deps.ranking?.({ agentId: run.agentId, manifestDigest: verifiedManifestDigest }) ?? null;

  return {
    run: {
      chainId: deps.chainId,
      trialId: run.trialId,
      agentId: run.agentId,
      funderId: trial.sponsor as Address,
      registeredRunner: (agent?.runner ?? null) as Address | null,
      runSigner: signer,
      runHash: run.runHash as Hex,
      transactionHash: run.txHash as Hex,
      blockNumber: run.blockNumber,
      timestamp: trial.runAt,
    },
    evidence: {
      manifestCid,
      manifestDigest: manifestDigestAnnounced,
      manifestDigestOk,
      reportCid,
      reportDigest,
      reportDigestOk,
    },
    report: {
      verdict: envelope.result.verdict,
      phase: envelope.result.phase,
      evaluatorVersion: envelope.evaluator.version,
      ...(envelope.evaluator.imageDigest ? { imageDigest: envelope.evaluator.imageDigest } : {}),
      createdAt: envelope.createdAt,
      reportVersion: envelope.reportVersion,
    },
    ...(ranking ? { ranking } : {}),
  };
}

export function createEvaluationSource(deps: EvaluationSourceDeps): EvaluationSource {
  return {
    records(): EvaluationRecord[] {
      const model = deps.model();
      const inputs: EvaluationProjectionInput[] = [];
      // Map order is insertion order and `RunSubmitted` arrives once per trial, so this walk is
      // deterministic — which matters because a record's own bytes end up hashed, and a rebuild
      // that produced the same records in a different order would still be a different snapshot.
      for (const run of model.runs.values()) {
        const input = inputForRun(deps, model, run);
        if (input !== null) inputs.push(input);
      }
      return [...projectEvaluationRecords(inputs).values()];
    },

    history(runHash: Hex) {
      return deps.reports.versions(runHash).map((envelope) => ({
        cid: envelopeCid(deps.store, envelope),
        reportVersion: envelope.reportVersion,
        envelope,
      }));
    },

    lookup: evidenceLookup(deps),
  };
}
