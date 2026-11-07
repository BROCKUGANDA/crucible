"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import {
  activeChain,
  CHAIN_IDS,
  chainConfigured,
  chainForWallets,
  chainFromId,
  chainLabel,
  environmentBadge,
  type SupportedChain,
} from "@/lib/wagmi";
import { ensureChain, type Eip1193Provider } from "@/lib/chainSwitch";

/**
 * The network chip in the header, made into a switch.
 *
 * The network stopped being a build-time constant the moment the app started following
 * the wallet: the same page serves a Sepolia tester and a mainnet earner, and the only
 * honest chip is one that shows the wallet's actual network and lets the visitor move.
 * The choice is still executed BY the wallet (`wallet_switchEthereumChain` through the
 * same `ensureChain` helper the connect button uses) — this menu never pretends to
 * change the app's network behind the wallet's back, because the signature authority
 * is the wallet's, not ours.
 *
 * Each entry says whether that network has a live deployment. A network without one is
 * still offered — a visitor may want to test reads on a fresh Anvil — but it is labelled
 * "reads only" so nobody switches expecting to stake a bond into nothing.
 */

const NETWORKS: SupportedChain[] = ["sepolia", "mainnet", "foundry"];

export function NetworkMenu() {
  const { chainId, connector } = useAccount();
  const [busy, setBusy] = useState<SupportedChain | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const ref = useRef<HTMLDetailsElement | null>(null);

  // A route change closes the More menu (see Chrome); the network menu deserves the
  // same courtesy, but the menu lives on this component, so this is where it closes.
  // Clicking anywhere else is the other way out — a dropdown that ignores the rest of
  // the page reads as broken.
  useEffect(() => {
    if (!ref.current) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  const connected = chainId !== undefined;
  const walletNetwork = connected ? chainFromId(chainId) : null;
  const shown = walletNetwork ?? activeChain();
  const badge = environmentBadge(shown);

  // A wallet can sit on a chain this app does not know (Base, a fork, anything). The
  // chip must not lie about it: "WRONG NET" with a plain title, and the menu offers
  // the way back.
  const lost = connected && walletNetwork === null;
  const label = lost ? "WRONG NET" : badge.label;
  const compact = lost ? "×" : badge.compact;
  const title = lost
    ? "Your wallet is on a network this forge does not know. Pick a network below to continue."
    : connected
      ? badge.title
      : `${badge.title} Connect a wallet to switch.`;

  async function select(chain: SupportedChain) {
    if (chain === shown) {
      if (ref.current) ref.current.open = false;
      return;
    }
    setBusy(chain);
    setFailure(null);
    try {
      const provider = (await connector?.getProvider()) as Eip1193Provider | undefined;
      if (!provider) {
        setFailure("Connect a wallet first — the network is changed by your wallet, not by this site.");
        return;
      }
      const outcome = await ensureChain(provider, chainForWallets(chain));
      if (!outcome.ok) {
        setFailure(outcome.message);
        return;
      }
      if (ref.current) ref.current.open = false;
    } finally {
      setBusy(null);
    }
  }

  return (
    <details className="chrome__net" ref={ref}>
      <summary
        className="chrome__net-summary"
        title={title}
        aria-label={`Network: ${label}. Change network`}
      >
        <span className="chip chrome__env chrome__env--wide">{label}</span>
        <span className="chip chrome__env chrome__env--compact">{compact}</span>
      </summary>
      <div className="chrome__net-panel">
        {NETWORKS.map((chain) => {
          const configured = chainConfigured(CHAIN_IDS[chain]);
          return (
            <button
              key={chain}
              type="button"
              className="chrome__net-item"
              disabled={busy !== null}
              aria-current={chain === shown ? "true" : undefined}
              onClick={() => void select(chain)}
            >
              <span className="chrome__net-name">{chainLabel(CHAIN_IDS[chain])}</span>
              <span className="chrome__net-status" data-tone={configured ? "gold" : "dim"}>
                {busy === chain
                  ? "Switching…"
                  : chain === shown
                    ? "You are here"
                    : configured
                      ? "Live"
                      : "Reads only"}
              </span>
            </button>
          );
        })}
        {failure ? (
          <p className="mono chrome__net-failure" data-tone="sear">
            {failure}
          </p>
        ) : null}
      </div>
    </details>
  );
}
