import { createConfig, http, cookieStorage, createStorage } from "wagmi";
import { foundry, sepolia } from "wagmi/chains";
import { coinbaseWallet, walletConnect, injected as injectedConnector } from "wagmi/connectors";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import type { Address, Transport } from "viem";
import type { Chain } from "viem/chains";
import type { ChainDescription } from "./chainSwitch";

/**
 * Wallet configuration: injected wallets (MetaMask, Rabby, Brave, and anything
 * EIP-1193 / EIP-6963), Coinbase Wallet, and WalletConnect for mobile.
 *
 * Phantom is deliberately absent. Phantom Portal — the route for Phantom Connect, which
 * offers embedded wallets via Google/Apple sign-in — is not accepting new applications,
 * so that integration is not available to this project. The Phantom *browser extension*
 * still works through the injected connector, because it is EIP-6963 compliant.
 *
 * ── Why nothing here throws ──────────────────────────────────────────────────────────
 * These values are read at module scope during prerender. If a missing address threw,
 * `next build` would fail on a fresh clone — and a build that needs secrets before it
 * can even compile is a bad developer experience and a much worse demo experience.
 *
 * So resolution never throws: absent addresses become the zero address, an absent RPC
 * falls back to a public endpoint, and `configured` records whether the deployment is
 * real. The refusal happens later, in `assertConfigured()`, at the exact moment a
 * signature is actually being requested — where a clear message can do some good.
 */

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export const CHAIN_IDS = {
  sepolia: sepolia.id,
  foundry: foundry.id,
} as const;

export type SupportedChain = keyof typeof CHAIN_IDS;

export function activeChain(): SupportedChain {
  return (process.env.NEXT_PUBLIC_CHAIN as SupportedChain) ?? "sepolia";
}

export function activeChainDef(): Chain {
  return activeChain() === "foundry" ? foundry : sepolia;
}

/**
 * The header's environment chip. Neither arm of this deployment moves value, and a visitor
 * should not have to read a chain id to learn that.
 */
export function environmentBadge(): { label: string; compact: string; title: string } {
  return activeChain() === "foundry"
    ? {
        label: "LOCAL FORGE",
        compact: "ANVIL",
        title: "Anvil: a local chain run by this deployment. The ETH here has no value.",
      }
    : {
        label: "TESTNET",
        compact: "TESTNET",
        title: "Sepolia: test network ETH. No mainnet funds move here.",
      };
}

/**
 * The explorer URL for a transaction on the active chain, or null when that chain has no
 * explorer to name.
 *
 * Derived from the chain definition rather than written out per call site, because the
 * first version of this hardcoded Sepolia and pointed Anvil hashes at it — a link that
 * opens a page saying the transaction never happened. That is worse than no link: it looks
 * like verification. A null is honest, and the caller renders "no explorer".
 */
