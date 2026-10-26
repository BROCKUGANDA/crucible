"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { useEffect, useState } from "react";
import {
  activeChain,
  binanceProvider,
  CHAIN_IDS,
  chainForWallets,
  deployment,
  rainbowKitProjectId,
  shortAddress,
} from "@/lib/wagmi";
import { ensureChain, type Eip1193Provider } from "@/lib/chainSwitch";
import { haptics, vibrate } from "@/lib/forge";

/**
 * The connect button.
 *
 * Two paths, because RainbowKit's modal needs a WalletConnect project id and the app
 * must not require one to be useful:
 *
 *   * project id present -> RainbowKit's `ConnectButton`, which lists injected wallets
 *     and WalletConnect in one modal
 *   * absent              -> a plain button over the injected connector, so a fresh
 *     clone can still connect a real wallet
 *
 * `WagmiProvider` is always mounted (see Providers), so these hooks are always legal —
 * the button never has to guess whether it is allowed to ask for an account.
 */
export function WalletButton() {
  if (rainbowKitProjectId()) return <RainbowConnect />;
  return <InjectedConnect />;
}

/** RainbowKit's own button, including the account/chain dropdown once connected. */
function RainbowConnect() {
  return <ConnectButton showBalance={false} />;
}

/** The no-project-id path: raw injected connectors, no modal. */
function InjectedConnect() {
  const { connectAsync, connectors, isPending, error } = useConnect();
  const { address } = useAccount();
  const { disconnect } = useDisconnect();
  const [landing, setLanding] = useState(false);
  const [landError, setLandError] = useState<string | null>(null);
  // Detection touches `window`, so it runs after mount: reading it during render would render
  // the Binance button on the client and not on the server, which React treats as a broken tree.
  const [binance, setBinance] = useState(false);
  useEffect(() => setBinance(Boolean(binanceProvider())), []);

  /**
   * Connect, then land on the chain the contracts live on.
   *
   * This deployment runs on a chain no consumer wallet knows, so a visitor who connects is
   * still on the wrong network until it is added — and `wallet_addEthereumChain` needs a
   * browser-reachable RPC to do that. Doing it here, rather than leaving the visitor to find
   * the network menu, is what makes "connect" mean "ready to sign".
   */
  const connectAndLand = async (connector: (typeof connectors)[number]) => {
    setLandError(null);
    setLanding(true);
    try {
      await connectAsync({ connector });
      const provider = (await connector.getProvider()) as Eip1193Provider;
      const chain = chainForWallets();
      const outcome = await ensureChain(provider, chain);
      if (!outcome.ok) {
        setLandError(`Connected, but this trial needs ${chain.name}: ${outcome.message}`);
      }
    } catch (err) {
      setLandError(err instanceof Error ? err.message.split("\n")[0]! : String(err));
    } finally {
      setLanding(false);
    }
  };

  if (address) {
    return (
      <button
        className="btn btn-ghost"
        onClick={() => {
          vibrate(haptics.bondStaked, true);
          disconnect();
        }}
      >
        {shortAddress(address)} · disconnect
      </button>
    );
  }

  const injected = connectors.find((c) => c.type === "injected" && c.id !== "wallet.binance.com");
  const binanceConnector = connectors.find((c) => c.id === "wallet.binance.com");
  const coinbase = connectors.find((c) => c.type === "coinbaseWallet");

  if (!injected && !coinbase && !(binance && binanceConnector)) {
    return (
      <span className="mono" data-tone="ash">
        No wallet found
      </span>
    );
  }

  const busy = isPending || landing;

  return (
    <span className="wallet-inline">
      {injected ? (
        <button
          className="btn btn-primary"
          disabled={busy}
          aria-label="Connect wallet"
          title="Connect wallet"
          onClick={() => {
            vibrate(haptics.bondStaked, true);
            void connectAndLand(injected);
          }}
        >
          {busy ? (
            "Connecting…"
          ) : (
            <>
              <span className="wallet-label-full">Connect wallet</span>
              <span className="wallet-label-short">Connect</span>
            </>
          )}
        </button>
      ) : null}
      {binance && binanceConnector ? (
        <button
          className="btn btn-ghost"
          disabled={busy}
          aria-label="Connect Binance Wallet"
          title="Connect Binance Wallet"
          onClick={() => {
            vibrate(haptics.bondStaked, true);
            void connectAndLand(binanceConnector);
          }}
        >
          <span className="wallet-label-full">Binance Wallet</span>
          <span className="wallet-label-short">Binance</span>
        </button>
      ) : null}
      {coinbase ? (
        <button
          className="btn btn-ghost"
          disabled={busy}
          aria-label="Connect Coinbase Wallet"
          title="Connect Coinbase Wallet"
          onClick={() => {
            vibrate(haptics.bondStaked, true);
            void connectAndLand(coinbase);
          }}
        >
          <span className="wallet-label-full">Coinbase Wallet</span>
          <span className="wallet-label-short">Coinbase</span>
        </button>
      ) : null}
      {landError ?? error ? (
        <span className="mono" data-tone="sear">
          {(landError ?? error?.message ?? "").split("\n")[0]}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Chain guard.
 *
 * Crucible is deployed per chain, so a wallet on the wrong network produces a confusing
 * "contract not deployed" failure. Refusing early with a clear message is kinder.
 */
export function WrongNetworkNotice({ requiredChainId }: { requiredChainId: number }) {
  const { chainId, connector } = useAccount();
  const [switching, setSwitching] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Nothing to check until a wallet is connected.
  if (chainId === undefined || chainId === requiredChainId) return null;

  const name =
    requiredChainId === CHAIN_IDS.sepolia
      ? "Sepolia"
      : requiredChainId === CHAIN_IDS.foundry
        ? "Anvil"
        : `chain ${requiredChainId}`;

  return (
    <div role="alert" className="surface net-alert">
      <strong data-tone="sear">Wrong forge.</strong>{" "}
      <span data-tone="dim">This trial runs on {name}. Switch networks to continue.</span>{" "}
      <button
        className="btn btn-primary net-alert__switch"
        disabled={switching}
        onClick={async () => {
          setSwitching(true);
          setFailure(null);
          try {
            const provider = (await connector?.getProvider()) as Eip1193Provider | undefined;
            if (!provider) {
              setFailure("This wallet did not expose a provider to switch.");
              return;
            }
            // Same helper the connect button uses: a wallet that has never seen this chain
            // has to be offered it (EIP-3085), and `switch` alone dies with 4902.
            const outcome = await ensureChain(provider, chainForWallets());
            if (!outcome.ok) setFailure(outcome.message);
          } finally {
            setSwitching(false);
          }
        }}
      >
        {switching ? "Switching…" : `Switch to ${name}`}
      </button>
      {failure ? (
        <p className="mono" data-tone="sear">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A one-line explanation when the app is running without a deployment behind it. Shown
 * in development only — a read-only demo should not look broken.
 *
 * Rendered only after mount. Whether the deployment resolves depends on `NEXT_PUBLIC_*`
 * reaching the bundle, and that is not guaranteed to be identical on the two sides of
 * hydration in dev — the server reads `process.env` directly while the client gets values
 * inlined at compile time. A notice that appears on one side and not the other is a
 * hydration mismatch on every page that mounts Chrome, and React's recovery is to throw
 * away and rebuild the whole tree.
 */
export function WalletNotConfiguredNotice() {
  const [dismissed, setDismissed] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted || dismissed || deployment().configured) return null;
  if (process.env.NODE_ENV === "production") return null;

  return (
    <div role="status" className="surface env-notice">
      <strong data-tone="gold">Signing is disabled.</strong> This build has
      no Crucible deployment behind it, so reads work and writes do not. Copy{" "}
      <code className="mono">apps/web/.env.example</code> to{" "}
      <code className="mono">.env.local</code> and fill in{" "}
      <code className="mono">NEXT_PUBLIC_TRIALS_ADDRESS</code> and{" "}
      <code className="mono">NEXT_PUBLIC_ALLOY_ADDRESS</code>. Chain:{" "}
      <code className="mono">{activeChain()}</code>.{" "}
      <button className="btn btn-ghost" onClick={() => setDismissed(true)}>
        Dismiss
      </button>
    </div>
  );
}

export { activeChain };