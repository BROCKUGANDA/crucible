import type { RunArtifact } from "./types.js";

/**
 * Smith — the composability story. An agent built with Smith is
 * ERC-8004-native on day one: define capabilities, get a manifest, and the
 * same hooks the ForgeRunner uses.
 */

export interface AgentCapabilities {
  /** short, human-readable domains this agent can work in */
  domains: string[];
  /** the model backing it, e.g. "claude-sonnet-4-5" */
  model: string;
  /** tools the agent may call */
  tools: string[];
  /** optional: what the agent will refuse to attempt */
  limits?: Record<string, unknown>;
}

export interface TrialBrief {
  trialId: number;
  agentId: number;
  specCID: string;
  testsCID: string;
  timeBudgetSec: number;
  iterBudget: number;
  /** max bond, in wei, the operator is willing to risk */
  gasPolicy: {
    maxIterations: number;
    maxWallClockSec: number;
    maxBondWei: bigint;
  };
}

export interface WorkContext {
  brief: TrialBrief;
  iteration: number;
  /** the previous iteration's suite output, if any */
  lastOutput?: string;
  /**
   * The trial spec text. Carried here rather than re-fetched so an agent gets the
   * same bytes the runner validated — and so a runner can wrap it once.
   */
  spec?: string;
}

export interface WorkResult {
  /** the agent's changes, as a unified diff or a patch file body */
  patch: string;
  notes: string;
  /** true when the agent believes the work is complete */
  done: boolean;
}

export interface AgentHooks {
  onTrialLoaded?(ctx: WorkContext): Promise<void> | void;
  onIteration?(ctx: WorkContext, result: WorkResult): Promise<void> | void;
  onSubmit?(artifact: RunArtifact): Promise<void> | void;
  /** called when the agent refuses a trial (e.g. bond over risk cap) */
  onRefusal?(reason: string, brief: TrialBrief): Promise<void> | void;
}

export interface SmithAgent {
  name: string;
  capabilities: AgentCapabilities;
  /**
   * Do the work for one iteration. Called up to iterBudget times; the ForgeRunner
   * runs the pinned suite between iterations and hands the output back via
   * WorkContext.lastOutput.
   */
  step(ctx: WorkContext): Promise<WorkResult>;
  hooks?: AgentHooks;
}

export interface DefineAgentArgs {
  name: string;
  capabilities: AgentCapabilities;
  step(ctx: WorkContext): Promise<WorkResult>;
  hooks?: AgentHooks;
}

export function defineAgent(args: DefineAgentArgs): SmithAgent {
  if (args.name.trim().length === 0) {
    throw new Error("agent name must be non-empty");
  }
  if (args.capabilities.model.trim().length === 0) {
    throw new Error("capabilities.model must be non-empty");
  }
  return {
    name: args.name,
    capabilities: args.capabilities,
    step: args.step,
    hooks: args.hooks,
  };
}

/**
 * The staking policy from the PRD: refuse trials whose bond exceeds the
 * configured risk cap. An agent that will bond more than its operator allows is
 * a bug, not a judgement call.
 */
export class RiskCapExceeded extends Error {
  constructor(
    readonly bondWei: bigint,
    readonly capWei: bigint,
  ) {
    super(
      `This trial's bond (${bondWei} wei) exceeds your risk cap (${capWei} wei). ` +
        `Raise it in Settings if you're sure.`,
    );
    this.name = "RiskCapExceeded";
  }
}

export function assertWithinRiskCap(
  bondWei: bigint,
  brief: TrialBrief,
  agent: SmithAgent,
): void {
  if (bondWei > brief.gasPolicy.maxBondWei) {
    throw new RiskCapExceeded(bondWei, brief.gasPolicy.maxBondWei);
  }
}

/**
 * ERC-8004-style capabilities manifest. This is what metadataURI points at on
 * registerAgent — the agent's portable, resolvable description.
 */
export interface CapabilitiesManifest {
  name: string;
  capabilities: AgentCapabilities;
  alloy: {
    registry: `0x${string}` | null;
    agentId: number | null;
    tier: string | null;
  };
}

export function buildManifest(
  agent: SmithAgent,
  alloy: { registry: `0x${string}`; agentId: number; tier: string } | null,
): CapabilitiesManifest {
  return {
    name: agent.name,
    capabilities: agent.capabilities,
    alloy: alloy
      ? { registry: alloy.registry, agentId: alloy.agentId, tier: alloy.tier }
      : { registry: null, agentId: null, tier: null },
  };
}

export function manifestDataUri(manifest: CapabilitiesManifest): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
}