export function explorerTxUrl(hash: string, chain: Chain = activeChainDef()): string | null {
  const base = chain.blockExplorers?.default?.url;
  if (!base || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
  return `${base.replace(/\/$/, "")}/tx/${hash}`;
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

export function deployment(): Deployment {
  const trials = address("NEXT_PUBLIC_TRIALS_ADDRESS", process.env.NEXT_PUBLIC_TRIALS_ADDRESS);
  const alloy = address("NEXT_PUBLIC_ALLOY_ADDRESS", process.env.NEXT_PUBLIC_ALLOY_ADDRESS);
  return {
    chainId: CHAIN_IDS[activeChain()],
    trials,
    alloy,
    configured: trials !== ZERO_ADDRESS && alloy !== ZERO_ADDRESS,
  };
}

/** WalletConnect needs a project id; without one we drop it and keep injected only. */
export function rainbowKitProjectId(): string {
  return process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";
}

/**
 * Binance Wallet injects an EIP-1193 provider at `window.binancew3w.ethereum` and does not
 * always answer through `window.ethereum`, so it gets its own connector target instead of
 * relying on generic injection (the vendor's own integration notes say the same).
 */
export function binanceProvider(): unknown {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { binancew3w?: { ethereum?: unknown } }).binancew3w?.ethereum;
}

/**
 * The chain, described the way a wallet needs to hear it before it can sign here.
 *
 * No consumer wallet knows chain 31337, so the app has to be able to *add* it, and the RPC it
 * registers must be the deployed one — `127.0.0.1` would point a remote visitor's wallet at
 * their own machine, producing an empty account that looks like a broken site.
 */
export function chainForWallets(): ChainDescription {
  const chain = activeChainDef();
  const explorer = chain.blockExplorers?.default?.url;
  return {
    chainId: chain.id,
    name: activeChain() === "foundry" ? "Anvil" : chain.name,
    rpcUrl: rpcUrl(),
    nativeCurrency: chain.nativeCurrency,
    ...(explorer ? { explorerUrl: explorer } : {}),
  };
}

export function walletConnectEnabled(): boolean {
  return rainbowKitProjectId().length > 0;
}

/** Public fallbacks so a fresh clone renders and can even read a live chain. */
const FALLBACK_RPC: Record<number, string> = {
  [sepolia.id]: "https://ethereum-sepolia-rpc.publicnode.com",
  [foundry.id]: "http://127.0.0.1:8545",
};

export function rpcUrl(): string {
  const chainId = CHAIN_IDS[activeChain()];
  const configured =
    activeChain() === "foundry"
      ? process.env.NEXT_PUBLIC_ANVIL_RPC
      : process.env.NEXT_PUBLIC_SEPOLIA_RPC;
  return configured || FALLBACK_RPC[chainId]!;
}

export function transportFor(): Transport {
  return http(rpcUrl());
}

export function buildConfig() {
  const chain = activeChainDef();
  const projectId = rainbowKitProjectId();

  if (projectId) {
    // RainbowKit's helper wires up injected + WalletConnect + the rest of its modal
    return getDefaultConfig({
      appName: "Crucible",
      projectId,
      chains: [chain],
      transports: { [chain.id]: transportFor() },
      ssr: true,
    });
  }

  // No project id: injected wallets still work and the app degrades to a plain button
  // rather than failing to load. Cookie storage keeps the session across SSR passes.
  return createConfig({
    chains: [chain],
    connectors: [
      injectedConnector({ shimDisconnect: true }),
      // Binance Wallet is named explicitly because it does not reliably answer through
      // `window.ethereum`; the connector is dormant until the wallet's own provider exists.
      injectedConnector({
        shimDisconnect: true,
        target: {
          id: "wallet.binance.com",
          name: "Binance Wallet",
          provider: () => binanceProvider() as never,
        },
      }),
      // Coinbase Wallet is explicit, not left to the injected fallback: its extension
      // and mobile app are a real path for the Base audience, and the classic SDK
      // connector does not need a WalletConnect project id.
      coinbaseWallet({ appName: "Crucible", preference: "all" }),
      ...(projectId ? [walletConnect({ projectId })] : []),
    ],
    transports: { [chain.id]: transportFor() },
    ssr: true,
    storage: createStorage({ storage: cookieStorage }),
  });
}

let cached: ReturnType<typeof buildConfig> | null = null;

/**
 * The wagmi config. Always built, so `WagmiProvider` can always be mounted and wagmi's
 * hooks are always legal to call — pages do not have to know whether signing is
 * configured in order to render.
 */
export function wagmiConfig() {
  cached ??= buildConfig();
  return cached;
}

/**
 * Refuse to pretend a signature is possible when there is no deployment behind it.
 * Called by `useTx.send`, which is the only place that actually needs a live address.
 */
export function assertConfigured(): void {
  if (deployment().configured) return;
  throw new Error(
    "Crucible is not deployed in this environment. Set NEXT_PUBLIC_TRIALS_ADDRESS and " +
      "NEXT_PUBLIC_ALLOY_ADDRESS in apps/web/.env.local (see .env.example).",
  );
}

/** Human label for an address, matching the copy deck's connect button. */
export function shortAddress(address: string | undefined): string {
  if (!address) return "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export { sepolia, foundry };