import type { Address } from "viem";

/**
 * The three networks this build can ship to — mainnet, testnet and the local forge —
 * and everything that must be decided from the network name alone: chain id, RPC,
 * deployment addresses, and the plain-words money story.
 *
 * This module exists so that server code which only needs the network *identity* (the
 * `.well-known` record, for one) does not have to import `wagmi.ts` — whose module graph
 * pulls in wagmi, RainbowKit and every connector, a cost no JSON route should pay. It
 * therefore has **no runtime chain-definition imports**: `viem/chains` is a barrel of
 * every chain viem knows, and loading it costs more than this whole module. The chain
 * *definitions* (explorers, currencies) live in `wagmi.ts`, which pays for the barrel
 * anyway. The ids below are pinned to viem's by the type assertion — if one drifts,
 * `tsc` fails, not a wallet pointing at the wrong network.
 *
 * ── Why nothing here throws ──────────────────────────────────────────────────────────
 * These values are read during prerender and by tests that set `process.env` directly.
 * If a missing address threw, `next build` would fail on a fresh clone. So resolution
 * never throws: absent addresses become the zero address, a mistyped network name falls
 * back to Sepolia, and `configured` records whether the deployment is real. The refusal
 * happens later, in `assertConfigured()` in `wagmi.ts`, at the exact moment a signature
 * is actually being requested — where a clear message can do some good.
 */

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export const CHAIN_IDS = {
  mainnet: 1,
  sepolia: 11155111,
  foundry: 31337,
} as const;

// Compile-time pin, erased at runtime: the constants above must equal viem's own chain
// definitions, or the wallet code (which uses viem's objects) and every decision made
// here (which uses these numbers) would disagree about which network is which.
type ChainIdsMatchViem =
  typeof CHAIN_IDS["mainnet"] extends (typeof import("viem/chains"))["mainnet"]["id"]
    ? typeof CHAIN_IDS["sepolia"] extends (typeof import("viem/chains"))["sepolia"]["id"]
      ? typeof CHAIN_IDS["foundry"] extends (typeof import("viem/chains"))["foundry"]["id"]
        ? true
        : false
      : false
    : false;
const _chainIdsMatchViem: ChainIdsMatchViem = true;
void _chainIdsMatchViem;

export type SupportedChain = keyof typeof CHAIN_IDS;

/**
 * The chain this build talks to, named — not a raw cast of an env var.
 *
 * The first version cast `NEXT_PUBLIC_CHAIN` straight to `SupportedChain`, so a typo
 * (`NEXT_PUBLIC_CHAIN=seoplia`) sailed past this function and blew up later, in `rpcUrl`,
 * as `FALLBACK_RPC[undefined]`. A configuration error should degrade to the default
 * network, not to a crash three modules away — same law as `address()` below: resolution
 * never throws, the refusal happens where a clear message can do some good.
 */
export function activeChain(): SupportedChain {
  const raw = process.env.NEXT_PUBLIC_CHAIN as SupportedChain | undefined;
  return raw && raw in CHAIN_IDS ? raw : "sepolia";
}

/** Human name for a chain id, for the wrong-network notice. */
export function chainLabel(chainId: number): string {
  if (chainId === CHAIN_IDS.mainnet) return "Ethereum Mainnet";
  if (chainId === CHAIN_IDS.sepolia) return "Sepolia";
  if (chainId === CHAIN_IDS.foundry) return "Anvil";
  return `chain ${chainId}`;
}

/**
 * The header's environment chip. Each arm names the network's money in plain words: the
 * local and test chains have worthless ETH, mainnet does not, and a visitor should be
 * able to tell which one they are on without reading a chain id.
 */
export function environmentBadge(): { label: string; compact: string; title: string } {
  switch (activeChain()) {
    case "foundry":
      return {
        label: "LOCAL FORGE",
        compact: "ANVIL",
        title: "Anvil: a local chain run by this deployment. The ETH here has no value.",
      };
    case "mainnet":
      return {
        label: "MAINNET",
        compact: "MAINNET",
        title: "Ethereum mainnet: real ETH with real value. Signatures can move funds.",
      };
    default:
      return {
        label: "TESTNET",
        compact: "TESTNET",
        title: "Sepolia: test network ETH. No mainnet funds move here.",
      };
  }
}

