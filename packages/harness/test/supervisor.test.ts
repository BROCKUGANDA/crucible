import { describe, expect, it } from "vitest";
import { SandboxSupervisor, AgentBreaker, DEFAULT_CAPS } from "../src/supervisor.js";
import type { Proposal } from "../src/types.js";

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    type: "verdict.draft",
    payload: { claimHash: "claim-1", verdict: "PASS" },
    attestation: {
      modelId: "stub",
      promptVersion: "pv7",
      snapshot: "stub-1",
      sealedAt: Date.now(),
      nonce: "nonce-abc",
    },
    budget: {
      maxTokens: 512,
      maxCostUsd: 0.01,
      maxLatencyMs: 1000,
    },
    ...overrides,
  };
}

describe("SandboxSupervisor (gate 490)", () => {
  it("executes a declared proposal and returns spans", async () => {
    const supervisor = new SandboxSupervisor(DEFAULT_CAPS);
    const result = await supervisor.run(proposal());

    expect(result.ok).toBe(true);
    expect(result.proposalId).toBe("nonce-abc");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.spans)).toBe(true);
    expect(result.spans.length).toBeGreaterThan(0);
    expect(result.spans[0].name).toBe("proposal.execute");
  });

  it("rejects undeclared tools (gate 492)", async () => {
    const supervisor = new SandboxSupervisor(DEFAULT_CAPS);
    const result = await supervisor.run(proposal({ type: "system.shell" as any }));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("undeclared tool");
  });

  it("enforces payload size cap (gate 494)", async () => {
    const supervisor = new SandboxSupervisor(DEFAULT_CAPS);
    const bigPayload = { data: "x".repeat(70 * 1024) }; // > 64 KiB
    const result = await supervisor.run(proposal({ payload: bigPayload }));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("exceeds max");
  });

  it("rejects budget exceeding wall-clock cap (gate 495)", async () => {
    const supervisor = new SandboxSupervisor(DEFAULT_CAPS);
    const result = await supervisor.run(
      proposal({ budget: { ...proposal().budget, maxLatencyMs: 999999 } }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("exceeds sandbox cap");
  });
});

describe("AgentBreaker (gate 499)", () => {
  it("trips and fail-closes", () => {
    const breaker = new AgentBreaker();
    expect(breaker.isTripped()).toBe(false);

    breaker.trip("test reason");
    expect(breaker.isTripped()).toBe(true);
    expect(() => breaker.assertNotTripped()).toThrow(/fail-closed/);

    breaker.reset();
    expect(breaker.isTripped()).toBe(false);
  });
});
