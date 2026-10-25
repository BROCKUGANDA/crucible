import { describe, expect, it } from "vitest";
import { StubModelAdapter } from "../src/eval/adapters/stub.js";
import type { Artifact } from "../src/eval/types.js";

const PASS = "PASS" as const;
const VOID = "VOID" as const;
const FAIL = "FAIL" as const;

function artifact(claimHash: string, payload: unknown): Artifact {
  return {
    claimHash,
    payload,
    expectedVerdict: PASS,
    suite: "smoke",
    thresholdBand: "normal",
    // The tier `smokeSet` gives this payload shape: see `tiers.test.ts`.
    tier: "competence",
    difficulty: "routine",
  };
}

describe("StubModelAdapter", () => {
  it("returns deterministic verdicts for the same claim + promptVersion", async () => {
    const a = new StubModelAdapter("v1");
    const art = artifact("claim-1", { index: 1 });
    const v1 = await a.grade(art, "v1");
    const v2 = await a.grade(art, "v1");
    expect(v1).toEqual(v2);
    expect(["PASS", "VOID", "FAIL"].includes(v1.verdict)).toBe(true);
    expect(v1.confidence).toBeGreaterThanOrEqual(0);
    expect(v1.confidence).toBeLessThanOrEqual(1);
    expect(typeof v1.latencyMs).toBe("number");
    expect(v1.promptVersion).toBe("v1");
  });

  it("changes verdict when promptVersion changes", async () => {
    const a = new StubModelAdapter("v1");
    const art = artifact("claim-1", { index: 1 });
    const v1 = await a.grade(art, "v1");
    const v2 = await a.grade(art, "v2");
    expect(v1.promptVersion).toBe("v1");
    expect(v2.promptVersion).toBe("v2");
  });

  it("differs across claims", async () => {
    const a = new StubModelAdapter("v1");
    const verdicts = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => a.grade(artifact(`claim-${i}`, { index: i }), "v1")),
    );
    const unique = new Set(verdicts.map((v) => v.verdict));
    expect(unique.size).toBeGreaterThan(1);
  });

  it("is fast and has no network dependency", async () => {
    const a = new StubModelAdapter("v1");
    const start = Date.now();
    await a.grade(artifact("claim-x", { index: 0 }), "v1");
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("id is exactly 'stub'", () => {
    expect(new StubModelAdapter("v1").id).toBe("stub");
  });
});
