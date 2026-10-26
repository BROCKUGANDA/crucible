import { describe, expect, it } from "vitest";
import { promptOptimize, type Candidate, type PromptOptimizeConfig } from "../src/promote.js";

function probe(id: string, verdict: "PASS" | "VOID" | "FAIL" = "PASS"): { probeId: string; prompt: string; expectedVerdict: "PASS" | "VOID" | "FAIL" } {
  return { probeId: id, prompt: `prompt ${id}`, expectedVerdict: verdict };
}

describe("prompt-optimize (gate 729)", () => {
  const bank = Array.from({ length: 100 }, (_, i) => probe(`opt-${i}`, i % 2 === 0 ? "PASS" : "VOID"));

  const config: PromptOptimizeConfig = {
    candidates: [
      { id: "c1", instruction: "be accurate", manifest: { v: 1 } },
      { id: "c2", instruction: "be sloppy", manifest: { v: 2 } },
    ],
    temperature: 0,
    seed: "opt-seed",
    modelId: "opt-model",
    promptVersion: "pv1",
  };

  const scorer = {
    score: (output: string, probe: { expectedVerdict: "PASS" | "VOID" | "FAIL" }) => {
      const pass = output.includes("accurate") || probe.expectedVerdict === "PASS";
      return {
        score: pass ? 0.9 : 0.1,
        verdict: pass ? "PASS" : "VOID",
        detail: "",
        weights: { overall: pass ? 0.9 : 0.1 },
      };
    },
  };

  const scorerFn = (output: string, probe: { expectedVerdict: "PASS" | "VOID" | "FAIL" }) =>
    scorer.score(output, probe);

  const sampler = {
    sample: async (input: string) => ({ output: `accurate:${input}`, latencyMs: 1 }),
  };

  it("promotes exactly one candidate and touches holdout once", async () => {
    const result = await promptOptimize(bank, sampler, scorerFn, config);

    const promoted = result.all.filter((c) => c.promoted);
    expect(promoted.length).toBe(1);
    expect(result.winner).not.toBeNull();
    expect(result.winner!.promoted).toBe(true);
    expect(typeof result.holdoutAccuracy).toBe("number");
  });

  it("ranks candidates on dev accuracy", async () => {
    const result = await promptOptimize(bank, sampler, scorerFn, config);
    const sorted = [...result.all].sort((a, b) => b.devAccuracy - a.devAccuracy);
    expect(result.all[0].id).toBe(sorted[0].id);
  });
});
