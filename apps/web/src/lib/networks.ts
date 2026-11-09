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
export type SolanaCluster = "devnet" | "mainnet-beta";

export const SOLANA_CLUSTERS: Record<SolanaCluster, string> = {
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};

export function solanaCluster(): SolanaCluster {
  const raw = process.env.NEXT_PUBLIC_SOLANA_CLUSTER as SolanaCluster | undefined;
  if (raw === "mainnet-beta") return "mainnet-beta";
  return "devnet";
}

export function solanaRpcUrl(cluster: SolanaCluster = solanaCluster()): string {
  if (cluster === "mainnet-beta") {
    return process.env.NEXT_PUBLIC_SOLANA_MAINNET_RPC || SOLANA_CLUSTERS["mainnet-beta"];
  }
  return process.env.NEXT_PUBLIC_SOLANA_DEVNET_RPC || SOLANA_CLUSTERS.devnet;
}

export function solanaMoneyNotice(cluster: SolanaCluster): { lead: string; body: string } {
  if (cluster === "mainnet-beta") {
    return {
      lead: "This is the real Solana network.",
      body: "Devnet is for rehearsal. Real SOL and real token value move only after counsel + MetaDAO approval, verified mint, and the signed mainnet manifest. This console never auto-executes.",
    };
  }
  return {
    lead: "This is a Solana sandbox.",
    body: "Devnet assets are worthless. Payment proofs here are fixtures for review — no legal or financial effect, no delivery, no token issuance.",
  };
}

/** The network a wallet chain id belongs to, or null when the wallet is somewhere else. */
export function chainFromId(chainId: number): SupportedChain | null {
  const entry = Object.entries(CHAIN_IDS).find(([, id]) => id === chainId);
  return entry ? (entry[0] as SupportedChain) : null;
}

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
 * The header's environment chip, for the network being *shown* — the connected wallet's
 * chain when one is connected, the build's default when not. Each arm names the network's
 * money in plain words: the local and test chains have worthless ETH, mainnet does not,
 * and a visitor should be able to tell which one they are on without reading a chain id.
 */
export function environmentBadge(
  chain: SupportedChain = activeChain(),
): { label: string; compact: string; title: string } {
  switch (chain) {
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
function addressRecord(): Record<SupportedChain, { trials: string | undefined; alloy: string | undefined }> {
  return {
    mainnet: {
      trials: process.env.NEXT_PUBLIC_MAINNET_TRIALS_ADDRESS ?? process.env.NEXT_PUBLIC_TRIALS_ADDRESS,
      alloy: process.env.NEXT_PUBLIC_MAINNET_ALLOY_ADDRESS ?? process.env.NEXT_PUBLIC_ALLOY_ADDRESS,
    },
    sepolia: {
      trials: process.env.NEXT_PUBLIC_SEPOLIA_TRIALS_ADDRESS ?? process.env.NEXT_PUBLIC_TRIALS_ADDRESS,
      alloy: process.env.NEXT_PUBLIC_SEPOLIA_ALLOY_ADDRESS ?? process.env.NEXT_PUBLIC_ALLOY_ADDRESS,
    },
    foundry: {
      trials: process.env.NEXT_PUBLIC_ANVIL_TRIALS_ADDRESS ?? process.env.NEXT_PUBLIC_TRIALS_ADDRESS,
      alloy: process.env.NEXT_PUBLIC_ANVIL_ALLOY_ADDRESS ?? process.env.NEXT_PUBLIC_ALLOY_ADDRESS,
    },
  };
}

/**
 * The deployment for a chain, resolved from the *connected wallet's* chain id when the
 * caller has one.
 *
 * The first version took no argument and resolved from the build-time network, so the
 * app could only ever talk to one chain per build: a user who switched their wallet to
 * mainnet saw the wrong-network warning forever. Now the caller passes the live chain id
 * and the right contracts follow. Chains this app does not know resolve to an
 * *unconfigured* deployment — reads refuse, writes refuse, and the wrong-network notice
 * steers the user back — never to another network's contracts, which would be the one
 * failure mode worse than a broken page.
 */
function deploymentFor(chain: SupportedChain): Deployment {
  const rec = addressRecord()[chain];
  const trials = address("trials address", rec.trials);
  const alloy = address("alloy address", rec.alloy);
  return {
    chainId: CHAIN_IDS[chain],
    trials,
    alloy,
    configured: trials !== ZERO_ADDRESS && alloy !== ZERO_ADDRESS,
  };
}

export function deployment(chainId?: number): Deployment {
  // No chain given: the build's default network, for spectators who have not connected.
  if (chainId === undefined) return deploymentFor(activeChain());
  const chain = chainFromId(chainId);
  if (chain === null) {
    return { chainId, trials: ZERO_ADDRESS, alloy: ZERO_ADDRESS, configured: false };
  }
  return deploymentFor(chain);
}

/** Whether a chain has a signed-transaction deployment behind it. */
export function chainConfigured(chainId: number): boolean {
  return deployment(chainId).configured;
}

/** Public fallbacks so a fresh clone renders and can even read a live chain. */
const FALLBACK_RPC: Record<SupportedChain, string> = {
  mainnet: "https://ethereum-rpc.publicnode.com",
  sepolia: "https://ethereum-sepolia-rpc.publicnode.com",
  foundry: "http://127.0.0.1:8545",
};

export function rpcUrl(chain: SupportedChain = activeChain()): string {
  const configured =
    chain === "foundry"
      ? process.env.NEXT_PUBLIC_ANVIL_RPC
      : chain === "mainnet"
        ? process.env.NEXT_PUBLIC_MAINNET_RPC
        : process.env.NEXT_PUBLIC_SEPOLIA_RPC;
  return configured || FALLBACK_RPC[chain];
}

/**
 * The money warning the wallet gate shows, per connected network — the sentences a
 * stranger reads at the one button that can move their money.
 *
 * A function of the network, not of the build, because the network is chosen at runtime
 * now: the same page serves a testnet visitor (who must be told the ETH is worthless) and
 * a mainnet visitor (who must be told it is not). The unknown-chain arm exists because a
 * wallet can sit on a network this app does not know; that visitor gets the conservative
 * warning and the wrong-network notice steers them home.
 *
 * Plain words on purpose: "Anvil", "31337" and "testnet" are the vocabulary of whoever
 * built this, not of the person being warned.
 */
export function gateMoneyNotice(chain: SupportedChain | null): { lead: string; body: string } {
  if (chain === "mainnet") {
    return {
      lead: "This is the real network.",
      body: "The forge runs on mainnet, and the metal here is real ETH with real value — a signature can move funds you cannot get back. Think before you sign.",
    };
  }
  if (chain === null) {
    return {
      lead: "This forge runs on a different network.",
      body: "Your wallet is on a network this forge does not know. Switch networks after connecting — and until then, treat everything here as read-only.",
    };
  }
  return {
    lead: "This is a demonstration.",
    body: "The forge runs on a chain kept for showing it off, and the metal here is test ETH — worth nothing, and nothing you do on this page can spend anything real.",
  };
}
