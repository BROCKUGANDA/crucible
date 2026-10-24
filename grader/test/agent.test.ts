import { describe, expect, it } from "vitest";
import {
  validateAgent,
  paramsHash,
  systemPromptHash,
  isValidDeterminismClaim,
  AGENT_ERRORS,
  type AgentBundle,
} from "../src/eval/agent.js";

const VALID_AGENT: AgentBundle = {
  agentId: "worker-1",
  modelId: "verifier-7b",
  modelIdentityHash: "identity-hash-123",
  tokenizerId: "tok-v1",
  systemPrompt: "You are a judge.",
  toolsAllowlist: ["probe.fetch", "claim.hash"],
  sampling: { temperature: 0, topP: 1, maxTokens: 512, seed: "42" },
  deterministic: true,
};

describe("Parameter agents (P0)", () => {
  it("validates a well-formed agent bundle", () => {
    expect(() => validateAgent(VALID_AGENT)).not.toThrow();
  });

  it("rejects bad agent id format", () => {
    const bad = { ...VALID_AGENT, agentId: "Worker 1!" };
    expect(() => validateAgent(bad)).toThrow(AGENT_ERRORS.AGENT_ID_FORMAT);
  });

  it("rejects temperature out of range", () => {
    expect(() => validateAgent({ ...VALID_AGENT, sampling: { ...VALID_AGENT.sampling, temperature: 2.5 } })).toThrow(
      AGENT_ERRORS.TEMP_RANGE,
    );
    expect(() => validateAgent({ ...VALID_AGENT, sampling: { ...VALID_AGENT.sampling, temperature: -0.1 } })).toThrow(
      AGENT_ERRORS.TEMP_RANGE,
    );
  });

  it("rejects topP out of range", () => {
    expect(() => validateAgent({ ...VALID_AGENT, sampling: { ...VALID_AGENT.sampling, topP: 0 } })).toThrow(
      AGENT_ERRORS.TOPP_RANGE,
    );
    expect(() => validateAgent({ ...VALID_AGENT, sampling: { ...VALID_AGENT.sampling, topP: 1.1 } })).toThrow(
      AGENT_ERRORS.TOPP_RANGE,
    );
  });

  it("rejects topK < 1", () => {
    expect(() => validateAgent({ ...VALID_AGENT, sampling: { ...VALID_AGENT.sampling, topK: 0 } })).toThrow(
      AGENT_ERRORS.TOPK_RANGE,
    );
  });

  it("rejects maxTokens < 1", () => {
    expect(() => validateAgent({ ...VALID_AGENT, sampling: { ...VALID_AGENT.sampling, maxTokens: 0 } })).toThrow(
      AGENT_ERRORS.MAXTOKENS_RANGE,
    );
  });

  it("rejects malformed seed", () => {
    expect(() => validateAgent({ ...VALID_AGENT, sampling: { ...VALID_AGENT.sampling, seed: "-1" } })).toThrow(
      AGENT_ERRORS.SEED_MALFORMED,
    );
    expect(() => validateAgent({ ...VALID_AGENT, sampling: { ...VALID_AGENT.sampling, seed: "abc" } })).toThrow(
      AGENT_ERRORS.SEED_MALFORMED,
    );
  });

  it("rejects empty stop sequences", () => {
    expect(() => validateAgent({ ...VALID_AGENT, sampling: { ...VALID_AGENT.sampling, stop: [""] } })).toThrow(
      AGENT_ERRORS.STOP_EMPTY,
    );
  });

  it("rejects duplicate tools", () => {
    const bad = { ...VALID_AGENT, toolsAllowlist: ["probe.fetch", "probe.fetch"] };
    expect(() => validateAgent(bad)).toThrow(AGENT_ERRORS.TOOLS_DUP);
  });

  it("rejects bad tool name format", () => {
    const bad = { ...VALID_AGENT, toolsAllowlist: ["probe fetch!"] };
    expect(() => validateAgent(bad)).toThrow(AGENT_ERRORS.TOOL_NAME_FORMAT);
  });

  it("determinism ladder: temp 0.7 + seed + no replayGuarantee rejected", () => {
    const bad = {
      ...VALID_AGENT,
      sampling: { ...VALID_AGENT.sampling, temperature: 0.7 },
      deterministic: true,
    };
    expect(() => validateAgent(bad)).toThrow(AGENT_ERRORS.NONDET_SAMPLING);
  });

  it("determinism ladder: temp 0 + seed OK", () => {
    const ok = { ...VALID_AGENT, sampling: { ...VALID_AGENT.sampling, temperature: 0 }, deterministic: true };
    expect(() => validateAgent(ok)).not.toThrow();
  });

  it("determinism ladder: temp 0.7 + replayGuarantee OK", () => {
    const ok = {
      ...VALID_AGENT,
      sampling: { ...VALID_AGENT.sampling, temperature: 0.7 },
      deterministic: true,
      replayGuarantee: true,
    };
    expect(() => validateAgent(ok)).not.toThrow();
  });

  it("isValidDeterminismClaim mirrors the ladder", () => {
    expect(isValidDeterminismClaim(VALID_AGENT)).toBe(true);
    const nondet = { ...VALID_AGENT, deterministic: false };
    expect(isValidDeterminismClaim(nondet)).toBe(false);
    const noReplay = { ...VALID_AGENT, sampling: { ...VALID_AGENT.sampling, temperature: 0.7 } };
    expect(isValidDeterminismClaim(noReplay)).toBe(false);
  });

  it("paramsHash: same content, same hash regardless of JSON key order", () => {
    const a = { ...VALID_AGENT };
    const b = { ...VALID_AGENT, sampling: { ...VALID_AGENT.sampling, maxTokens: 512, temperature: 0 } };
    // reordering sampling keys shouldn't change hash since we serialize deterministically
    expect(paramsHash(a)).toBe(paramsHash(b));
  });

  it("paramsHash: different sampling → different hash", () => {
    const a = VALID_AGENT;
    const b = { ...VALID_AGENT, sampling: { ...VALID_AGENT.sampling, maxTokens: 513 } };
    expect(paramsHash(a)).not.toBe(paramsHash(b));
  });

  it("systemPromptHash: NFC stable", () => {
    const composed = "café";
    const decomposed = "cafe\u0301";
    expect(systemPromptHash(composed)).toBe(systemPromptHash(decomposed));
  });
});
