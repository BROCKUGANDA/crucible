import { canonicalize } from "json-canonicalize";
import { encodeAbiParameters, getAddress, isAddress, keccak256, stringToHex, type Address, type Hex } from "viem";

/**
 * The canonical record of one evaluation of one run.
 *
 * This is the *evaluation* document. It is deliberately not the settlement document: money
 * moves on the chain's own books (`CrucibleTrials.settle` and the pull ledger), the hall
 * projects that, and nothing here can move an ETH credit. The separation is ADR-0011's
 * "verdict bodies stay pure" clause wearing a different hat, and `GATE-EVAL-09` is the test
 * that keeps it true.
 *
 * Two of its fields are constrained by decisions older than this file, and both are stated
 * here so the next reader does not "fix" them by accident:
 *
 *   * `verification.replayability` is a **wire vocabulary**, not the durable fact. The fact
 *     is ADR-0013's replayability class (`artifact-replayable | generation-attested |
 *     undecided`), recorded by the seat in `apps/juror`. `replayabilityFromClass` is the one
 *     allowed translation, and it is one-directional: a record is derived from a seal, never
 *     the other way round.
 *   * `ranking.score` and `ranking.uncertainty` arrive as numbers because that is what a
 *     benchmark API returns, but they never enter a hash as floats. `canonicalEvaluationRecord`
 *     fixes them to six decimals before canonicalisation, which is the same rule
 *     `docs/adr/0011-*.md` applies to verdict bodies and `manifestDigest` applies to the
 *     manifest's numeric pins.
 */

export const EVALUATION_RECORD_SCHEMA_VERSION = 1 as const;

/** Why a record exists but does not count. Every reason is a fact about evidence, not a judgement. */
export type EvaluationExclusionReason =
  | "UNVERIFIED"
  | "VERDICT_ABSTAIN"
  | "VERDICT_BREAK_WINS"
  | "IDENTITY_MISMATCH"
  | "RUNNER_UNREGISTERED"
  | "MANIFEST_UNRESOLVABLE"
  | "MANIFEST_DIGEST_MISMATCH"
  | "REPORT_DIGEST_MISMATCH"
  | "COHORT_INCOMPATIBLE"
  | "TAMPERED_EVIDENCE";

const EXCLUSION_REASONS: readonly EvaluationExclusionReason[] = [
  "UNVERIFIED",
  "VERDICT_ABSTAIN",
  "VERDICT_BREAK_WINS",
  "IDENTITY_MISMATCH",
  "RUNNER_UNREGISTERED",
  "MANIFEST_UNRESOLVABLE",
  "MANIFEST_DIGEST_MISMATCH",
  "REPORT_DIGEST_MISMATCH",
  "COHORT_INCOMPATIBLE",
  "TAMPERED_EVIDENCE",
];

export type EvaluationVerdict = "break-wins" | "agent-wins" | "abstain";
export type EvaluationPhase = "deterministic" | "rubric" | "abstain";
export type EvaluationReplayability = "deterministic" | "partial" | "nondeterministic";

/** ADR-0013's durable classes, spelled the way the seat spells them. */
export type ReplayabilityClass = "artifact-replayable" | "generation-attested" | "undecided";

/**
 * The one translation from the recorded class to the wire value.
 *
 * `generation-attested` becomes `partial` rather than `nondeterministic` on purpose: the
 * artifact, the logs, the signature and the seat votes all replay; only generation itself
 * does not. Calling that nondeterministic would understate the evidence a skeptic can
 * re-check, which is the distinction ADR-0013 exists to preserve.
 */
export function replayabilityFromClass(value: ReplayabilityClass): EvaluationReplayability {
  if (value === "artifact-replayable") return "deterministic";
  if (value === "generation-attested") return "partial";
  return "nondeterministic";
}

export interface EvaluationRecordIdentity {
  chainId: number;
  trialId: number;
  agentId: number;
  /** The address that funded the trial's reward, as recorded by the projection. */
  funderId: Address;
  /** The runner key the agent registered; the signature on the run is checked against it. */
  runner: Address;
  transactionHash: Hex;
  blockNumber: number;
  /** Unix milliseconds. */
  timestamp: number;
}