export interface Deployment {
  chainId: number;
  trials: Address;
  alloy: Address;
  /** false when the addresses are absent — reads still work, writes do not. */
  configured: boolean;
}

/**
 * Resolve an address, or the zero address. Never throws; validation is `configured`.
 *
 * `value` is passed in rather than looked up as `process.env[name]`. Webpack inlines only
 * *statically analyzable* member expressions into the client bundle, so a dynamic index is
 * left as a real object access — and `process.env` does not exist in a browser. Every
 * address therefore resolved to zero on the client while resolving correctly on the server,
 * which meant the documented setup (copy `.env.example` to `.env.local`, fill in the two
 * addresses) could never enable signing in the UI, and the "Signing is disabled" notice
 * disagreed with the server's own render of the same page.
 */
function address(name: string, value: string | undefined): Address {
  if (!value) return ZERO_ADDRESS;
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
    // A malformed address is a configuration bug worth shouting about, but only when it
    // is used — not during a build that never signs anything.
    console.warn(`[crucible] ${name} is not a valid address and was ignored.`);
    return ZERO_ADDRESS;
  }
  return value as Address;
}

/**
 * Deployment addresses, per network.
 *
 * The same code shape ships to three networks, and each deployment has its own contracts —
 * a mainnet build must never read the Sepolia addresses out of a shared env file. The
 * per-network vars win when set; the generic ones stay as the fallback so every existing
 * deployment keeps working untouched. Every `process.env` access below is a static member
 * expression on purpose: that is what webpack inlines into the client bundle (see the
 * comment on `address` above), so each branch has to name its variables spelled out.
 */
export function deployment(): Deployment {
  const chain = activeChain();
  const trialsEnv =
    chain === "mainnet"
      ? (process.env.NEXT_PUBLIC_MAINNET_TRIALS_ADDRESS ?? process.env.NEXT_PUBLIC_TRIALS_ADDRESS)
      : chain === "foundry"
        ? (process.env.NEXT_PUBLIC_ANVIL_TRIALS_ADDRESS ?? process.env.NEXT_PUBLIC_TRIALS_ADDRESS)
        : (process.env.NEXT_PUBLIC_SEPOLIA_TRIALS_ADDRESS ?? process.env.NEXT_PUBLIC_TRIALS_ADDRESS);
  const alloyEnv =
    chain === "mainnet"
      ? (process.env.NEXT_PUBLIC_MAINNET_ALLOY_ADDRESS ?? process.env.NEXT_PUBLIC_ALLOY_ADDRESS)
      : chain === "foundry"
        ? (process.env.NEXT_PUBLIC_ANVIL_ALLOY_ADDRESS ?? process.env.NEXT_PUBLIC_ALLOY_ADDRESS)
        : (process.env.NEXT_PUBLIC_SEPOLIA_ALLOY_ADDRESS ?? process.env.NEXT_PUBLIC_ALLOY_ADDRESS);
  const trials = address("trials address", trialsEnv);
  const alloy = address("alloy address", alloyEnv);
  return {
    chainId: CHAIN_IDS[chain],
    trials,
    alloy,
    configured: trials !== ZERO_ADDRESS && alloy !== ZERO_ADDRESS,
  };
}

/** Public fallbacks so a fresh clone renders and can even read a live chain. */
const FALLBACK_RPC: Record<SupportedChain, string> = {
  mainnet: "https://ethereum-rpc.publicnode.com",
  sepolia: "https://ethereum-sepolia-rpc.publicnode.com",
  foundry: "http://127.0.0.1:8545",
};

export function rpcUrl(): string {
  const chain = activeChain();
  const configured =
    chain === "foundry"
      ? process.env.NEXT_PUBLIC_ANVIL_RPC
      : chain === "mainnet"
        ? process.env.NEXT_PUBLIC_MAINNET_RPC
        : process.env.NEXT_PUBLIC_SEPOLIA_RPC;
  return configured || FALLBACK_RPC[chain];
}
