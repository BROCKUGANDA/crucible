/**
 * @file studio-reproducibility.test.ts — would this result repeat?
 *
 * The rule the Studio enforces: three independent replays of the same
 * pinned task, and a verdict that says whether they agreed.
 *
 * The interesting cases are the ones where a lazier implementation would
 * report a good result:
 *
 *   - three replays that all produced NO evidence. They agree — about
 *     nothing. That is INCONCLUSIVE, not REPRODUCIBLE.
 *   - three replays where two agree and one differs. That is
 *     NOT_AGREED: publishing the majority as "the" result would be
 *     reporting the measurement that was easiest to get.
 *   - three replays that agree but came from ONE worker. They agree, so
 *     the verdict is AGREED — and the INDEPENDENCE block says the rule for
 *     independent reproduction was not met, because one worker can be
 *     wrong the same way three times.
 *   - two replays only. The rule needs three.
 */

import { describe, it, expect } from "vitest";
import {
  decideReproducibility,
  fingerprintEvidence,
  REQUIRED_REPLAYS,
  type ReplayResult,
} from "../src/studio-routes.js";
import type { CheckEvidence } from "@crucible/eval";

function evidence(id: string, passed: boolean, digest = `sha256:${id}`): CheckEvidence {
  return { id, passed, detail: `check ${id}`, artifactDigest: digest };
}

function replay(overrides: Partial<ReplayResult> = {}): ReplayResult {
  return {
    replayNumber: 1,
    label: "worker-a",
    // The worker the observation came from. The PLATFORM derives it; the
    // caller's label above is a name and is never counted.
    workerIdentity: "0xworker",
    status: "PASS",
    checksAnswered: 2,
    fingerprint: "fp_aaaaaaaa",
    comparable: true,
    reason: null,
    ...overrides,
  };
}

describe("fingerprintEvidence", () => {
  it("is null when there is no evidence", () => {
    expect(fingerprintEvidence([])).toBeNull();
  });

  it("is the same for the same checks in a different order", () => {
    const a = fingerprintEvidence([evidence("one", true), evidence("two", true)]);
    const b = fingerprintEvidence([evidence("two", true), evidence("one", true)]);
    expect(a).toBe(b);
  });

  it("differs when a check differs", () => {
    const a = fingerprintEvidence([evidence("one", true)]);
    const b = fingerprintEvidence([evidence("one", false)]);
    expect(a).not.toBe(b);
  });

  it("differs when the artefact behind a check differs", () => {
    const a = fingerprintEvidence([evidence("one", true, "sha256:aaa")]);
    const b = fingerprintEvidence([evidence("one", true, "sha256:bbb")]);
    expect(a).not.toBe(b);
  });
});

describe("decideReproducibility", () => {
  it("says REPRODUCIBLE when three replays produce the same evidence", () => {
    const decision = decideReproducibility([
      replay({ replayNumber: 1, fingerprint: "fp_same" }),
      replay({ replayNumber: 2, fingerprint: "fp_same" }),
      replay({ replayNumber: 3, fingerprint: "fp_same" }),
    ]);

    expect(decision.verdict).toBe("AGREED");
    expect(decision.comparable).toBe(3);
    expect(decision.distinctFingerprints).toBe(1);
  });

  it("says INCONCLUSIVE when the replays produced no evidence to compare", () => {
    const decision = decideReproducibility([
      replay({ fingerprint: null, comparable: false, reason: "no evidence" }),
      replay({ fingerprint: null, comparable: false, reason: "no evidence" }),
      replay({ fingerprint: null, comparable: false, reason: "no evidence" }),
    ]);

    expect(decision.verdict).toBe("INCONCLUSIVE");
    expect(decision.explanation).toContain("no evidence");
    expect(decision.comparable).toBe(0);
  });

  it("says NOT_AGREED when the replays disagree", () => {
    const decision = decideReproducibility([
      replay({ replayNumber: 1, fingerprint: "fp_a" }),
      replay({ replayNumber: 2, fingerprint: "fp_a" }),
      replay({ replayNumber: 3, fingerprint: "fp_b" }),
    ]);

    expect(decision.verdict).toBe("NOT_AGREED");
    expect(decision.distinctFingerprints).toBe(2);
    expect(decision.explanation).toContain("does not follow");
  });

  it("says INCONCLUSIVE when fewer than three replays ran", () => {
    const decision = decideReproducibility([replay({ fingerprint: "fp_a" })]);

    expect(decision.verdict).toBe("INCONCLUSIVE");
    expect(decision.explanation).toContain("Only 1 of the 3");
  });

  it("counts a replay with no evidence as incomparable, not as agreement", () => {
    const decision = decideReproducibility([
      replay({ replayNumber: 1, fingerprint: "fp_a" }),
      replay({ replayNumber: 2, fingerprint: "fp_a" }),
      replay({
        replayNumber: 3,
        fingerprint: null,
        comparable: false,
        reason: "this replay reported no evidence",
      }),
    ]);

    expect(decision.verdict).toBe("INCONCLUSIVE");
    expect(decision.comparable).toBe(2);
    expect(decision.explanation).toContain("2 could be compared");
  });

  it("requires exactly three replays", () => {
    expect(REQUIRED_REPLAYS).toBe(3);
  });
});