export interface EvaluationRecordEvidence {
  manifestCid: string;
  manifestDigest: Hex;
  verificationReportCid: string;
  verificationReportDigest: Hex;
}

export interface EvaluationRecordVerification {
  verdict: EvaluationVerdict;
  phase: EvaluationPhase;
  replayability: EvaluationReplayability;
  evaluatorVersion: string;
  evaluatorImageDigest?: string;
  /** ISO 8601, UTC, second precision or finer. */
  verifiedAt: string;
  reportVersion: number;
}

export interface EvaluationRecordRanking {
  eligible: boolean;
  exclusionReasons: EvaluationExclusionReason[];
  cohortId?: string;
  /** Normalized benchmark accuracy, 0..1. Never a money amount. */
  score?: number;
  /** 95% interval half-width or standard error, in the same units as `score`. */
  uncertainty?: number;
}

export interface EvaluationRecord {
  schemaVersion: typeof EVALUATION_RECORD_SCHEMA_VERSION;
  evaluationId: Hex;
  runHash: Hex;
  identity: EvaluationRecordIdentity;
  evidence: EvaluationRecordEvidence;
  verification: EvaluationRecordVerification;
  ranking: EvaluationRecordRanking;
}

export class EvaluationRecordError extends Error {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "EvaluationRecordError";
  }
}

/**
 * `keccak256(abi.encode(chainId, trialId, runHash))`.
 *
 * `abi.encode`, not `encodePacked`: packing two decimal integers of unbounded width lets
 * `(1, 23)` and `(12, 3)` collide, and this value is the key a public route dereferences.
 */
export function evaluationIdOf(input: { chainId: number; trialId: number; runHash: Hex }): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: "chainId", type: "uint256" },
        { name: "trialId", type: "uint256" },
        { name: "runHash", type: "bytes32" },
      ],
      [BigInt(input.chainId), BigInt(input.trialId), input.runHash],
    ),
  );
}

/**
 * The record with its float fields fixed to a canonical decimal string.
 *
 * Used for hashing only; the API still serves the numbers callers expect. Six decimals is
 * far finer than any accuracy or interval reported here, and rounding is not applied
 * silently — `assertCanonicalNumber`-style, a value that needs a seventh decimal is refused
 * rather than quietly shortened, because a shortened number inside a digest is a document
 * that hashes two ways depending on who wrote it.
 */
export function canonicalEvaluationRecord(record: EvaluationRecord): Record<string, unknown> {
  return {
    ...record,
    ranking: {
      ...record.ranking,
      score: fixedScore(record.ranking.score, "ranking.score"),
      uncertainty: fixedScore(record.ranking.uncertainty, "ranking.uncertainty"),
    },
  };
}

function fixedScore(value: number | undefined, path: string): string | undefined {
  if (value === undefined) return undefined;
  const scaled = value * 1_000_000;
  if (!Number.isFinite(scaled) || Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    throw new EvaluationRecordError(path, "must be expressible in at most six decimal places");
  }
  return (Math.round(scaled) / 1_000_000).toFixed(6);
}

/** RFC 8785 canonicalisation, then keccak256 — the same pair `manifestDigest` uses. */
export function evaluationRecordDigest(record: EvaluationRecord): Hex {
  return keccak256(stringToHex(canonicalize(canonicalEvaluationRecord(record))));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireHex32(value: unknown, path: string): Hex {
  // Spelled out rather than left to a length-plus-parity helper: "32 bytes" is the invariant
  // every caller of this record depends on, and a check that says it in one line cannot be
  // quietly reinterpreted by a dependency that changes what "strict" means.
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new EvaluationRecordError(path, "must be a 32-byte 0x hex string");
  }
  return value as Hex;
}

function requireAddress(value: unknown, path: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new EvaluationRecordError(path, "must be a valid address");
  }
  // Checksummed on the way in, so one address hashes one way. A record written by a service
  // that lowercases and a record written by one that checksums are the same fact, and a
  // digest that notices the difference would split an evaluation in two.
  return getAddress(value);
}

