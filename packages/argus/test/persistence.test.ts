import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CidStore } from "@crucible/cidstore";
import { canonicalize } from "json-canonicalize";
import type { Hex } from "viem";
import { ReportConflictError, verificationReportDigest } from "@crucible/smith";
import {
  envelopeFromReport,
  recordReplayabilityOf,
  replayabilityClassOf,
  VerificationReportStore,
  type StoredVerificationReport,
} from "../src/persistence.js";
import type { VerifyReport } from "../src/argus.js";

const RUN = `0x${"9c".repeat(32)}` as Hex;
const OTHER_RUN = `0x${"7e".repeat(32)}` as Hex;

function report(over: Partial<VerifyReport> = {}): VerifyReport {
  return {
    verdict: "agent-wins",
    phase: "deterministic",
    steps: [],
    reason: "the pinned suite ran green against the artifact",
    ...over,
  } as VerifyReport;
}

function draft(over: Partial<Parameters<typeof envelopeFromReport>[0]> = {}): StoredVerificationReport {
  return envelopeFromReport({
    runHash: RUN,
    reportVersion: 1,
    evaluator: { version: "1.4.0", rubricVersion: "3", imageDigest: "sha256:aaaa" },
    report: report(),
    createdAt: "2026-11-06T04:30:00Z",
    ...over,
  });
}

describe("publishing a verification", () => {
  it("writes the envelope under a CID and reads it back as the same digest", () => {
    const content = CidStore.inMemory();
    const store = new VerificationReportStore(content);
    const envelope = draft();
    const write = store.append(envelope);

    expect(write.replayed).toBe(false);
    expect(write.reportVersion).toBe(1);
    expect(write.digest).toBe(verificationReportDigest(envelope));
    expect(content.get(write.cid)).toBe(canonicalize(envelope));
    expect(store.byCid(write.cid)).toEqual(envelope);
  });

  it("treats an identical delivery as a no-op rather than a second version", () => {
    const store = VerificationReportStore.inMemory();
    const first = store.append(draft());
    const again = store.append(draft());

    expect(again.replayed).toBe(true);
    expect(again.cid).toBe(first.cid);
    expect(store.versions(RUN)).toHaveLength(1);
  });

  /**
   * The behaviour the whole file exists for.
   *
   * A re-verification that reaches a different conclusion is not an update to version 1. It is
   * version 2, or it is nothing: the alternative is a store where the answer a skeptic already
   * quoted silently becomes the newest answer, which is what `apps/juror/src/state.ts` does
   * today for its own one-per-trial record.
   */
  it("refuses a different report for a version that already exists, and keeps the original", () => {
    const store = VerificationReportStore.inMemory();
    const original = draft();
    const write = store.append(original);

    const rewritten = draft({ report: report({ verdict: "break-wins", reason: "re-ran and it failed" }) });
    expect(() => store.append(rewritten)).toThrow(ReportConflictError);
    expect(store.versions(RUN)).toEqual([original]);
    expect(store.byCid(write.cid)).toEqual(original);
  });

  it("refuses a late write whose timestamp alone moved", () => {
    const store = VerificationReportStore.inMemory();
    store.append(draft());
    expect(() => store.append(draft({ createdAt: "2026-11-06T04:30:01Z" }))).toThrow(/already holds this version/);
  });
});

