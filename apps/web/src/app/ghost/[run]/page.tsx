"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Chrome, ColdForge } from "@/components/Chrome";
import { formatEth } from "@/lib/forge";

interface ForkInfo { rpcUrl: string; forkBlock: number; chainId: number; accounts: { address: string; balanceEth: string }[]; }

export default function GhostRunPage() {
  const [info, setInfo] = useState<ForkInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const provision = async (trialId: number) => {
    setLoading(true); setError(null);
    const base = (process.env.NEXT_PUBLIC_FORK_HOST_URL as string) || "http://127.0.0.1:8790";
    try {
      const r = await fetch(`${base}/ghost`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trialId }) });
      if (!r.ok) throw new Error(await r.text());
      setInfo(await r.json());
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = Number(params.get("trial"));
    if (Number.isSafeInteger(t) && t > 0) provision(t);
  }, []);

  return (
    <Chrome>
      <p className="kicker">Ghost run</p>
      <h1 className="page-title">A trial on a private fork</h1>
      {loading && <p className="hint">Provisioning fork…</p>}
      {error && <p className="hint hint--block">Fork host error: {error}</p>}
      {info && (
        <div className="hint hint--block">
          <p>RPC: <span className="mono">{info.rpcUrl}</span></p>
          <p>Fork block: {info.forkBlock} · chainId: {info.chainId}</p>
          <p>Accounts: {info.accounts.map(a => `${a.address} (${formatEth(a.balanceEth)})`).join(", ")}</p>
        </div>
      )}
      {!info && !loading && <ColdForge line="Open a trial first, then fork it into a ghost run." cta="Open the trials board" href="/trials" />}
      <p className="hint hint--block">
        Related doors: <Link href="/trials">Trials</Link> <Link href="/arena">Arena</Link>
      </p>
    </Chrome>
  );
}