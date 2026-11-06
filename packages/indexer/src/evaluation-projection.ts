import {
  assertEvaluationRecord,
  evaluateEligibility,
  evaluationIdOf,
  replayabilityFromClass,
  type EvaluationExclusionReason,
  type EvaluationRecord,
  type EvaluationVerdict,
  type EvaluationPhase,
  type ReplayabilityClass,
} from "@crucible/smith";
import type { Address, Hex } from "viem";

/**
 * The evaluation projection: chain facts plus disclosed content, folded into one record per run.
 *
 * Nothing here is stored. The chain's logs and the content-addressed disclosures are the
 * record; this file derives a shape from them, and ADR-0008's rule applies unchanged — a
 * route that writes is a route that lies after a restart. `replay()` plus the convergence
 * test already prove the read model rebuilds byte-identically; `projectEvaluationRecords` is
 * a pure function over that model plus two lookup callbacks, so the same guarantee extends to
 * these records without a second mechanism: same inputs, same map, no clock, no counter.
 *
 * Two things deliberately cannot be expressed here:
 *
 *   * **Eligibility is never an input.** A caller cannot pass `eligible: true`. The flag is
 *     derived from the verdict plus the reasons the caller could actually observe
 *     (`evaluateEligibility`), and `assertEvaluationRecord` refuses a record where the
 *     conclusion and the evidence disagree.
 *   * **Money is not mentioned at all.** No field of `EvaluationRecord` is a wei amount, and
 *     nothing here reads the settlement ledger's balances. Payout and benchmark are separate
 *     projections by ADR-0011's design; `GATE-EVAL-09` is the test that keeps a large payout
 *     from being able to move a score.
 */

/** What the verifier said, in the shape this projection is allowed to see. */
export interface EvaluationReportView {
  verdict: EvaluationVerdict;
  phase: EvaluationPhase;
  /** ADR-0013's class. Absent means the caller did not record one, which is itself a fact. */
  replayabilityClass?: ReplayabilityClass;
  evaluatorVersion: string;
  imageDigest?: string;
  /** ISO 8601 UTC — the envelope's own timestamp, never "now". */
  createdAt: string;
  reportVersion: number;
}

export interface EvaluationRunFacts {
  chainId: number;
  trialId: number;
  agentId: number;
  /** The address that funded this trial's reward — `trial.sponsor` on the v1 escrow. */
  funderId: Address;
  /** The runner key the agent has registered; the run's signature is checked against it. */
  registeredRunner: Address | null;
  /** The address that actually signed the run, recovered from the on-chain signature. */
  runSigner: Address | null;
  runHash: Hex;
  transactionHash: Hex;
  blockNumber: number;
  /** Unix milliseconds, from the chain. */
  timestamp: number;
}

export interface EvaluationEvidenceInput {
  manifestCid: string | null;
  manifestDigest: Hex | null;
  /** Set only when the bytes behind the CID re-hash to the digest the chain committed. */
  manifestDigestOk: boolean;
  reportCid: string | null;
  reportDigest: Hex | null;
  reportDigestOk: boolean;
  /** The projection's own suspicion that bytes were swapped after the fact. */
  tampered?: boolean;
}

export interface EvaluationRankingInput {
  cohortId?: string;
  score?: number;
  uncertainty?: number;
  /** A reason only a caller can know, e.g. the cohort this row was asked to be compared against. */
  reasons?: EvaluationExclusionReason[];
}

export interface EvaluationProjectionInput {
  run: EvaluationRunFacts;
  evidence: EvaluationEvidenceInput;
  report: EvaluationReportView | null;
  ranking?: EvaluationRankingInput;
}

/**
 * Every reason the inputs support, computed rather than passed through.
 *
 * The order is stable because the array ends up inside a document somebody may hash: a reason
 * list that shuffled between two runs of the same code would split one evaluation in two.
 *
 * `report` is required because a run with no published verification produces no record at all
 * (see `projectEvaluationRecord`) — "never verified" is an absence, not an exclusion, and the
 * endpoint must not present the two identically. For the same reason `UNVERIFIED` and
 * `MANIFEST_UNRESOLVABLE` are never emitted here: they are the caller's absence cases.
 * `COHORT_INCOMPATIBLE` belongs to whoever compares two rows (`apps/api/src/leaderboards.ts`),
 * not to a projection that sees one.
 */
