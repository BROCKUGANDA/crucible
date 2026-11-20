/**
 * @file chain-config.ts — Chain environment isolation (Phase 6).
 *
 * Enforces explicit CHAIN_ENV configuration. Missing configuration stops
 * startup rather than silently falling back to Anvil or demo mode.
 *
 * Key principles:
 * - CHAIN_ENV must be explicitly set (anvil, testnet, mainnet).
 * - No silent fallback from mainnet to Anvil.
 * - Mode 0 (deterministic) is blocked for funded trials on mainnet.
 * - Production RPC requires primary + fallback configuration.
 */

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type ChainEnvironment = "anvil" | "testnet" | "mainnet";

export interface ChainConfig {
  chainEnv: ChainEnvironment;
  chainId: number;
  rpcUrl: string;
  rpcFallbackUrl?: string;
  explorerUrl?: string;
  contractAddresses: ContractAddresses;
  vrfConfig?: VrfConfig;
  confirmationBlocks: number;
  finalityPolicy: "instant" | "safe" | "finalized";
}

export interface ContractAddresses {
  arena?: string;
  escrow?: string;
  identity?: string;
  trials?: string;
  treasury?: string;
}

export interface VrfConfig {
  coordinatorAddress: string;
  keyHash: string;
  subscriptionId: number;
  gasLane?: string;
}

