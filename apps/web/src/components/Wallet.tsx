"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { useState } from "react";
import {
  activeChain,
  CHAIN_IDS,
  deployment,
  rainbowKitProjectId,
  shortAddress,
} from "@/lib/wagmi";
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
  const { connect, connectors, isPending, error } = useConnect();
  const { address } = useAccount();
  const { disconnect } = useDisconnect();

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

  const injected = connectors.find((c) => c.type === "injected");
  if (!injected) {
    return (
      <span className="mono" style={{ color: "var(--ash)" }}>
        No injected wallet found
      </span>
    );
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <button
        className="btn btn-primary"
        disabled={isPending}
        onClick={() => {
          vibrate(haptics.bondStaked, true);
          connect({ connector: injected });
        }}
      >
        {isPending ? "Connecting…" : "Connect wallet"}
      </button>
      {error ? (
        <span className="mono" style={{ color: "var(--sear)" }}>
          {error.message.split("\n")[0]}
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
  const { chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const [switching, setSwitching] = useState(false);

  // Nothing to check until a wallet is connected.
  if (chainId === undefined || chainId === requiredChainId) return null;

  const name =
    requiredChainId === CHAIN_IDS.sepolia
      ? "Sepolia"
      : requiredChainId === CHAIN_IDS.foundry
        ? "Anvil"
        : `chain ${requiredChainId}`;

  return (
    <div
      role="alert"
      className="surface"
      style={{ padding: 16, borderColor: "var(--sear)", marginBottom: 16 }}
    >
      <strong style={{ color: "var(--sear)" }}>Wrong forge.</strong>{" "}
      <span style={{ color: "var(--dim)" }}>This trial runs on {name}. Switch networks to continue.</span>{" "}
      <button
        className="btn btn-primary"
        disabled={switching}
        style={{ marginLeft: 12 }}
        onClick={async () => {
          setSwitching(true);
          try {
            await switchChain({ chainId: requiredChainId });
          } finally {
            setSwitching(false);
          }
        }}
      >
        {switching ? "Switching…" : `Switch to ${name}`}
      </button>
    </div>
  );
}

/**
 * A one-line explanation when the app is running without a deployment behind it. Shown
 * in development only — a read-only demo should not look broken.
 */
export function WalletNotConfiguredNotice() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || deployment().configured) return null;
  if (process.env.NODE_ENV === "production") return null;

  return (
    <div
      role="status"
      className="surface"
      style={{
        margin: "16px 32px 0",
        padding: 14,
        borderColor: "var(--gold)",
        fontSize: 13.5,
        color: "var(--dim)",
      }}
    >
      <strong style={{ color: "var(--gold)" }}>Signing is disabled.</strong> This build has
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

/** The active network label, for the header. */
export function useNetworkLabel(): string {
  const { chainId } = useAccount();
  if (chainId === undefined) return "not connected";
  if (chainId === CHAIN_IDS.sepolia) return "Sepolia";
  if (chainId === CHAIN_IDS.foundry) return "Anvil";
  return `chain ${chainId}`;
}

export { activeChain };