function deriveReasons(
  run: EvaluationRunFacts,
  evidence: EvaluationEvidenceInput,
  report: EvaluationReportView,
  extra: EvaluationRankingInput | undefined,
): EvaluationExclusionReason[] {
  const reasons: EvaluationExclusionReason[] = [];

  if (evidence.tampered === true) reasons.push("TAMPERED_EVIDENCE");
  if (evidence.manifestDigest === null || !evidence.manifestDigestOk) reasons.push("MANIFEST_DIGEST_MISMATCH");
  if (!evidence.reportDigestOk) reasons.push("REPORT_DIGEST_MISMATCH");
  if (run.registeredRunner === null) reasons.push("RUNNER_UNREGISTERED");
  else if (run.runSigner !== null && run.registeredRunner.toLowerCase() !== run.runSigner.toLowerCase()) {
    reasons.push("IDENTITY_MISMATCH");
  }

  reasons.push(...(extra?.reasons ?? []));
  // Verdict-driven reasons come last and come from one place, so a caller cannot pre-empt them.
  reasons.push(...evaluateEligibility({ verdict: report.verdict, reasons: [] }).exclusionReasons);

  return [...new Set(reasons)];
}

/**
 * Project one run into a canonical record — or into nothing, when there is nothing to bind.
 *
 * Absent evidence and bad evidence are different facts and are not allowed to look alike:
 *
 *   * no manifest CID, or no published report, means **this run has no evaluation record yet**.
 *     Returning a row with a zeroed digest would hand a skeptic something that reads like a
 *     verifiable claim, and it is the same rule the read models already obey in words — an
 *     unknown figure renders as `—`, never as `0`.
 *   * evidence that exists but does not check out produces a record, `eligible: false`, with
 *     the reason named. That is a finding, and findings are what the endpoint is for.
 *
 * `verifiedAt`, `replayability` and `reportVersion` are copied from the verifier's own
 * envelope. A projection that stamped "now" would turn the same evidence into a different
 * record on every rebuild, which is precisely what a deterministic rebuild may not do.
 */
export function projectEvaluationRecord(
  input: EvaluationProjectionInput,
): EvaluationRecord | null {
  const { run, evidence } = input;
  const { report } = input;
  if (evidence.manifestCid === null || evidence.manifestDigest === null) return null;
  if (report === null || evidence.reportCid === null || evidence.reportDigest === null) return null;

  const manifestCid = evidence.manifestCid;
  const manifestDigest = evidence.manifestDigest;
  const reportCid = evidence.reportCid;
  const reportDigest = evidence.reportDigest;

  const eligibility = evaluateEligibility({ verdict: report.verdict, reasons: deriveReasons(run, evidence, report, input.ranking) });
  const runner = run.registeredRunner ?? run.runSigner;
  if (runner === null) return null;

  const record: EvaluationRecord = {
    schemaVersion: 1,
    evaluationId: evaluationIdOf({ chainId: run.chainId, trialId: run.trialId, runHash: run.runHash }),
    runHash: run.runHash,
    identity: {
      chainId: run.chainId,
      trialId: run.trialId,
      agentId: run.agentId,
      funderId: run.funderId,
      runner,
      transactionHash: run.transactionHash,
      blockNumber: run.blockNumber,
      timestamp: run.timestamp,
    },
    evidence: {
      manifestCid,
      manifestDigest,
      verificationReportCid: reportCid,
      verificationReportDigest: reportDigest,
    },
    verification: {
      verdict: report.verdict,
      phase: report.phase,
      replayability: replayabilityFromClass(report.replayabilityClass ?? "undecided"),
      evaluatorVersion: report.evaluatorVersion,
      ...(report.imageDigest ? { evaluatorImageDigest: report.imageDigest } : {}),
      verifiedAt: report.createdAt,
      reportVersion: report.reportVersion,
    },
    ranking: {
      eligible: eligibility.eligible,
      exclusionReasons: eligibility.exclusionReasons,
      ...(input.ranking?.cohortId ? { cohortId: input.ranking.cohortId } : {}),
      ...(typeof input.ranking?.score === "number" ? { score: input.ranking.score } : {}),
      ...(typeof input.ranking?.uncertainty === "number" ? { uncertainty: input.ranking.uncertainty } : {}),
    },
  };

  return assertEvaluationRecord(record);
}

/**
 * Project a set of runs, in a stable order, skipping the ones with nothing bound yet.
 *
 * Content is fetched by the caller and handed in through `EvaluationEvidenceInput`: the
 * projection never opens a file or a socket, so the rebuild guarantee that already covers the
 * read model extends to these records for free — same chain, same disclosures, same map.
 */
export function projectEvaluationRecords(
  inputs: EvaluationProjectionInput[],
): Map<Hex, EvaluationRecord> {
  const out = new Map<Hex, EvaluationRecord>();
  for (const input of [...inputs].sort((a, b) => {
    if (a.run.blockNumber !== b.run.blockNumber) return a.run.blockNumber - b.run.blockNumber;
    return a.run.runHash.localeCompare(b.run.runHash);
  })) {
    const record = projectEvaluationRecord(input);
    if (record !== null) out.set(record.evaluationId.toLowerCase() as Hex, record);
  }
  return out;
}
