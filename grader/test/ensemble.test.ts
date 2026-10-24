import { describe, expect, it } from "vitest";
import { EnsembleRouter } from "../src/eval/ensemble.js";
import { StubModelAdapter } from "../src/eval/adapters/stub.js";
import type { Artifact } from "../src/eval/types.js";

function artifact(claimHash: string): Artifact {
  return {
    claimHash,
    payload: { kind: "run-artifact", index: 1 },
    expectedVerdict: "PASS",
    suite: "smoke",
    thresholdBand: "normal",
  };
}

describe("EnsembleRouter (gate 429)", () => {
  const a = new StubModelAdapter("model-a-v1", "model-a-v1");
  const b = new StubModelAdapter("model-b-v1", "model-b-v1");

  it("uses single-model fast path when ensemble is disabled", async () => {
    const router = new EnsembleRouter({ modelA: a, modelB: b, enabled: false, valueThresholdWei: 0n });
    const v = await router.grade(artifact("claim-0"), "v1", 0n);
    expect(v.decidedBy).toBe("model-a-v1");
    expect(v.escalated).toBe(false);
    expect(v.agreed).toBe(true);
    expect(v.modelAVerdict).toBe(v.modelBVerdict);
  });

  it("uses single-model fast path below the value threshold", async () => {
    const router = new EnsembleRouter({ modelA: a, modelB: b, enabled: true, valueThresholdWei: 100n });
    const v = await router.grade(artifact("claim-0"), "v1", 1n);
    expect(v.decidedBy).toBe("model-a-v1");
    expect(v.escalated).toBe(false);
  });

  it("runs both models above the threshold and agrees when verdicts match", async () => {
    const router = new EnsembleRouter({ modelA: a, modelB: b, enabled: true, valueThresholdWei: 0n });
    const v = await router.grade(artifact("claim-0"), "v1", 100n);
    expect(v.decidedBy).toBe("ensemble");
    expect(v.modelAVerdict).toBeDefined();
    expect(v.modelBVerdict).toBeDefined();
    // both use same stub algorithm → agree on same claim+prompt
    expect(v.agreed).toBe(true);
    expect(v.escalated).toBe(false);
  });
});