function requireWholeNumber(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new EvaluationRecordError(path, `must be a whole number >= ${minimum}`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EvaluationRecordError(path, "must be a non-empty string");
  }
  return value;
}

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new EvaluationRecordError(path, `must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function requireUnitRange(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new EvaluationRecordError(path, "must be a finite number between 0 and 1");
  }
  return value;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/**
 * Refuse a record that could not have been produced by the pipeline that writes it.
 *
 * The rules are the sequence diagram's, and they are enforced here rather than trusted from
 * a caller: the id must be the id its own identity implies; an eligible record must carry an
 * `agent-wins` verdict and no reasons; a reason must be accompanied by `eligible: false`;
 * score and uncertainty must be in range when present; and the timestamps must be what they
 * claim to be.
 */
export function assertEvaluationRecord(value: unknown): EvaluationRecord {
  if (!isRecord(value)) throw new EvaluationRecordError("record", "must be an object");
  if (value.schemaVersion !== EVALUATION_RECORD_SCHEMA_VERSION) {
    throw new EvaluationRecordError("schemaVersion", `must be ${EVALUATION_RECORD_SCHEMA_VERSION}`);
  }

  const evaluationId = requireHex32(value.evaluationId, "evaluationId");
  const runHash = requireHex32(value.runHash, "runHash");

  if (!isRecord(value.identity)) throw new EvaluationRecordError("identity", "must be an object");
  const identity = {
    chainId: requireWholeNumber(value.identity.chainId, "identity.chainId", 1),
    trialId: requireWholeNumber(value.identity.trialId, "identity.trialId", 1),
    agentId: requireWholeNumber(value.identity.agentId, "identity.agentId", 1),
    funderId: requireAddress(value.identity.funderId, "identity.funderId"),
    runner: requireAddress(value.identity.runner, "identity.runner"),
    transactionHash: requireHex32(value.identity.transactionHash, "identity.transactionHash"),
    blockNumber: requireWholeNumber(value.identity.blockNumber, "identity.blockNumber", 1),
    timestamp: requireWholeNumber(value.identity.timestamp, "identity.timestamp", 1),
  };

  const derived = evaluationIdOf({ chainId: identity.chainId, trialId: identity.trialId, runHash });
  if (derived.toLowerCase() !== evaluationId.toLowerCase()) {
    throw new EvaluationRecordError("evaluationId", "does not match keccak256(abi.encode(chainId, trialId, runHash))");
  }

  if (!isRecord(value.evidence)) throw new EvaluationRecordError("evidence", "must be an object");
  const evidence: EvaluationRecordEvidence = {
    manifestCid: requireString(value.evidence.manifestCid, "evidence.manifestCid"),
    manifestDigest: requireHex32(value.evidence.manifestDigest, "evidence.manifestDigest"),
    verificationReportCid: requireString(value.evidence.verificationReportCid, "evidence.verificationReportCid"),
    verificationReportDigest: requireHex32(
      value.evidence.verificationReportDigest,
      "evidence.verificationReportDigest",
    ),
  };

  if (!isRecord(value.verification)) throw new EvaluationRecordError("verification", "must be an object");
  const verification: EvaluationRecordVerification = {
    verdict: requireOneOf(value.verification.verdict, ["break-wins", "agent-wins", "abstain"] as const, "verification.verdict"),
    phase: requireOneOf(value.verification.phase, ["deterministic", "rubric", "abstain"] as const, "verification.phase"),
    replayability: requireOneOf(
      value.verification.replayability,
      ["deterministic", "partial", "nondeterministic"] as const,
      "verification.replayability",
    ),
    evaluatorVersion: requireString(value.verification.evaluatorVersion, "verification.evaluatorVersion"),
    verifiedAt: (() => {
      const raw = requireString(value.verification.verifiedAt, "verification.verifiedAt");
      if (!ISO_UTC.test(raw)) throw new EvaluationRecordError("verification.verifiedAt", "must be ISO 8601 in UTC (Z)");
      return raw;
    })(),
    reportVersion: requireWholeNumber(value.verification.reportVersion, "verification.reportVersion", 1),
  };
  if (typeof value.verification.evaluatorImageDigest === "string") {
    verification.evaluatorImageDigest = value.verification.evaluatorImageDigest;
  } else if (value.verification.evaluatorImageDigest !== undefined) {
    throw new EvaluationRecordError("verification.evaluatorImageDigest", "must be a string when present");
  }

  if (!isRecord(value.ranking)) throw new EvaluationRecordError("ranking", "must be an object");
  const rawReasons = value.ranking.exclusionReasons;
  if (!Array.isArray(rawReasons)) {
    throw new EvaluationRecordError("ranking.exclusionReasons", "must be an array (empty when nothing excludes the row)");
  }
  const exclusionReasons = rawReasons.map((reason, i) =>
    requireOneOf(reason, EXCLUSION_REASONS, `ranking.exclusionReasons[${i}]`),
  );
  if (new Set(exclusionReasons).size !== exclusionReasons.length) {
    throw new EvaluationRecordError("ranking.exclusionReasons", "must not repeat a reason");
  }
  const ranking: EvaluationRecordRanking = {
    eligible: (() => {
      if (typeof value.ranking?.eligible !== "boolean") {
        throw new EvaluationRecordError("ranking.eligible", "must be a boolean");
      }
      return value.ranking.eligible;
    })(),
    exclusionReasons,
  };
  if (typeof value.ranking.cohortId === "string") ranking.cohortId = value.ranking.cohortId;
  else if (value.ranking.cohortId !== undefined) throw new EvaluationRecordError("ranking.cohortId", "must be a string");
  if (typeof value.ranking.score === "number") ranking.score = requireUnitRange(value.ranking.score, "ranking.score");
  else if (value.ranking.score !== undefined) throw new EvaluationRecordError("ranking.score", "must be a number");
  if (typeof value.ranking.uncertainty === "number") {
    if (!Number.isFinite(value.ranking.uncertainty) || value.ranking.uncertainty < 0) {
      throw new EvaluationRecordError("ranking.uncertainty", "must be a finite number >= 0");
    }
    ranking.uncertainty = value.ranking.uncertainty;
  } else if (value.ranking.uncertainty !== undefined) {
    throw new EvaluationRecordError("ranking.uncertainty", "must be a number");
  }
  // Refuse a digest over a record whose numbers cannot be written canonically.
  fixedScore(ranking.score, "ranking.score");
  fixedScore(ranking.uncertainty, "ranking.uncertainty");

  // The eligibility law, in one place: only an `agent-wins` verdict with clean evidence ranks.
  if (ranking.eligible) {
    if (verification.verdict !== "agent-wins") {
      throw new EvaluationRecordError("ranking.eligible", "requires verification.verdict = agent-wins");
    }
    if (exclusionReasons.length > 0) {
      throw new EvaluationRecordError("ranking.eligible", "cannot be true while exclusionReasons is not empty");
    }
  } else if (exclusionReasons.length === 0) {
    throw new EvaluationRecordError("ranking.exclusionReasons", "must name at least one reason when eligible is false");
  }

  return { schemaVersion: 1, evaluationId, runHash, identity, evidence, verification, ranking };
}

/**
 * Decide eligibility from the facts a projection holds.
 *
 * Kept separate from construction so the caller cannot pass `eligible: true` alongside the
 * evidence that contradicts it and have the contradiction simply be believed.
 */
export function evaluateEligibility(input: {
  verdict: EvaluationVerdict | null;
  reasons?: EvaluationExclusionReason[];
}): Pick<EvaluationRecordRanking, "eligible" | "exclusionReasons"> {
  const reasons = [...(input.reasons ?? [])];
  if (input.verdict === null) reasons.push("UNVERIFIED");
  else if (input.verdict === "abstain") reasons.push("VERDICT_ABSTAIN");
  else if (input.verdict === "break-wins") reasons.push("VERDICT_BREAK_WINS");
  const unique = [...new Set(reasons)];
  return { eligible: input.verdict === "agent-wins" && unique.length === 0, exclusionReasons: unique };
}

export const EVALUATION_EXCLUSION_REASONS = EXCLUSION_REASONS;
