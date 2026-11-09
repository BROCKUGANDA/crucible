"use client";

import { useEffect, useState } from "react";
import { Chrome } from "@/components/Chrome";
import { API_BASE } from "@/lib/apiBase";
import { solanaCluster, solanaMoneyNotice } from "@/lib/wagmi";

type SolanaState = {
  address: string | null;
  cluster: string;
  connected: boolean;
};

declare global {
  interface Window {
    solana?: {
      isPhantom?: boolean;
      connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toString: () => string } }>;
      disconnect: () => Promise<void>;
      publicKey?: { toString: () => string } | null;
    };
  }
}

function readSolana(): SolanaState {
  if (typeof window === "undefined") return { address: null, cluster: "devnet", connected: false };
  const pk = window.solana?.publicKey?.toString() ?? null;
  return { address: pk, cluster: solanaCluster(), connected: pk !== null };
}

export default function SolanaPage() {
  const [sol, setSol] = useState<SolanaState>({ address: null, cluster: "devnet", connected: false });
  const [error, setError] = useState<string | null>(null);
  const [ownership, setOwnership] = useState<unknown>(null);
  const notice = solanaMoneyNotice(sol.cluster as "devnet" | "mainnet-beta");

  useEffect(() => {
    setSol(readSolana());
    fetch(`${API_BASE}/stamp/protocol/ownership`)
      .then((r) => r.json().then((b) => ({ ok: r.ok, body: b })))
      .then(({ ok, body }) => { if (ok) setOwnership(body); })
      .catch(() => {});
  }, []);

  async function connect() {
    setError(null);
    try {
      const provider = window.solana;
      if (!provider) {
        setError("No Solana wallet found. Install Phantom (EIP-6963 extension works) or another Solana wallet.");
        return;
      }
      const res = await provider.connect();
      setSol({ address: res.publicKey.toString(), cluster: solanaCluster(), connected: true });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function disconnect() {
    try { await window.solana?.disconnect(); } catch { /* ignore */ }
    setSol({ address: null, cluster: solanaCluster(), connected: false });
  }

  return (
    <Chrome>
      <p className="kicker">Solana · {sol.cluster}</p>
      <h1 className="page-title">Solana console — sandbox, wallet-connected</h1>
      <div className="surface detail-panel">
        <p className="hint hint--block"><strong>{notice.lead}</strong> {notice.body}</p>
        {sol.cluster !== "devnet" && (
          <p className="hint hint--block" data-tone="sear">
            Mainnet-beta selected. Console is read-only rehearsal: no delivery, no token issuance, no fund movement from this page.
          </p>
        )}
        {sol.connected ? (
          <>
            <p className="hint">Connected: <span className="mono">{sol.address}</span> ({sol.cluster})</p>
            <button className="btn btn-ghost" onClick={disconnect}>Disconnect</button>
          </>
        ) : (
          <button className="btn btn-primary" onClick={connect}>Connect Solana wallet</button>
        )}
        {error && <p className="hint" role="alert">{error}</p>}
      </div>

      <div className="surface detail-panel">
        <h2 className="section-title">How Solana earning works here</h2>
        <ol className="hint hint--block">
          <li>1. Work is evaluated and settled on EVM (Sepolia testnet) — Engrams, campaigns, agent collateral.</li>
          <li>2. STAMP legal entitlements (if Path A approved) are tracked off-chain + devnet fixtures — <span className="mono">/stamp</span> routes, manual review only.</li>
          <li>3. Token delivery/vesting happens only through the MetaDAO-approved path after counsel sign-off — never from this console.</li>
        </ol>
        {ownership !== null && ownership !== undefined && (
          <pre className="code">{JSON.stringify(ownership as Record<string, unknown>, null, 2)}</pre>
        )}
      </div>
    </Chrome>
  );
}
