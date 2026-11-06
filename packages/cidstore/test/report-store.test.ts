import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalize } from "json-canonicalize";
import type { Hex } from "viem";
import { ReportConflictError, verificationReportDigest, type VerificationReportEnvelope } from "@crucible/smith";
import { CidStore } from "../src/store.js";
import { VerificationReportStore } from "../src/report-store.js";

/**
 * The content-store half of the verification version chain, tested without an evaluator.
 *
 * These cases came over from `packages/argus/test/persistence.test.ts` when the class moved here,
 * and the import list above is the finding: this file does not import `@crucible/argus` at all.
 * That is what the move was for — the API host that serves `GET /evaluations/:id/history` reads
 * these documents and must not need the sandbox SDK to do it. If this file ever needs argus, the
 * dependency has crept back and the reader is carrying a container runtime again.
 *
 * `result` is a well-formed report payload rather than an opaque token: the envelope contract
 * validates the minimum every reader assumes (verdict, phase, steps, reason), so a fixture that
 * skipped them would be testing a document no store would accept.
 */

const RUN = `0x${"9c".repeat(32)}` as Hex;
const OTHER_RUN = `0x${"7e".repeat(32)}` as Hex;

type Envelope = VerificationReportEnvelope;

function result(over: Partial<Envelope["result"]> = {}): Envelope["result"] {
  return {
    verdict: "agent-wins",
    phase: "deterministic",
    steps: [],
    reason: "the pinned suite ran green against the artifact",
    ...over,
  };
}

function envelope(over: Partial<Envelope> = {}): Envelope {
  return {
    schemaVersion: 1,
    runHash: RUN,
    reportVersion: 1,
    evaluator: { name: "argus", version: "1.4.0", rubricVersion: "3", imageDigest: "sha256:aaaa" },
    result: result(),
    createdAt: "2026-11-06T04:30:00Z",
    ...over,
  };
}

describe("publishing a verification", () => {
  it("writes the envelope under a CID and reads it back as the same digest", () => {
    const store = VerificationReportStore.inMemory();
    const first = envelope();
    const write = store.append(first);
    expect(write.replayed).toBe(false);
    expect(write.cid).toBe(store.cidFor(first));
    const read = store.byCid(write.cid);
    expect(read).not.toBeNull();
    expect(verificationReportDigest(read!)).toBe(write.digest);
  });

  it("treats an identical delivery as a no-op rather than a second version", () => {
    const store = VerificationReportStore.inMemory();
    const first = envelope();
    const write = store.append(first);
    const again = store.append(first);
    expect(again.replayed).toBe(true);
    expect(again.cid).toBe(write.cid);
    expect(store.versions(RUN)).toHaveLength(1);
  });

  it("refuses a different report for a version that already exists, and keeps the original", () => {
    const store = VerificationReportStore.inMemory();
    const first = envelope();
    const write = store.append(first);
    expect(() => store.append(envelope({ result: result({ verdict: "break-wins", reason: "the break reproduced" }) }))).toThrow(
      ReportConflictError,
    );
    // The refusal is the whole point, so the original has to still be there.
    expect(store.byCid(write.cid)).toEqual(first);
    expect(store.versions(RUN)).toHaveLength(1);
  });

  it("refuses a late write whose timestamp alone moved", () => {
    const store = VerificationReportStore.inMemory();
    store.append(envelope());
    expect(() => store.append(envelope({ createdAt: "2026-11-06T04:30:01Z" }))).toThrow(ReportConflictError);
  });
});

describe("the version chain", () => {
  it("accepts a second version that names the digest of the first", () => {
    const store = VerificationReportStore.inMemory();
    const first = store.append(envelope());
    const second = store.append(
      envelope({
        reportVersion: 2,
        previousReportDigest: first.digest,
        result: result({ verdict: "break-wins", reason: "the break reproduced" }),
        createdAt: "2026-11-06T05:00:00Z",
      }),
    );
    expect(second.replayed).toBe(false);
    expect(store.versions(RUN).map((e) => e.reportVersion)).toEqual([1, 2]);
    expect(store.latest(RUN)!.reportVersion).toBe(2);
  });

  it("refuses a second version that names no predecessor", () => {
    const store = VerificationReportStore.inMemory();
    store.append(envelope());
    expect(() => store.append(envelope({ reportVersion: 2 }))).toThrow(/lineage|predecessor/i);
  });

  it("refuses a second version that names the wrong predecessor", () => {
    const store = VerificationReportStore.inMemory();
    store.append(envelope());
    expect(() =>
      store.append(envelope({ reportVersion: 2, previousReportDigest: `0x${"11".repeat(32)}` as Hex })),
    ).toThrow(/lineage|predecessor/i);
  });

  it("refuses a chain that skips a version rather than healing the gap on write", () => {
    const store = VerificationReportStore.inMemory();
    const first = store.append(envelope());
    expect(() => store.append(envelope({ reportVersion: 3, previousReportDigest: first.digest }))).toThrow(
      ReportConflictError,
    );
    expect(store.versions(RUN)).toHaveLength(1);
  });

  it("keeps runs apart: another run's digest will not pass for a predecessor", () => {
    const store = VerificationReportStore.inMemory();
    const other = store.append(envelope({ runHash: OTHER_RUN }));
    expect(() => store.append(envelope({ reportVersion: 2, previousReportDigest: other.digest }))).toThrow(
      ReportConflictError,
    );
  });
});

/**
 * The invariant the whole design rests on: the content store is the record.
 *
 * A restart here is not a simulation of a restart — it is the same directory in a new store
 * instance, so the eviction ledger, the in-memory index and every cached digest are gone, exactly
 * as they are when a container is replaced. What has to survive is only what was written as bytes.
 */
describe("the store has no second index", () => {
  it("re-derives the whole chain from the content store after a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "crucible-reports-"));
    try {
      const content = new CidStore({ dir });
      const first = new VerificationReportStore(content);
      const write = first.append(envelope());
      first.append(
        envelope({
          reportVersion: 2,
          previousReportDigest: write.digest,
          result: result({ verdict: "break-wins", reason: "the break reproduced" }),
          createdAt: "2026-11-06T05:00:00Z",
        }),
      );

      const reopened = new VerificationReportStore(new CidStore({ dir }));
      expect(reopened.versions(RUN).map((e) => e.reportVersion)).toEqual([1, 2]);
      expect(verificationReportDigest(reopened.latest(RUN)!)).not.toBe(write.digest);
      // And the bytes behind the first version are still the first version, not a re-serialisation.
      expect(canonicalize(reopened.byCid(write.cid))).toBe(canonicalize(envelope()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores documents in the same store that are not envelopes", () => {
    const content = CidStore.inMemory();
    content.putJson({ hello: "world" });
    content.putJson({ schemaVersion: 1, runHash: RUN });
    const store = new VerificationReportStore(content);
    store.append(envelope());
    expect(store.versions(RUN)).toHaveLength(1);
  });
});
