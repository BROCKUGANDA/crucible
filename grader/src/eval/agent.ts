/**
 * Parameter agents — reproducibility as a property of the worker, not the
 * harness. A CRUCIBLE agent is a declared bundle: model binding, sampling
 * parameters, system prompt hash, tool allowlist, and a determinism claim.
 *
 * Validation is fail-closed with named error codes so a rejected manifest
 * tells you exactly which line of the submission form is wrong.
 *
 * The determinism ladder: an agent may only declare itself deterministic with
 * a seed AND either zero temperature or an explicit provider replay guarantee,
 * because seeded sampling at temperature 0.7 pins the client, not the server.
 */

import { createHash } from "node:crypto";

export interface Sampling {
  temperature: number; // [0, 2]
  topP: number; // (0, 1]
  topK?: number; // >= 1
  maxTokens: number; // >= 1
  seed?: string; // uint64 string
  stop?: string[]; // non-empty entries
}

export interface AgentBundle {
  agentId: string;
  modelId: string;
  modelIdentityHash?: string;
  tokenizerId: string;
  systemPrompt: string;
  toolsAllowlist: string[];
  sampling: Sampling;
  deterministic: boolean;
  replayGuarantee?: boolean;
}

export class AgentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "AgentError";
  }
}

export const AGENT_ERRORS = {
  AGENT_ID_FORMAT: "AGENT_ID_FORMAT",
  TEMP_RANGE: "TEMP_RANGE",
  TOPP_RANGE: "TOPP_RANGE",
  TOPK_RANGE: "TOPK_RANGE",
  MAXTOKENS_RANGE: "MAXTOKENS_RANGE",
  SEED_MALFORMED: "SEED_MALFORMED",
  STOP_EMPTY: "STOP_EMPTY",
  TOOLS_DUP: "TOOLS_DUP",
  TOOL_NAME_FORMAT: "TOOL_NAME_FORMAT",
  NONDET_SAMPLING: "NONDET_SAMPLING",
} as const;

const UINT64_MAX = 18446744073709551615n;

/** Validate an agent bundle. Fail-closed with named codes. */
export function validateAgent(bundle: AgentBundle): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(bundle.agentId)) {
    throw new AgentError(AGENT_ERRORS.AGENT_ID_FORMAT, bundle.agentId);
  }

  const { temperature, topP, topK, maxTokens, seed, stop } = bundle.sampling;

  if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new AgentError(AGENT_ERRORS.TEMP_RANGE, String(temperature));
  }
  if (typeof topP !== "number" || !Number.isFinite(topP) || topP <= 0 || topP > 1) {
    throw new AgentError(AGENT_ERRORS.TOPP_RANGE, String(topP));
  }
  if (topK !== undefined && (!Number.isInteger(topK) || topK < 1)) {
    throw new AgentError(AGENT_ERRORS.TOPK_RANGE, String(topK));
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new AgentError(AGENT_ERRORS.MAXTOKENS_RANGE, String(maxTokens));
  }

  if (seed !== undefined) {
    if (!/^\d+$/.test(seed)) {
      throw new AgentError(AGENT_ERRORS.SEED_MALFORMED, seed);
    }
    const n = BigInt(seed);
    if (n < 0n || n > UINT64_MAX) {
      throw new AgentError(AGENT_ERRORS.SEED_MALFORMED, seed);
    }
  }

  if (stop !== undefined) {
    for (const s of stop) {
      if (typeof s !== "string" || s.length === 0) {
        throw new AgentError(AGENT_ERRORS.STOP_EMPTY, "empty stop sequence");
      }
    }
  }

  const tools = bundle.toolsAllowlist;
  if (new Set(tools).size !== tools.length) {
    throw new AgentError(AGENT_ERRORS.TOOLS_DUP, "duplicate tools in allowlist");
  }
  for (const t of tools) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(t)) {
      throw new AgentError(AGENT_ERRORS.TOOL_NAME_FORMAT, t);
    }
  }

  // Determinism ladder (gate from the spec).
  if (bundle.deterministic) {
    if (seed === undefined) {
      throw new AgentError(AGENT_ERRORS.NONDET_SAMPLING, "deterministic agent requires a seed");
    }
    if (temperature !== 0 && !bundle.replayGuarantee) {
      throw new AgentError(
        AGENT_ERRORS.NONDET_SAMPLING,
        "seeded sampling at temperature > 0 requires an explicit provider replay guarantee",
      );
    }
  }
}

/** Hash of the system prompt, NFC-normalized for byte stability. */
export function systemPromptHash(prompt: string): string {
  return createHash("sha256").update(prompt.normalize("NFC")).digest("hex");
}

/**
 * paramsHash = canonical-JSON hash of {sampling, systemPromptHash,
 * toolsAllowlist sorted}. JCS-style: JSON key order cannot change the hash,
 * and tool-list order — which is not behavior — does not either.
 */
export function paramsHash(bundle: AgentBundle): string {
  const payload = {
    sampling: bundle.sampling,
    systemPromptHash: systemPromptHash(bundle.systemPrompt),
    toolsAllowlist: [...bundle.toolsAllowlist].sort(),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Determinism claim is only valid with a seed and (temp 0 or replay guarantee). */
export function isValidDeterminismClaim(bundle: AgentBundle): boolean {
  if (!bundle.deterministic) return false;
  if (bundle.sampling.seed === undefined) return false;
  if (bundle.sampling.temperature !== 0 && !bundle.replayGuarantee) return false;
  return true;
}
