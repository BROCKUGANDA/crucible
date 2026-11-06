import { CidStore } from "@crucible/cidstore";
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

export interface VerificationReportWrite {
  cid: string;
  digest: Hex;
  reportVersion: number;
  /** True when these exact bytes were already stored and nothing was written. */
  replayed: boolean;
}

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

export class VerificationReportStore {
  private readonly content: CidStore;
  private index: Map<string, Map<number, string>> | null = null;

  constructor(content: CidStore) {
    this.content = content;
  }

  static inMemory(): VerificationReportStore {
    return new VerificationReportStore(CidStore.inMemory());
  }

  private static key(runHash: Hex): string {
    return runHash.toLowerCase();
  }

  private read(cid: string): StoredVerificationReport | null {
    const parsed = this.content.getJson<unknown>(cid);
    if (parsed === null) return null;
    try {
      return assertVerificationReportEnvelope<VerifyReport>(parsed);
    } catch {
      // Not an envelope. The store holds artifacts and disclosures too, so an unrelated
      // document that parses as JSON is not a fault here — it is simply not a verdict.
      return null;
    }
  }

  /** Read every stored document once and group the envelopes by run and version. */
  private loadIndex(): Map<string, Map<number, string>> {
    if (this.index !== null) return this.index;
    const built = new Map<string, Map<number, string>>();
    for (const cid of this.content.list()) {
      const envelope = this.read(cid);
      if (envelope === null) continue;
      const byRun = built.get(VerificationReportStore.key(envelope.runHash)) ?? new Map<number, string>();
      // Two CIDs for one version can only mean two payloads. Keep the lexicographically
      // smallest so the refusal a caller gets is deterministic across restarts, and let
      // `append` raise the conflict rather than picking a winner by write order.
      const held = byRun.get(envelope.reportVersion);
      if (held === undefined || cid < held) byRun.set(envelope.reportVersion, cid);
      built.set(VerificationReportStore.key(envelope.runHash), byRun);
    }
    this.index = built;
    return built;
  }

  /**
   * Append one verification.
   *
   * The order is the safety: validate the shape, resolve the predecessor the envelope claims,
   * assert the lineage against what is actually stored, and only then write. A rejected append
   * leaves nothing behind, so a caller can retry without asking whether half a chain landed.
   */
  append(envelope: StoredVerificationReport): VerificationReportWrite {
    const valid = assertVerificationReportEnvelope<VerifyReport>(envelope);
    const index = this.loadIndex();
    const byRun = index.get(VerificationReportStore.key(valid.runHash)) ?? new Map<number, string>();
    const digest = verificationReportDigest(valid);

    const atVersion = byRun.get(valid.reportVersion);
    if (atVersion !== undefined) {
      const stored = this.read(atVersion);
      if (stored !== null && classifyReplay(stored, valid) === "replayed") {
        return { cid: atVersion, digest, reportVersion: valid.reportVersion, replayed: true };
      }
      throw new ReportConflictError(valid.runHash, valid.reportVersion, "a different report already holds this version");
    }

    if (valid.reportVersion > 1) {
      const previousCid = byRun.get(valid.reportVersion - 1) ?? null;
      assertLineage<VerifyReport>(previousCid === null ? null : this.read(previousCid), valid);
    } else {
      assertLineage<VerifyReport>(null, valid);
    }

    // Canonical bytes: a skeptic who fetches this CID must get the exact bytes the digest was
    // taken over, not a re-serialisation that happens to agree.
    const cid = this.content.put(canonicalize(valid));
    byRun.set(valid.reportVersion, cid);
    index.set(VerificationReportStore.key(valid.runHash), byRun);
    return { cid, digest, reportVersion: valid.reportVersion, replayed: false };
  }

  versions(runHash: Hex): StoredVerificationReport[] {
    const byRun = this.loadIndex().get(VerificationReportStore.key(runHash));
    if (!byRun) return [];
    return [...byRun.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, cid]) => this.read(cid))
      .filter((value): value is StoredVerificationReport => value !== null);
  }

  latest(runHash: Hex): StoredVerificationReport | null {
    return this.versions(runHash).at(-1) ?? null;
  }

  byCid(cid: string): StoredVerificationReport | null {
    return this.read(cid);
  }
}