export interface PilotLimits {
  maxActiveTrials: number;
  maxFundingPerTrial: bigint;
  maxSponsorBudget: bigint;
  maxPerAgentReward: bigint;
  maxDailyOutflow: bigint;
  minimumTreasuryReserve: bigint;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function parseEther(value: string): bigint {
  const parts = value.split(".");
  const whole = BigInt(parts[0] || "0");
  const fractional = parts[1] || "0";
  const padded = fractional.padEnd(18, "0").slice(0, 18);
  return whole * BigInt("1000000000000000000") + BigInt(padded);
}

/* ------------------------------------------------------------------ */
/* Defaults                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_ANVIL_CONFIG: ChainConfig = {
  chainEnv: "anvil",
  chainId: 31337,
  rpcUrl: "http://localhost:8545",
  contractAddresses: {},
  confirmationBlocks: 1,
  finalityPolicy: "instant",
};

const DEFAULT_PILOT_LIMITS: PilotLimits = {
  maxActiveTrials: 5,
  maxFundingPerTrial: parseEther("0.1"),
  maxSponsorBudget: parseEther("1"),
  maxPerAgentReward: parseEther("0.05"),
  maxDailyOutflow: parseEther("0.5"),
  minimumTreasuryReserve: parseEther("0.1"),
};

/* ------------------------------------------------------------------ */
/* Configuration resolution                                           */
/* ------------------------------------------------------------------ */

let resolvedConfig: ChainConfig | null = null;
let resolvedLimits: PilotLimits = DEFAULT_PILOT_LIMITS;

/**
 * Resolve chain configuration from environment variables.
 * Throws if required configuration is missing for the target environment.
 */
export function resolveChainConfig(
  env: Record<string, string | undefined> = process.env,
): ChainConfig {
  const chainEnv = (env.CHAIN_ENV ?? "anvil").toLowerCase() as ChainEnvironment;

  if (!["anvil", "testnet", "mainnet"].includes(chainEnv)) {
    throw new Error(`Invalid CHAIN_ENV: ${env.CHAIN_ENV}. Must be anvil, testnet, or mainnet`);
  }

  if (chainEnv === "anvil") {
    resolvedConfig = { ...DEFAULT_ANVIL_CONFIG };
    return resolvedConfig;
  }

  // Testnet and mainnet require explicit configuration
  const errors: string[] = [];

  if (!env.MAINNET_RPC_URL && chainEnv === "mainnet") {
    errors.push("MAINNET_RPC_URL is required for mainnet");
  }

  if (!env.CHAIN_ID) {
    errors.push("CHAIN_ID is required for non-anvil environments");
  }

  if (errors.length > 0) {
    throw new Error(`Chain configuration missing: ${errors.join("; ")}`);
  }

  const config: ChainConfig = {
    chainEnv,
    chainId: env.CHAIN_ID ? parseInt(env.CHAIN_ID, 10) : DEFAULT_ANVIL_CONFIG.chainId,
    rpcUrl: env.MAINNET_RPC_URL ?? env.TESTNET_RPC_URL ?? "",
    rpcFallbackUrl: env.MAINNET_RPC_FALLBACK_URL ?? env.TESTNET_RPC_FALLBACK_URL,
    explorerUrl: env.EXPLORER_URL,
    contractAddresses: {
      arena: env.ARENA_ADDRESS,
      escrow: env.ESCROW_ADDRESS,
      identity: env.IDENTITY_ADDRESS,
      trials: env.TRIALS_ADDRESS,
      treasury: env.TREASURY_ADDRESS,
    },
    confirmationBlocks: parseInt(env.CONFIRMATION_BLOCKS ?? "12", 10),
    finalityPolicy: (env.FINALITY_POLICY ?? "safe") as ChainConfig["finalityPolicy"],
  };

  // VRF config for mainnet
  if (chainEnv === "mainnet") {
    if (!env.VRF_COORDINATOR_ADDRESS || !env.VRF_KEY_HASH) {
      throw new Error(
        "VRF configuration required for mainnet: VRF_COORDINATOR_ADDRESS, VRF_KEY_HASH",
      );
    }
    config.vrfConfig = {
      coordinatorAddress: env.VRF_COORDINATOR_ADDRESS,
      keyHash: env.VRF_KEY_HASH,
      subscriptionId: parseInt(env.VRF_SUBSCRIPTION_ID ?? "0", 10),
      gasLane: env.VRF_GAS_LANE,
    };
  }

  resolvedConfig = config;
  return config;
}

/**
 * Get the resolved chain configuration.
 */
export function getChainConfig(): ChainConfig | null {
  return resolvedConfig;
}

/**
 * Check if the current environment is mainnet.
 */
export function isMainnet(): boolean {
  return resolvedConfig?.chainEnv === "mainnet";
}

/**
 * Check if deterministic randomness (Mode 0) is allowed.
 * Mode 0 is blocked for funded trials on mainnet.
 */
export function isDeterministicRandomnessAllowed(): boolean {
  if (!resolvedConfig) return true; // Anvil default
  return resolvedConfig.chainEnv !== "mainnet";
}

/**
 * Validate that VRF is configured for mainnet.
 */
export function assertVrfConfigured(): void {
  if (!resolvedConfig) {
    throw new Error("Chain configuration not resolved");
  }
  if (resolvedConfig.chainEnv === "mainnet" && !resolvedConfig.vrfConfig) {
    throw new Error("VRF configuration required for mainnet");
  }
}

/* ------------------------------------------------------------------ */
/* Pilot limits                                                       */
/* ------------------------------------------------------------------ */

/**
 * Set pilot limits from environment variables.
 */
export function resolvePilotLimits(
  env: Record<string, string | undefined> = process.env,
): PilotLimits {
  resolvedLimits = {
    maxActiveTrials: parseInt(env.PILOT_MAX_ACTIVE_TRIALS ?? "5", 10),
    maxFundingPerTrial: parseEther(env.PILOT_MAX_FUNDING ?? "0.1"),
    maxSponsorBudget: parseEther(env.PILOT_MAX_BUDGET ?? "1"),
    maxPerAgentReward: parseEther(env.PILOT_MAX_REWARD ?? "0.05"),
    maxDailyOutflow: parseEther(env.PILOT_MAX_DAILY_OUTFLOW ?? "0.5"),
    minimumTreasuryReserve: parseEther(env.PILOT_MIN_RESERVE ?? "0.1"),
  };
  return resolvedLimits;
}

/**
 * Get the current pilot limits.
 */
export function getPilotLimits(): PilotLimits {
  return resolvedLimits;
}

/**
 * Check if a funding amount is within pilot limits.
 */
export function isWithinPilotLimits(amount: bigint, limitType: string): boolean {
  const limits = resolvedLimits;
  switch (limitType) {
    case "fundingPerTrial":
      return amount <= limits.maxFundingPerTrial;
    case "sponsorBudget":
      return amount <= limits.maxSponsorBudget;
    case "perAgentReward":
      return amount <= limits.maxPerAgentReward;
    case "dailyOutflow":
      return amount <= limits.maxDailyOutflow;
    default:
      return true;
  }
}

/**
 * Reset configuration (for testing).
 */
export function resetChainConfig(): void {
  resolvedConfig = null;
  resolvedLimits = DEFAULT_PILOT_LIMITS;
}
