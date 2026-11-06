import { canonicalize } from "json-canonicalize";
import { keccak256, stringToHex, type Hex } from "viem";
import type { EvaluationPhase, EvaluationVerdict } from "./evaluation-record.js";

/**
 * One verification result, as a link in a chain that is never overwritten.
 *
 * Argus produces a verdict and then forgets it: `VerifyReport` is a return value, and the
 * only durable copy is the seat's record, which holds **one entry per trial and replaces it**
 * (`apps/juror/src/state.ts`, `Snapshot.version: 1`). That is fine for a vote and wrong for
 * evidence — a re-run under a new evaluator or a new image erases the answer a skeptic
 * already checked. This envelope is the append-only half: every verification of a run is a
 * version, each version names the digest of the one before, and a conflicting write for a
 * version that exists is an error rather than an update.
 *
 * Why `TReport` is a parameter and not `VerifyReport`: `@crucible/argus` depends on
 * `@crucible/smith`, so importing the verifier's type back down into smith would close a
 * cycle the build refuses. The envelope is therefore generic here and closed at
 * `VerificationReportEnvelope<VerifyReport>` where argus is in scope
 * (`packages/argus/src/persistence.ts`).
 */

export const VERIFICATION_REPORT_ENVELOPE_SCHEMA_VERSION = 1 as const;

export interface VerificationReportEvaluator {
  name: "argus";
  version: string;
  rubricVersion?: string;
  imageDigest?: string;
}

/**
 * The minimum the envelope's payload has to say, declared here rather than imported from the
 * evaluator.
 *
 * `VerificationReportEnvelope.result` was typed as Argus's `VerifyReport` in the specification
 * that proposed this document, and it cannot be: `@crucible/argus` depends on `@crucible/smith`,
 * so an import in the other direction closes a cycle the toolchain refuses. That is the same
 * reason the generic exists.
 *
 * The generic alone is not enough, though — a reader that gets `unknown` back either casts (a
 * lie with a type annotation on it) or cannot read the verdict at all, which is the one field
 * every consumer of this document came for. So the four fields that make an envelope *mean*
 * something are validated here, and everything above them — the per-step detail, the re-run
 * results, whatever a future evaluator adds — passes through as the caller declares it.
 *
 * `verdict` and `phase` are the escrow's own vocabulary (`evaluation-record.ts`), not a second
 * enum: Argus's `ArgusVerdict`/`ArgusPhase` are the same three words, and
 * `apps/juror/test/policy.test.ts` is what keeps the translation between them from drifting.
 */
export interface VerificationReportResult {
  verdict: EvaluationVerdict;
  phase: EvaluationPhase;
  steps: unknown[];
  reason: string;
}

export interface VerificationReportEnvelope<TReport = VerificationReportResult> {
  schemaVersion: typeof VERIFICATION_REPORT_ENVELOPE_SCHEMA_VERSION;
  runHash: Hex;
  /** 1-indexed. Version 1 carries no `previousReportDigest`; every later one carries exactly one. */
  reportVersion: number;
  previousReportDigest?: Hex;
  evaluator: VerificationReportEvaluator;
  result: TReport;
  /** ISO 8601 UTC. */
  createdAt: string;
}

/**
 * A write that would replace a verdict somebody already relied on.
 *
 * Distinct from a generic error on purpose: the caller has to be able to tell "this replay is
 * harmless" from "someone is rewriting history" without parsing a message.
 */
export class ReportConflictError extends Error {
  constructor(
    readonly runHash: Hex,
    readonly reportVersion: number,
    reason: string,
  ) {
    super(`verification report conflict for ${runHash} version ${reportVersion}: ${reason}`);
    this.name = "ReportConflictError";
  }
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hex32(value: unknown, path: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new TypeError(`${path}: must be a 32-byte 0x hex string`);
  }
  return value as Hex;
}

/** RFC 8785 canonicalisation, then keccak256 — the same pair `manifestDigest` uses. */
export function verificationReportDigest<TReport>(envelope: VerificationReportEnvelope<TReport>): Hex {
  return keccak256(stringToHex(canonicalize(envelope)));
}

/**
 * Shape-check an envelope parsed from a file, a request or a store read.
 *
 * The version/lineage rule is structural and runs before anything is compared to a peer:
 * version 1 has no predecessor and version N must name one. A file that claims version 3 with
 * no `previousReportDigest` is not an incomplete record, it is a broken chain, and the store
 * must refuse it rather than project it.
 */
