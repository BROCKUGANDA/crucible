import { describe, expect, it } from "vitest";
import type { Principal } from "@crucible/agent-security";
import { createForgedAgent, MODEL_ACTION, MODEL_PERMISSION, SYSTEM_PROMPT } from "../src/agent";
import { createModelGuard, MODEL_TOOL } from "../src/tool-guard";
import type { WorkContext } from "@crucible/smith";

/**
 * The policy engine was already written and already tested; what had never happened was a
 * runtime path asking it anything. These tests are about the wire, so each one asserts a
 * refusal that a *missing* wire would have allowed through — an observer-role principal
 * completing a model call, a run looping past its ceiling, an unregistered tool name being
 * waved through because the allow-list was never consulted.
 */

const DIFF = [
  "diff --git a/src/Forge.sol b/src/Forge.sol",
  "--- a/src/Forge.sol",
  "+++ b/src/Forge.sol",
  "@@ -1,3 +1,4 @@",
  " contract Forge {",
  "+    function bump() public {}",
  " }",
  "",
].join("\n");

function principal(role: Principal["role"]): Principal {
  return { id: `runner:${role}`, kind: "agent", role, createdAt: 0 };
}

function context(spec: string): WorkContext {
  return {
    brief: {
      trialId: 7,
      agentId: 3,
      specCID: "cid",
      testsCID: "cid",
      timeBudgetSec: 60,
      iterBudget: 4,
      gasPolicy: { maxIterations: 4, maxWallClockSec: 60, maxBondWei: 1n },
    },
    iteration: 1,
    spec,
    files: { "src/Forge.sol": "contract Forge {}" },
  };
}

describe("createModelGuard", () => {
  it("derives the scopes from the role matrix instead of trusting the caller", () => {
    const operator = createModelGuard({
      client: { complete: async () => DIFF },
      principal: principal("operator"),
      sessionId: "s1",
    });
    const observer = createModelGuard({
      client: { complete: async () => DIFF },
      principal: principal("observer"),
      sessionId: "s2",
    });
    expect(operator.scopes).toContain(MODEL_PERMISSION);
    // An observer may hold `reputation:read` and nothing else, so the scope the model call
    // requires is not in the set — and the refusal comes from the matrix, not from this file.
    expect(observer.scopes).not.toContain(MODEL_PERMISSION);
  });

  it("completes through the toolbox for a principal that may run a trial", async () => {
    let calls = 0;
    const { guard, trace } = createModelGuard({
      client: {
        complete: async (args) => {
          calls += 1;
          // The prompt has to survive the trip through the guard, or the model is being
          // asked something other than what the agent built.
          expect(args.system).toBe(SYSTEM_PROMPT);
          expect(args.prompt).toContain("Add bump().");
          return DIFF;
        },
      },
      temperature: 0.2,
      principal: principal("operator"),
      sessionId: "run",
      maxCallsPerSession: 4,
    });

    const agent = createForgedAgent({
      client: { complete: async () => "" },
      model: "m",
      guard,
    });
    const result = await agent.step(context("Add bump()."));

    expect(result.patch).not.toBe("");
    expect(calls).toBe(1);
    expect(trace()).toEqual([{ at: expect.any(Number), tool: MODEL_TOOL, ok: true, ms: expect.any(Number) }]);
  });

  it("refuses a principal whose role may not run a trial, and never reaches the model", async () => {
    let calls = 0;
    const { guard, trace } = createModelGuard({
      client: {
        complete: async () => {
          calls += 1;
          return DIFF;
        },
      },
      principal: principal("observer"),
      sessionId: "run",
    });

    const agent = createForgedAgent({ client: { complete: async () => DIFF }, model: "m", guard });
    const result = await agent.step(context("Add bump()."));

    expect(calls, "the model was reached for a principal that may not run a trial").toBe(0);
    expect(result.patch).toBe("");
    expect(result.done).toBe(false);
    expect(result.notes).toMatch(/Guard refused/);
    expect(result.notes).toMatch(/scope/);
    expect(trace()[0]?.ok).toBe(false);
  });

  it("refuses the call after the session ceiling, which is the budget the loop cannot exceed", async () => {
    let calls = 0;
    const { guard, trace } = createModelGuard({
      client: {
        complete: async () => {
          calls += 1;
          return DIFF;
        },
      },
      principal: principal("operator"),
      sessionId: "run",
      maxCallsPerSession: 2,
    });

    const first = await guard.call({
      action: MODEL_ACTION,
      input: { system: SYSTEM_PROMPT, prompt: "a" },
      permission: MODEL_PERMISSION,
    });
    const second = await guard.call({
      action: MODEL_ACTION,
      input: { system: SYSTEM_PROMPT, prompt: "b" },
      permission: MODEL_PERMISSION,
    });
    const third = await guard.call({
      action: MODEL_ACTION,
      input: { system: SYSTEM_PROMPT, prompt: "c" },
      permission: MODEL_PERMISSION,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (third.ok) throw new Error("the third call was allowed past a ceiling of two");
    expect(third.reason).toMatch(/session ceiling of 2/);
    expect(calls, "the client ran for a call the ceiling had already refused").toBe(2);
    expect(trace().filter((e) => !e.ok)).toHaveLength(1);
  });

  it("refuses a tool name that was never registered — the allow-list is deny-by-default", async () => {
    const { guard } = createModelGuard({
      client: { complete: async () => DIFF },
      principal: principal("operator"),
      sessionId: "run",
    });

    const result = await guard.call({
      action: "write_file",
      input: { target: "/work/src/Forge.sol" },
      permission: MODEL_PERMISSION,
    });

    if (result.ok) throw new Error("an unregistered tool was allowed through the allow-list");
    expect(result.reason).toMatch(/not registered/);
  });

  it("records what an agent attempted without recording what it said", async () => {
    const secret = "the spec's own private text";
    const { guard, trace } = createModelGuard({
      client: { complete: async () => DIFF },
      principal: principal("observer"),
      sessionId: "run",
    });

    await guard.call({
      action: MODEL_ACTION,
      input: { system: SYSTEM_PROMPT, prompt: secret },
      permission: MODEL_PERMISSION,
    });

    const recorded = trace();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.ok).toBe(false);
    expect(JSON.stringify(recorded)).not.toContain(secret);
  });
});
