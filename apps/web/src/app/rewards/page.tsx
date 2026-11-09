"use client";

import { useEffect, useState } from "react";
import { Chrome, Quenching } from "@/components/Chrome";
import { Payload } from "@/components/Payload";
import { API_BASE } from "@/lib/apiBase";

interface Campaign {
  campaignId: string;
  name: string;
  description: string;
  status: string;
  chain: "evm" | "solana";
  cluster?: string;
  assetSymbol?: string;
  totalBudget: string;
  perClaimAmount: string;
}

export default function RewardsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [claimId, setClaimId] = useState<string | null>(null);
  const [detail, setDetail] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  async function load() {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/campaigns`);
      if (!res.ok) throw new Error(`campaigns ${res.status}`);
      const body = await res.json();
      setCampaigns(body.campaigns ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  async function claim(campaignId: string) {
    setBusy(true);
    setError(null);
    setClaimId(null);
    try {
      const res = await fetch(`${API_BASE}/campaigns/${campaignId}/claim`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as { error?: string }).error ?? `claim ${res.status}`);
      setClaimId((body as { claim?: { claimId?: string } }).claim?.claimId ?? "reserved");
      setDetail(body);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <Chrome>
      <p className="kicker">Rewards</p>
      <h1 className="page-title">Campaigns — real claims via the live API</h1>
      <p className="hint hint--block">
        Browse campaigns, check eligibility, reserve a claim. A 201 reserves a
        pending budget slot — it is not payment. Completion requires the
        on-chain transfer and indexer reconciliation.
      </p>
      {error && <p className="hint" role="alert">{error}</p>}
      {loading ? <Quenching label="reading campaigns" /> : null}
      {!loading && !error && campaigns.length === 0 ? (
        <p className="hint">No campaigns are published on this host yet.</p>
      ) : null}
      <ul className="stack">
        {campaigns.map((c) => (
          <li key={c.campaignId} className="surface">
            <p><strong>{c.name}</strong> — {c.status} · {(c.chain ?? "evm").toUpperCase()}{c.chain === "solana" ? ` (${c.cluster ?? "devnet"})` : ""}</p>
            <p className="hint">{c.description} — budget {c.totalBudget}{c.assetSymbol ? ` ${c.assetSymbol}` : ""}, per claim {c.perClaimAmount}</p>
            <button className="btn" disabled={busy} onClick={() => claim(c.campaignId)}>
              {busy ? "Reserving…" : c.chain === "solana" ? "Reserve SOL claim (devnet)" : "Reserve claim"}
            </button>
          </li>
        ))}
      </ul>
      {claimId && <p className="hint" data-tone="quench" role="status">Reserved claim {claimId} (pending — not paid).</p>}
      {detail !== null && detail !== undefined && (
        <Payload value={detail} title="Claim reservation" />
      )}
    </Chrome>
  );
}
