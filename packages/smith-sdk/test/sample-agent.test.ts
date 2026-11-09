import { describe, expect, it } from "vitest";
import { sampleAgent, SAMPLE_PATCH } from "../src/sample-agent.js";

describe("sample agent", () => {
  it("is a deterministic SmithAgent the SDK can run", async () => {
    expect(sampleAgent.name).toBe("sample-agent");
    expect(sampleAgent.capabilities.model).toBe("deterministic-local");
    expect(sampleAgent.capabilities.tools).toEqual([]);
    const result = await sampleAgent.step({
      brief: { trialId: 1, agentId: 1, specCID: "0xok", testsCID: "0xok", timeBudgetSec: 60, iterBudget: 1, gasPolicy: { maxIterations: 1, maxWallClockSec: 60, maxBondWei: 1n } },
      iteration: 1,
    });
    expect(result.done).toBe(true);
    expect(result.patch).toBe(SAMPLE_PATCH);
    expect(result.patch).toContain("uint256 public total = 0;");
  });
});