export function assertVerificationReportEnvelope<TReport = VerificationReportResult>(
  value: unknown,
): VerificationReportEnvelope<TReport> {
  if (!isRecord(value)) throw new TypeError("envelope: must be an object");
  if (value.schemaVersion !== VERIFICATION_REPORT_ENVELOPE_SCHEMA_VERSION) {
    throw new TypeError(`schemaVersion: must be ${VERIFICATION_REPORT_ENVELOPE_SCHEMA_VERSION}`);
  }
  const runHash = hex32(value.runHash, "runHash");
  if (
    typeof value.reportVersion !== "number" ||
    !Number.isInteger(value.reportVersion) ||
    value.reportVersion < 1
  ) {
    throw new TypeError("reportVersion: must be a whole number >= 1");
  }
  if (!isRecord(value.evaluator) || value.evaluator.name !== "argus") {
    throw new TypeError("evaluator.name: must be \"argus\"");
  }
  if (typeof value.evaluator.version !== "string" || value.evaluator.version.length === 0) {
    throw new TypeError("evaluator.version: must be a non-empty string");
  }
  if (typeof value.createdAt !== "string" || !ISO_UTC.test(value.createdAt)) {
    throw new TypeError("createdAt: must be ISO 8601 in UTC (Z)");
  }
  if (value.result === undefined) throw new TypeError("result: is required");
  // The minimum every reader is allowed to assume. Checked rather than declared, because a
  // payload that reaches this function from disk has never passed through a compiler: an
  // envelope whose `result` has no verdict is not a weakly-typed report, it is a document that
  // cannot mean anything, and the alternative is every consumer casting `unknown` to get at it.
  if (!isRecord(value.result)) throw new TypeError("result: must be an object");
  const result = value.result as Record<string, unknown>;
  if (
    result.verdict !== "break-wins" &&
    result.verdict !== "agent-wins" &&
    result.verdict !== "abstain"
  ) {
    throw new TypeError(`result.verdict: must be "break-wins", "agent-wins" or "abstain"; got ${String(result.verdict)}`);
  }
  if (result.phase !== "deterministic" && result.phase !== "rubric" && result.phase !== "abstain") {
    throw new TypeError(`result.phase: must be "deterministic", "rubric" or "abstain"; got ${String(result.phase)}`);
  }
  if (!Array.isArray(result.steps)) throw new TypeError("result.steps: must be the array of checks the verifier ran");
  if (typeof result.reason !== "string" || result.reason.length === 0) {
    throw new TypeError("result.reason: must be a non-empty string — a verdict nobody can read the reason for is not evidence");
  }

  const envelope: VerificationReportEnvelope<TReport> = {
    schemaVersion: 1,
    runHash,
    reportVersion: value.reportVersion,
    evaluator: {
      name: "argus",
      version: value.evaluator.version,
      ...(typeof value.evaluator.rubricVersion === "string"
        ? { rubricVersion: value.evaluator.rubricVersion }
        : {}),
      ...(typeof value.evaluator.imageDigest === "string"
        ? { imageDigest: value.evaluator.imageDigest }
        : {}),
    },
    result: value.result as TReport,
    createdAt: value.createdAt,
  };

  if (value.reportVersion === 1) {
    if (value.previousReportDigest !== undefined) {
      throw new ReportConflictError(runHash, 1, "version 1 cannot name a predecessor");
    }
  } else {
    if (value.previousReportDigest === undefined) {
      throw new ReportConflictError(runHash, value.reportVersion, "a later version must name its predecessor");
    }
    envelope.previousReportDigest = hex32(value.previousReportDigest, "previousReportDigest");
  }
  return envelope;
}

/**
 * Refuse a chain that skips, repeats or re-attaches a version.
 *
 * `previous` is what the store already holds for `next.reportVersion - 1`. Comparing digests
 * rather than ids is the point: a re-verification that produced a *different* report for the
 * same version is exactly the rewrite this type exists to make impossible.
 */
export function assertLineage<TReport>(
  previous: VerificationReportEnvelope<TReport> | null,
  next: VerificationReportEnvelope<TReport>,
): void {
  if (next.reportVersion === 1) {
    if (previous !== null) {
      throw new ReportConflictError(next.runHash, 1, "a version already exists for this run");
    }
    return;
  }
  if (previous === null) {
    throw new ReportConflictError(
      next.runHash,
      next.reportVersion,
      `version ${next.reportVersion - 1} is not in the store`,
    );
  }
  if (previous.runHash.toLowerCase() !== next.runHash.toLowerCase()) {
    throw new ReportConflictError(next.runHash, next.reportVersion, "the predecessor belongs to another run");
  }
  if (previous.reportVersion !== next.reportVersion - 1) {
    throw new ReportConflictError(
      next.runHash,
      next.reportVersion,
      `the predecessor is version ${previous.reportVersion}, not ${next.reportVersion - 1}`,
    );
  }
  const digest = verificationReportDigest(previous);
  if ((next.previousReportDigest ?? "").toLowerCase() !== digest.toLowerCase()) {
    throw new ReportConflictError(
      next.runHash,
      next.reportVersion,
      "previousReportDigest does not match the digest of the stored predecessor",
    );
  }
}

/**
 * Same bytes, or nothing at all.
 *
 * BullMQ-style at-least-once delivery means the same verification arrives twice as often as
 * it is rewritten. Identical replays are a successful no-op — the caller is told which it
 * got — and any other difference is a conflict, including the harmless-looking ones (a new
 * `createdAt`, a new evaluator version) that would otherwise let a second verdict quietly
 * displace the first under the same version number.
 */
export function classifyReplay<TReport>(
  existing: VerificationReportEnvelope<TReport>,
  incoming: VerificationReportEnvelope<TReport>,
): "replayed" | "conflict" {
  return verificationReportDigest(existing).toLowerCase() === verificationReportDigest(incoming).toLowerCase()
    ? "replayed"
    : "conflict";
}
