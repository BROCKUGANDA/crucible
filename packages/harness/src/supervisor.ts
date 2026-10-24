/**
 * Gate 490 — Sandbox harness supervisor.
 *
 * Containerized execution context: read-only rootfs, scratch tmpfs wiped per
 * run, no capabilities, seccomp default-deny, CPU/mem/wall-clock caps.
 * Spawned per-run; agents propose, the supervisor executes within bounds.
 */

import type { Proposal, ProposalResult, Span } from "./types.js";
import { DEFAULT_MAX_LATENCY_MS, MAX_AGENT_RESPONSE_BYTES } from "./types.js";

/** Sandbox resource caps. */
export interface SandboxCaps {
  maxMemoryMb: number;
  maxCpuMs: number;
  maxWallClockMs: number;
  readOnlyRootfs: boolean;
  noCapabilities: boolean;
  seccompDefaultDeny: boolean;
  egressAllowlist: string[]; // host patterns allowed
}

export const DEFAULT_CAPS: SandboxCaps = {
  maxMemoryMb: 256,
  maxCpuMs: 5000,
  maxWallClockMs: DEFAULT_MAX_LATENCY_MS,
  readOnlyRootfs: true,
  noCapabilities: true,
  seccompDefaultDeny: true,
  egressAllowlist: [], // populated by adapter proxy + probe-bank reads
};

/** Result of a sandboxed run. */
export interface SandboxRunResult {
  ok: boolean;
  proposalId: string;
  spans: Span[];
  latencyMs: number;
  memoryPeakMb?: number;
  error?: string;
}

/**
 * Supervisor spawns a sandboxed run for a proposal. In v1 this is a
 * process-boundary simulation; in production it backs a real container.
 */
export class SandboxSupervisor {
  constructor(private readonly caps: SandboxCaps = DEFAULT_CAPS) {}

  /** Run a proposal inside the sandbox. Returns spans + result. */
  async run(proposal: Proposal): Promise<SandboxRunResult> {
    const start = Date.now();
    const spans: Span[] = [];

    const span = (name: string, fn: () => Promise<unknown>, attrs: Record<string, unknown> = {}) => {
      const s = Date.now();
      return Promise.resolve().then(fn).then(
        (v) => { spans.push({ name, start: s, end: Date.now(), attributes: attrs }); return v; },
        (e) => { spans.push({ name, start: s, end: Date.now(), attributes: { ...attrs, error: String(e) } }); throw e; },
      );
    };

    try {
      // Enforce budget before executing (gate 495).
      if (proposal.budget.maxLatencyMs > this.caps.maxWallClockMs) {
        throw new Error(`proposal latency cap ${proposal.budget.maxLatencyMs}ms exceeds sandbox cap ${this.caps.maxWallClockMs}ms`);
      }

      const result = await span("proposal.execute", () => this.executeProposal(proposal), {
        type: proposal.type,
        modelId: proposal.attestation.modelId,
      });

      return {
        ok: true,
        proposalId: proposal.attestation.nonce,
        spans,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        ok: false,
        proposalId: proposal.attestation.nonce,
        spans,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Execute the proposal within declared toolset (gate 492). */
  private async executeProposal(proposal: Proposal): Promise<unknown> {
    // Size cap check (gate 494).
    const payloadBytes = new TextEncoder().encode(JSON.stringify(proposal.payload)).length;
    if (payloadBytes > MAX_AGENT_RESPONSE_BYTES) {
      throw new Error(`payload ${payloadBytes} bytes exceeds max ${MAX_AGENT_RESPONSE_BYTES}`);
    }

    switch (proposal.type) {
      case "probe.fetch":
      case "claim.hash":
      case "score.submit":
      case "verdict.draft":
        // Declared tools — validated, logged as spans. Real implementations
        // are wired by the keeper/CI executor, not by the agent.
        return { type: proposal.type, accepted: true, bytes: payloadBytes };
      default:
        throw new Error(`undeclared tool: ${proposal.type}`);
    }
  }
}

/** One breaker for all agents (gate 499): kill-switch flag, fail-closed. */
export class AgentBreaker {
  private tripped = false;

  trip(reason: string): void {
    this.tripped = true;
    // In production this also snapshots the spine tail and flips to stub tier.
  }

  isTripped(): boolean {
    return this.tripped;
  }

  assertNotTripped(): void {
    if (this.tripped) {
      throw new Error("agent breaker tripped — execution fail-closed");
    }
  }

  reset(): void {
    this.tripped = false;
  }
}
