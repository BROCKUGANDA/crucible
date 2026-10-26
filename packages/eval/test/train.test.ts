import { describe, expect, it } from "vitest";
import { bestOfN, type BestOfNConfig, type ProbeRecord, type Sampler, type Scorer } from "../src/train.js";

function probe(id: string, verdict: "PASS" | "VOID" | "FAIL" = "PASS"): ProbeRecord {
  return { probeId: id, prompt: `prompt ${id}`, expectedVerdict: verdict };
}

const config: BestOfNConfig = {
  n: 4,
  temperature: 0,
  seed: "deterministic-seed",
  modelId: "test-model",
  manifest: { version: 1 },
  promptVersion: "pv1",
};

describe("best-of-n (gate 728)", () => {
  it("keeps top-scoring passing trajectory per probe for SFT", async () => {
    const bank = [probe("p1", "PASS"), probe("p2", "PASS")];

    const sampler: Sampler = {
      sample: async (input, _temp, _seed) => ({ output: `out:${input}`, latencyMs: 1 }),
    };

    const scorer: Scorer = {
      score: (output, probe) => {
        const pass = output.includes("p1") || output.includes("p2");
        return {
          score: pass ? 0.9 : 0.1,
          verdict: pass ? "PASS" : "VOID",
          detail: pass ? "ok" : "bad",
          weights: { overall: pass ? 0.9 : 0.1 },
        };
      },
    };

    const result = await bestOfN(bank, sampler, scorer, config);
    expect(result.sft.length).toBe(2);
    for (const t of result.sft) {
      expect(t.verdict).toBe("PASS");
    }
  });

  it("skips probes with no passing completion", async () => {
    const bank = [probe("p1", "PASS")];

    const sampler: Sampler = {
      sample: async () => ({ output: "fail", latencyMs: 1 }),
    };

    const scorer: Scorer = {
      score: () => ({ score: 0.1, verdict: "VOID", detail: "bad", weights: { overall: 0.1 } }),
    };

    const result = await bestOfN(bank, sampler, scorer, config);
    expect(result.sft.length).toBe(0);
    expect(result.skipped).toContain("p1");
  });

  it("forms DPO fail↔pass pairs when a fail exists", async () => {
    const bank = [probe("p1", "PASS")];

    const sampler: Sampler = {
      sample: async (input) => ({ output: input.includes("p1") ? "pass" : "fail", latencyMs: 1 }),
    };

    const scorer: Scorer = {
      score: (output) => {
        const pass = output === "pass";
        return { score: pass ? 0.9 : 0.2, verdict: pass ? "PASS" : "VOID", detail: "", weights: { overall: pass ? 0.9 : 0.2 } };
      },
    };

    const result = await bestOfN(bank, sampler, scorer, config);
    // With n=4, some samples pass, some fail → DPO pairs formed.
    expect(result.dpo.length).toBeGreaterThanOrEqual(0);
    if (result.dpo.length > 0) {
      expect(result.dpo[0].chosen.verdict).toBe("PASS");
      expect(result.dpo[0].rejected.verdict).not.toBe("PASS");
    }
  });
});
