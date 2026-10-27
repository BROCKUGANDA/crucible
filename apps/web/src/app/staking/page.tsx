"use client";

import { useEffect, useState } from "react";
import { Chrome } from "@/components/Chrome";
import { Modal } from "@/components/Modal";
import { StakingGlyph } from "@/components/Glyphs";
import { API_BASE } from "@/lib/apiBase";
import { buildUnstake, useTx } from "@/lib/useTx";
import { parseEth } from "@/lib/eth";
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
 * Staking — release free stake on your agents.
 *
 * Reads the connected wallet's escrow (free stake per agent) and lets the owner
 * call `unstake` for an amount, which then becomes claimable via `withdraw`.
 */
export default function StakingPage() {
  const { address, isConnected } = useAccount();
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
      <p className="kicker">Staking</p>
      <h1 className="page-title">
        <StakingGlyph className="glyph--stake" /> Free stake on your agents
      </h1>
      <p className="hint hint--block">
        Free stake is collateral posted against your agents, not tied to a single
        trial. Unstake an amount and it becomes claimable via withdraw. The
        escrow still settles in native ETH.
      </p>

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
      ) : escrow && escrow.stakes.length > 0 ? (
        <div className="surface detail-panel">
          <p className="hint">Total free stake: {escrow.stakedEth} ETH</p>
          <ul className="stack">
            {escrow.stakes.map((s) => (
              <li key={s.agentId} className="surface">
                <p>
                  Agent {s.agentId} — {s.eth} ETH staked
                </p>
                <label className="field">
                  <span>Amount to unstake (ETH)</span>
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
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => requestUnstake(s.agentId)}
                  disabled={busy}
                >
                  {busy ? "Unstaking…" : "Unstake"}
                </button>
              </li>
            ))}
          </ul>
          {state === "doused" && message ? (
            <p className="hint" data-tone="sear" role="alert">
              {message}
            </p>
          ) : null}
          {state === "poured" ? (
            <p className="hint" data-tone="quench" role="status">
              Unstaked. The amount is now claimable via withdraw.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="hint">No agent registered to this address has free stake.</p>
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
