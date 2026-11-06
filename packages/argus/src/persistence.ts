import { canonicalize } from "json-canonicalize";
import type { Hex } from "viem";
import {
  assertLineage,
  assertVerificationReportEnvelope,
  classifyReplay,
  ReportConflictError,
  replayabilityFromClass,
  verificationReportDigest,
  type EvaluationReplayability,
  type ReplayabilityClass,
  type VerificationReportEnvelope,
} from "@crucible/smith";
import type { VerifyReport } from "./argus.js";

/**
 * The one place a verdict stops being a return value.
 *
 * `Argus.verify` answers a `VerifyReport` and nothing else keeps it: the seat writes its own
 * durable record, and that record holds **one entry per trial and replaces it** when the
 * trial is re-verified (`apps/juror/src/state.ts`, `Snapshot.version: 1`). For a vote that is
 * right. For evidence it is not — a skeptic who cited yesterday's re-run finds today's in its
 * place with no marker that anything was overwritten.
 *
 * So a verification is published here as a versioned envelope in the same content-addressed
 * store the artifacts live in, each version naming the digest of the one before. Writes are
 * append-only by construction: an identical delivery is a no-op that says so, and any other
 * difference against an existing version throws `ReportConflictError` rather than replacing
 * bytes somebody has already quoted.
 *
 * There is no second index. The content store is the record, and the per-run version list is
 * derived from it on first use — an index file beside the content would be a second thing to
 * disagree with the first, which is the mistake ADR-0008 exists to prevent.
 */

export type StoredVerificationReport = VerificationReportEnvelope<VerifyReport>;

export interface EnvelopeDraft {
  runHash: Hex;
  reportVersion: number;
  /** Required from version 2 on; `assertLineage` is what enforces that. */
  previousReportDigest?: Hex;
  evaluator: {
    version: string;
    rubricVersion?: string;
    imageDigest?: string;
  };
  report: VerifyReport;
  /** ISO 8601 UTC. Passed in rather than read from a clock so a test can pin the bytes. */
  createdAt: string;
}

/**
 * The rule in `apps/juror/src/policy.ts:249`, restated here because a package cannot import
 * an app — and a restatement is exactly two chances to disagree, so `apps/juror/test/policy.test.ts`
 * asserts the two functions answer identically for all three phases. Change one and that test
 * goes red; nothing here is trusted to stay in step on its own.
 *
 * Derived from `phase`, never from `verdict`: a break that won on a deterministic suite is
 * just as replayable as one that lost. ADR-0013 says the class describes what can be
 * re-executed, not who was paid.
 */
export function replayabilityClassOf(report: VerifyReport): ReplayabilityClass {
  if (report.phase === "abstain") return "undecided";
  return report.phase === "deterministic" ? "artifact-replayable" : "generation-attested";
}

/** The record's wire word for that class, in the one place the translation is allowed. */
export function recordReplayabilityOf(report: VerifyReport): EvaluationReplayability {
  return replayabilityFromClass(replayabilityClassOf(report));
}

export function envelopeFromReport(draft: EnvelopeDraft): StoredVerificationReport {
  return assertVerificationReportEnvelope<VerifyReport>({
    schemaVersion: 1,
    runHash: draft.runHash,
    reportVersion: draft.reportVersion,
    ...(draft.previousReportDigest ? { previousReportDigest: draft.previousReportDigest } : {}),
    evaluator: {
      name: "argus",
      version: draft.evaluator.version,
      ...(draft.evaluator.rubricVersion ? { rubricVersion: draft.evaluator.rubricVersion } : {}),
      ...(draft.evaluator.imageDigest ? { imageDigest: draft.evaluator.imageDigest } : {}),
    },
    result: draft.report,
    createdAt: draft.createdAt,
  });
}

/**
 * The store itself lives in `@crucible/cidstore` (`packages/cidstore/src/report-store.ts`), and
 * this line is the whole reason it moved.
 *
 * It started here, in the evaluator, and the first thing that needed to *read* published reports
 * was the API host serving `GET /evaluations/:id/history`. Depending on `@crucible/argus` for a
 * class that never verifies would have pulled `@crucible/forge-runner` — the sandbox SDK — into
 * the API's runtime graph for an index over bytes. The store needs a `CidStore` and the envelope
 * contract from `@crucible/smith`; it does not need a verdict, a bench, or the word "Argus"
 * outside `evaluator.name`. So it lives beside the store it reads, one implementation, reached
 * from both sides.
 *
 * `VerificationReportWrite` is re-exported for the same reason: it is the store's return type,
 * not argus's.
 */
export { VerificationReportStore } from "@crucible/cidstore";
export type { VerificationReportWrite, StoredEnvelope } from "@crucible/cidstore";

