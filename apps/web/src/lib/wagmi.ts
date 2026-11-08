import { createConfig, http, cookieStorage, createStorage, useAccount } from "wagmi";
import { foundry, mainnet, sepolia } from "wagmi/chains";
import { coinbaseWallet, walletConnect, injected as injectedConnector } from "wagmi/connectors";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import {
  base,
  bitgetWallet as rainbowBitgetWallet,
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
  safeWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { bitgetConnector } from "./bitget";
import type { Chain } from "viem/chains";
import type { ChainDescription } from "./chainSwitch";

/**
 * Wallet configuration: injected wallets (MetaMask, Rabby, Brave, and anything
 * EIP-1193 / EIP-6963), Coinbase Wallet, Bitget Wallet, and WalletConnect for mobile.
 *
 * Phantom is deliberately absent. Phantom Portal — the route for Phantom Connect, which
 * offers embedded wallets via Google/Apple sign-in — is not accepting new applications,
 * so that integration is not available to this project. The Phantom *browser extension*
 * still works through the injected connector, because it is EIP-6963 compliant.
 *
 * The network layer itself — chain ids, per-network deployment addresses, RPC, the
 * environment badge — lives in `./networks`, which carries no wallet dependencies. This
 * module is the wallet half and re-exports the network half, so callers keep one import
 * path; server code that only needs network identity imports `./networks` directly and
 * does not pay for the connector graph.
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

export {
  activeChain,
  chainFromId,
  chainLabel,
  chainConfigured,
  CHAIN_IDS,
  deployment,
  environmentBadge,
  gateMoneyNotice,
  rpcUrl,
  ZERO_ADDRESS,
  type SupportedChain,
} from "./networks";

import {
  activeChain,
  chainFromId,
  deployment,
  rpcUrl,
  type Deployment,
  type SupportedChain,
} from "./networks";

/**
 * The chain definition for a network, or for the build default when none is given.
 * Lives here rather than in `networks.ts` because it needs the real chain objects —
 * explorers, native currency — and those come from the `viem/chains` barrel, whose
 * import cost is already paid by every page that mounts the wallet stack. A JSON route
 * that only wants a chain id must not pay it.
 */
export function activeChainDef(chain?: SupportedChain): Chain {
  switch (chain ?? activeChain()) {
    case "mainnet":
      return mainnet;
    case "foundry":
      return foundry;
    default:
      return sepolia;
  }
}

/**
 * The deployment the app should act on right now: the connected wallet's network when a
 * wallet is connected, the build's default network when not.
 *
 * Every page reads its contracts through this hook, which is what makes the network a
 * runtime choice instead of a build-time constant — switch the wallet's network and the
 * contracts, the reads and the signed transactions all follow, without a redeploy.
 */
export function useDeployment(): Deployment {
  const { chainId } = useAccount();
  return deployment(chainId);
}

/** The chain a wallet should be landed on — the build default, or an explicitly chosen one. */
export function chainForWallets(chain?: SupportedChain): ChainDescription {
  const def: Chain = activeChainDef(chain);
  const explorer = def.blockExplorers?.default?.url;
  return {
    chainId: def.id,
    name: (chain ?? activeChain()) === "foundry" ? "Anvil" : def.name,
    rpcUrl: rpcUrl(chain ?? activeChain()),
    nativeCurrency: def.nativeCurrency,
    ...(explorer ? { explorerUrl: explorer } : {}),
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

export function walletConnectEnabled(): boolean {
  return rainbowKitProjectId().length > 0;
}

/**
 * The wallet list handed to RainbowKit when a WalletConnect project id exists.
 *
 * Its own export because what the app decides — which wallets are offered — is not
 * observable in the connectors a Node environment builds. RainbowKit resolves every
 * provider-shaped wallet to a placeholder connector when there is no `window` to probe
 * (`getDefaultConfig` on a server or in a test answers "Mock Connector" for Bitget, MetaMask,
 * Rainbow and WalletConnect alike) and only materialises the real connector in the browser.
 * So a test over `config.connectors` measures RainbowKit's SSR behaviour, not this decision.
 */
export function rainbowWalletGroups() {
  return [
    {
      groupName: "Popular",
      wallets: [
        safeWallet,
        rainbowWallet,
        base,
        metaMaskWallet,
        rainbowBitgetWallet,
        walletConnectWallet,
        injectedWallet,
      ],
    },
  ];
}

/**
 * Every network the app can talk to, registered with the wallet so the *user* chooses
 * between them — mainnet to earn, Sepolia to test, the local forge to develop.
 *
 * The build default (`NEXT_PUBLIC_CHAIN`) is still what a disconnected spectator reads,
 * but a connected wallet is followed, not overridden: the wallet's chain decides which
 * deployment the app acts on. Testnet is listed first on purpose — the audience this
 * order nudges is a first-time visitor deciding where to try the platform.
 */
const CHAINS = [sepolia, mainnet, foundry] as const;

export function buildConfig() {
  const projectId = rainbowKitProjectId();

  /** One transport per registered chain — each network is reached on its own RPC. */
  const transports = Object.fromEntries(
    CHAINS.map((chain) => {
      const network = chainFromId(chain.id);
      if (network === null) {
        // A chain in CHAINS that networks.ts does not know would read contracts from
        // nowhere; refuse at startup rather than at the first signature.
        throw new Error(`chain ${chain.id} is registered with the wallet but has no network record`);
      }
      return [chain.id, http(rpcUrl(network))];
    }),
  ) as Record<1 | 11155111 | 31337, ReturnType<typeof http>>;

  if (projectId) {
    // Add Bitget explicitly while retaining Safe, popular wallets and injected fallback.
    return getDefaultConfig({
      appName: "Crucible",
      projectId,
      chains: [...CHAINS],
      transports,
      wallets: rainbowWalletGroups(),
      ssr: true,
    });
  }

  // No project id: injected wallets still work and the app degrades to a plain button
  // rather than failing to load. Cookie storage keeps the session across SSR passes.
  return createConfig({
    chains: [...CHAINS],
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
      // Bitget has its own global provider namespace and must not be hidden behind
      // the generic window.ethereum fallback.
      bitgetConnector(),
      // Coinbase Wallet is explicit, not left to the injected fallback: its extension
      // and mobile app are a real path for the Base audience, and the classic SDK
      // connector does not need a WalletConnect project id.
      coinbaseWallet({ appName: "Crucible", preference: "all" }),
      ...(projectId ? [walletConnect({ projectId })] : []),
    ],
    transports,
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
 * Refuse to pretend a signature is possible when there is no deployment behind *this*
 * chain — the wallet may be on a network (or a chain the app does not know at all) that
 * has no Crucible contracts, and the refusal has to name that network's situation, not
 * the build default's. Called by `useTx.send`, the only place that needs a live address.
 */
export function assertConfigured(chainId?: number): void {
  if (deployment(chainId).configured) return;
  throw new Error(
    "Crucible is not deployed on this network. Set the per-network addresses " +
      "(NEXT_PUBLIC_MAINNET_TRIALS_ADDRESS, NEXT_PUBLIC_SEPOLIA_TRIALS_ADDRESS, " +
      "NEXT_PUBLIC_ANVIL_TRIALS_ADDRESS — or the generic NEXT_PUBLIC_TRIALS_ADDRESS) " +
      "and the matching alloy addresses in apps/web/.env.local (see .env.example).",
  );
}

/** Human label for an address, matching the copy deck's connect button. */
export function shortAddress(address: string | undefined): string {
  if (!address) return "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
