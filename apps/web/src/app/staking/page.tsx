"use client";

import { useEffect, useState } from "react";
import { Chrome } from "@/components/Chrome";
import { Modal } from "@/components/Modal";
import { StakingGlyph } from "@/components/Glyphs";
import { API_BASE } from "@/lib/apiBase";
import { buildAddStake, buildUnstake, buildWithdraw, useTx } from "@/lib/useTx";
import { parseEth } from "@/lib/eth";
import { formatEth } from "@/lib/forge";
import { useDeployment } from "@/lib/wagmi";
import { WrongNetworkNotice } from "@/components/Wallet";
import { useAccount } from "wagmi";

interface Stake {
  agentId: number;
  eth: string;
}

interface EscrowView {
  stakes: Stake[];
  stakedEth: string;
  withdrawableEth: string | null;
}

/**
 * Agent collateral — release free stake on your agents.
 *
 * This is native ETH collateral (bond / free stake / unstake / withdraw),
 * NOT yield staking and NOT NFT locking. Unstake moves funds to withdrawable
 * credit; a separate withdraw call moves credit to the wallet.
 */
export default function StakingPage() {
  const { address, isConnected } = useAccount();
  const dep = useDeployment();
  const { state, message, send, busy } = useTx();
  const [escrow, setEscrow] = useState<EscrowView | null>(null);
  const [loading, setLoading] = useState(false);
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ agentId: number; amount: string } | null>(null);

  useEffect(() => {
    if (!address) {
      setEscrow(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/escrow/${address}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        setEscrow(body as EscrowView);
        const next: Record<number, string> = {};
        for (const s of (body as EscrowView).stakes ?? []) next[s.agentId] = s.eth;
        setAmounts(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address, state]);

  function requestUnstake(agentId: number) {
    const wei = parseEth(amounts[agentId] ?? "0");
    if (wei === null || wei <= 0n) {
      setError("Enter a positive amount.");
      return;
    }
    setError(null);
    setConfirming({ agentId, amount: amounts[agentId] ?? "0" });
  }

  function confirmUnstake() {
    if (!confirming) return;
    const wei = parseEth(confirming.amount);
    if (wei === null || wei <= 0n) return;
    send(buildUnstake(confirming.agentId, wei));
    setConfirming(null);
  }

  const externalUrl = (process.env.NEXT_PUBLIC_STAKING_URL ?? "").trim();

  return (
    <Chrome>
      <p className="kicker">Agent collateral</p>
      <h1 className="page-title">
        <StakingGlyph className="glyph--stake" /> Agent collateral — free stake
      </h1>
      <p className="hint hint--block">
        Agent collateral is native ETH posted against your agents — not yield
        staking and not NFT locking. Step 1: unstake moves stake to withdrawable
        credit. Step 2: withdraw moves that credit to your wallet.
      </p>

      {/* The escrow figures come from the API's chain while every signature goes to the
          connected chain; a wallet on another deployment must be told before it signs. */}
      <WrongNetworkNotice requiredChainId={dep.chainId} />

      {!isConnected || !address ? (
        <p className="hint" role="alert">
          Connect a wallet to see and manage your stake.
        </p>
      ) : loading ? (
        <p className="hint">Reading the escrow…</p>
      ) : error ? (
        <p className="hint" data-tone="sear" role="alert">
          {error}
        </p>
      ) : (
        <div className="surface detail-panel" id="stake-panel">
          <p className="hint">Total free stake: {formatEth(escrow?.stakedEth)}</p>
          <p className="hint">
            Withdrawable credit: {formatEth(escrow?.withdrawableEth)}
          </p>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                const credit = parseEth(escrow?.withdrawableEth ?? "0");
                if (credit === null || credit <= 0n) {
                  setError("No withdrawable credit. Unstake first.");
                  return;
                }
                setError(null);
                send(buildWithdraw());
              }}
              disabled={busy || !escrow?.withdrawableEth || escrow.withdrawableEth === "0"}
            >
              {busy ? "Withdrawing…" : "Withdraw credit"}
            </button>
          </div>
          {escrow && escrow.stakes.length > 0 ? (
          <ul className="stack">
            {escrow.stakes.map((s) => (
              <li key={s.agentId} className="surface">
                <p>
                  Agent {s.agentId} — {formatEth(s.eth)} staked
                </p>
                <label className="field">
                  <span>Amount (ETH) — unstake or add stake</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={amounts[s.agentId] ?? ""}
                    onChange={(e) =>
                      setAmounts((prev) => ({ ...prev, [s.agentId]: e.target.value }))
                    }
                    disabled={busy}
                  />
                </label>
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => requestUnstake(s.agentId)}
                    disabled={busy}
                  >
                    {busy ? "Unstaking…" : "Unstake"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      const wei = parseEth(amounts[s.agentId] ?? "0");
                      if (wei === null || wei <= 0n) {
                        setError("Enter a positive amount.");
                        return;
                      }
                      setError(null);
                      send(buildAddStake(s.agentId, wei));
                    }}
                    disabled={busy}
                  >
                    {busy ? "Adding…" : "Add stake"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          ) : (
            <p className="hint">No agent registered to this address has free stake.</p>
          )}
          {state === "doused" && message ? (
            <p className="hint" data-tone="sear" role="alert">
              {message}
            </p>
          ) : null}
          {state === "poured" ? (
            <p className="hint" data-tone="quench" role="status">
              Done — escrow re-reads on the next block. Unstake moves stake to credit; withdraw moves credit to your wallet.
            </p>
          ) : null}
        </div>
      )}

      <Modal
        open={confirming !== null}
        title="Unstake free stake"
        onRequestClose={() => setConfirming(null)}
        busy={busy}
        actions={
          <>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setConfirming(null)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={confirmUnstake}
              disabled={busy}
            >
              {busy ? "Unstaking…" : "Confirm unstake"}
            </button>
          </>
        }
      >
        {confirming ? (
          <p>
            Unstake {confirming.amount} ETH from agent {confirming.agentId}? It
            becomes claimable via withdraw.
          </p>
        ) : null}
      </Modal>

      {externalUrl ? (
        <p className="hint hint--block">
          External staking program:{" "}
          <a href={externalUrl} target="_blank" rel="noreferrer">
            Apply
          </a>
          .
        </p>
      ) : null}
    </Chrome>
  );
}
