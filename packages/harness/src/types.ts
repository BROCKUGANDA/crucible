/**
 * Gate 489 — Proposal envelope.
 *
 * Every agent (worker sim, Warden, Arena contestant, shadow tier) emits a
 * value object: {type, payload, attestation, budget}. Agents hold zero
 * effectors: no chain signer, no fs, no arbitrary network. Effects happen
 * only when the keeper/CI accepts a proposal through the executor.
 */

export type ProposalType =
  | "probe.fetch"
  | "claim.hash"
  | "score.submit"
  | "verdict.draft";

export interface ProposalAttestation {
  modelId: string;
  promptVersion: string;
  snapshot: string;
  sealedAt: number; // unix ms
  nonce: string;
}

export interface ProposalBudget {
  maxTokens: number;
  maxCostUsd: number;
  maxLatencyMs: number;
}

export interface Proposal<T = unknown> {
  type: ProposalType;
  payload: T;
  attestation: ProposalAttestation;
  budget: ProposalBudget;
}

/** Result of executing a proposal through the sealed harness. */
export interface ProposalResult<T = unknown> {
  ok: boolean;
  value?: T;
  error?: string;
  spans: Span[];
  latencyMs: number;
}

export interface Span {
  name: string;
  start: number;
  end: number;
  attributes: Record<string, unknown>;
}

/** Fixed toolset — agents call only declared tools (gate 492). */
export interface DeclaredTool<TInput, TOutput> {
  name: ProposalType;
  schema: JSONSchema;
  execute: (input: TInput) => Promise<TOutput>;
}

export interface JSONSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** Size cap on agent responses (gate 494). */
export const MAX_AGENT_RESPONSE_BYTES = 64 * 1024; // 64 KiB

/** Token cap per agent call (gate 495). */
export const DEFAULT_MAX_TOKENS = 2048;

/** Wall-clock p95 cap (gate 495 / 513). */
export const DEFAULT_MAX_LATENCY_MS = 20_000;
