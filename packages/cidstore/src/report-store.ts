import { canonicalize } from "json-canonicalize";
import type { Hex } from "viem";
import {
  assertLineage,
  assertVerificationReportEnvelope,
  classifyReplay,
  ReportConflictError,
  verificationReportDigest,
  type VerificationReportEnvelope,
} from "@crucible/smith";
import { CidStore } from "./store.js";

/**
 * The content-store side of the verification version chain.
 *
 * This lives in `@crucible/cidstore` rather than in `@crucible/argus` for one reason that decides
 * the whole file's shape: it needs the content store and the envelope contract, and nothing else.
 * It does not verify, it does not grade, it does not know what a `VerifyReport` contains — the
 * envelope is generic over its payload, so the store reads and writes *documents*, not verdicts.
 *
 * Put it in argus and the API host that serves `GET /evaluations/:id/history` has to depend on
 * argus, which depends on `@crucible/forge-runner`, which is the sandbox SDK. A reader of published
 * evidence would drag a container runtime into its process for a class it never calls. That is the
 * same mistake as a second source of truth, wearing a dependency's clothes.
 *
 * The invariants are `@crucible/smith`'s (`packages/smith-sdk/src/verification-envelope.ts`), and
 * they are enforced here rather than restated: identical bytes are a no-op replay, a different
 * payload for a version that exists throws `ReportConflictError`, and version N has to name the
 * digest of version N-1.
 *
 * There is no second index. The content store is the record, and the per-run version list is
 * derived from it on first use — an index file beside the content would be a second thing able to
 * disagree with the first, which is the mistake ADR-0008 exists to prevent.
 */

/** An envelope whose payload this layer does not interpret. */
export type StoredEnvelope = VerificationReportEnvelope;

export interface VerificationReportWrite {
  cid: string;
  digest: Hex;
  reportVersion: number;
  /** True when these exact bytes were already stored and nothing was written. */
  replayed: boolean;
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

  private static key(runHash: Hex | string): string {
    return runHash.toLowerCase();
  }

  read(cid: string): StoredEnvelope | null {
    const parsed = this.content.getJson<unknown>(cid);
    if (parsed === null) return null;
    try {
      return assertVerificationReportEnvelope(parsed);
    } catch {
      // Not an envelope. The store holds artifacts and disclosures too, so an unrelated
      // document that parses as JSON is not a fault here — it is simply not a verdict.
      return null;
    }
  }

  /** The CID these exact envelope bytes are (or would be) stored under. */
  cidFor(envelope: StoredEnvelope): string {
    return this.content.cidFor(canonicalize(envelope));
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
  append(envelope: StoredEnvelope): VerificationReportWrite {
    const valid = assertVerificationReportEnvelope(envelope);
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
      assertLineage(previousCid === null ? null : this.read(previousCid), valid);
    } else {
      assertLineage(null, valid);
    }

    // Canonical bytes: a skeptic who fetches this CID must get the exact bytes the digest was
    // taken over, not a re-serialisation that happens to agree.
    const cid = this.content.put(canonicalize(valid));
    byRun.set(valid.reportVersion, cid);
    index.set(VerificationReportStore.key(valid.runHash), byRun);
    return { cid, digest, reportVersion: valid.reportVersion, replayed: false };
  }

  versions(runHash: Hex): StoredEnvelope[] {
    const byRun = this.loadIndex().get(VerificationReportStore.key(runHash));
    if (!byRun) return [];
    return [...byRun.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, cid]) => this.read(cid))
      .filter((value): value is StoredEnvelope => value !== null);
  }

  latest(runHash: Hex): StoredEnvelope | null {
    return this.versions(runHash).at(-1) ?? null;
  }

  byCid(cid: string): StoredEnvelope | null {
    return this.read(cid);
  }
}
