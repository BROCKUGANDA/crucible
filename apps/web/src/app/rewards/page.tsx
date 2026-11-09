"use client";

import { useEffect, useState } from "react";
import { Chrome, Quenching } from "@/components/Chrome";
import { Payload } from "@/components/Payload";
import { API_BASE } from "@/lib/apiBase";
import { deployment } from "@/lib/networks";
import { buildClaimEngram, useTx } from "@/lib/useTx";
import { useAccount } from "wagmi";

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
  const { address, chainId } = useAccount();
  const { send } = useTx();

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
    setDetail(null);
    try {
      if (!address) throw new Error("Connect a wallet to claim.");
      const dep = deployment(chainId);
      if (dep.distributor === "0x0000000000000000000000000000000000000000") {
        throw new Error("Engram distribution is not wired on this network.");
      }
      const res = await fetch(`${API_BASE}/campaigns/${campaignId}/merkle-proof`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`proof ${res.status}`);
      const { amount, proof } = (await res.json()) as { amount: string; proof: `0x${string}`[] };
      const data = buildClaimEngram({ campaignId: BigInt(campaignId), amount: BigInt(amount), proof });
      send(data as `0x${string}`, dep.distributor);
      setClaimId(`${campaignId}:${address.toLowerCase()}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <Chrome>
      <p className="kicker">Rewards</p>
      <h1 className="page-title">Campaigns — real claims via the live API</h1>
      <p className="hint hint--block">
        Browse campaigns, check eligibility, then claim on-chain in one wallet
        transaction — the Merkle claim mints the Engram (ERC-1155) and records
        the campaign as claimed. A reservation alone is not payment; the
        transaction is.
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
              {busy ? "Claiming…" : c.chain === "solana" ? "Reserve SOL claim (devnet)" : "Claim on-chain"}
            </button>
          </li>
        ))}
      </ul>
      {claimId && <p className="hint" data-tone="quench" role="status">Claimed — {claimId}. The Merkle claim mints through the Engram distributor; the chain balance is the record.</p>}
      {detail !== null && detail !== undefined && (
        <Payload value={detail} title="Claim" />
      )}
    </Chrome>
  );
}