describe("the version chain", () => {
  it("accepts a second version that names the digest of the first", () => {
    const store = VerificationReportStore.inMemory();
    const first = store.append(draft());
    const second = draft({
      reportVersion: 2,
      previousReportDigest: first.digest,
      report: report({ verdict: "abstain", phase: "abstain", reason: "the suite could not be re-run" }),
      createdAt: "2026-11-06T05:00:00Z",
    });
    const write = store.append(second);

    expect(write.replayed).toBe(false);
    expect(store.versions(RUN).map((e) => e.reportVersion)).toEqual([1, 2]);
    expect(store.latest(RUN)?.reportVersion).toBe(2);
    expect(store.latest(RUN)?.previousReportDigest).toBe(first.digest);
  });

  it("refuses a second version that names no predecessor", () => {
    const store = VerificationReportStore.inMemory();
    store.append(draft());
    expect(() => store.append(draft({ reportVersion: 2 }))).toThrow(/must name its predecessor/);
  });

  it("refuses a second version that names the wrong predecessor", () => {
    const store = VerificationReportStore.inMemory();
    store.append(draft());
    expect(() =>
      store.append(draft({ reportVersion: 2, previousReportDigest: `0x${"00".repeat(32)}` })),
    ).toThrow(/does not match the digest of the stored predecessor/);
  });

  it("refuses a chain that skips a version rather than healing the gap on write", () => {
    const store = VerificationReportStore.inMemory();
    const first = store.append(draft());
    expect(() =>
      store.append(draft({ reportVersion: 3, previousReportDigest: first.digest })),
    ).toThrow(/version 2 is not in the store/);
    expect(store.versions(RUN)).toHaveLength(1);
  });

  it("keeps runs apart: another run's digest will not pass for a predecessor", () => {
    const store = VerificationReportStore.inMemory();
    const firstRun = store.append(draft());
    store.append(draft({ runHash: OTHER_RUN }));
    expect(store.versions(RUN)).toHaveLength(1);
    expect(store.versions(OTHER_RUN)).toHaveLength(1);

    // OTHER_RUN does have a version 1, so this reaches the lineage check rather than the
    // missing-predecessor one — and a real digest belonging to a different run must still be
    // refused, or one long chain could be spliced across two evaluations.
    expect(() =>
      store.append(draft({ runHash: OTHER_RUN, reportVersion: 2, previousReportDigest: firstRun.digest })),
    ).toThrow(/does not match the digest of the stored predecessor/);
  });
});

describe("the store has no second index", () => {
  it("re-derives the whole chain from the content store after a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "crucible-reports-"));
    try {
      const writer = new VerificationReportStore(new CidStore({ dir }));
      const first = writer.append(draft());
      writer.append(
        draft({ reportVersion: 2, previousReportDigest: first.digest, createdAt: "2026-11-06T05:00:00Z" }),
      );

      const reader = new VerificationReportStore(new CidStore({ dir }));
      expect(reader.versions(RUN).map((e) => e.reportVersion)).toEqual([1, 2]);
      // The same bytes, so the same CID: an index rebuilt from content must agree with the one
      // the writer held in memory, or "the store is the record" is a slogan.
      expect(reader.append(draft()).cid).toBe(first.cid);
      expect(reader.append(draft()).replayed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the replayability class", () => {
  /**
   * `apps/juror/src/policy.ts` owns this rule for the seat's seal; this package cannot import
   * an app, so the mapping is restated and the agreement is asserted in
   * `apps/juror/test/policy.test.ts`. These are the same three rows from the other side.
   */
  it("follows the phase, never the verdict", () => {
    expect(replayabilityClassOf(report({ phase: "deterministic", verdict: "agent-wins" }))).toBe("artifact-replayable");
    expect(replayabilityClassOf(report({ phase: "deterministic", verdict: "break-wins" }))).toBe("artifact-replayable");
    expect(replayabilityClassOf(report({ phase: "rubric", verdict: "agent-wins" }))).toBe("generation-attested");
    expect(replayabilityClassOf(report({ phase: "abstain", verdict: "abstain" }))).toBe("undecided");
  });

  it("carries the class into the record's word without calling an attested run nondeterministic", () => {
    expect(recordReplayabilityOf(report({ phase: "deterministic" }))).toBe("deterministic");
    expect(recordReplayabilityOf(report({ phase: "rubric" }))).toBe("partial");
    expect(recordReplayabilityOf(report({ phase: "abstain" }))).toBe("nondeterministic");
  });
});
