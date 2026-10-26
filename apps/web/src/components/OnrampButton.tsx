"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { API_BASE } from "@/lib/apiBase";
import { onrampUrl } from "@/lib/onramp";

/**
 * A sponsor's fiat -> ETH on-ramp, minted per click.
 *
 * The primary path asks the API for a fresh Coinbase session; the URL it returns is single-use
 * and expires in minutes, so nothing here is prefetched or cached. If the session endpoint is
 * not configured, the provider landing URL is a fallback rather than a dead button. The escrow
 * still takes native ETH; the provider sends it to the sponsor's own wallet and CRUCIBLE never
 * holds it.
 */
export function OnrampButton() {
  const { address } = useAccount();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const landing = onrampUrl({ chainId: 1 });

  async function start() {
    if (!address) {
      setReason("Connect a wallet first — the session needs a destination address.");
      return;
    }
    setBusy(true);
    setReason(null);
    try {
      const res = await fetch(`${API_BASE}/onramp/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: address }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; url?: string; reason?: string }
        | null;

      if (res.ok && body?.ok && typeof body.url === "string") {
        const url = new URL(body.url);
        if (url.protocol === "https:" && url.hostname === "pay.coinbase.com") {
          window.location.assign(url.toString());
          return;
        }
      }

      if (landing) {
        window.location.assign(landing);
        return;
      }
      setReason(body?.reason ?? `The on-ramp is unavailable (${res.status}).`);
    } catch (err) {
      if (landing) {
        window.location.assign(landing);
        return;
      }
      setReason(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" className="btn btn-primary" onClick={start} disabled={busy}>
        {busy ? "Opening a session…" : "Buy ETH with a card"}
      </button>
      <p className="hint">
        A fresh single-use session when available. Mainnet ETH only. CRUCIBLE never holds it.
      </p>
      {reason ? (
        <p className="hint" role="alert" aria-live="polite">
          {reason}
        </p>
      ) : null}
    </div>
  );
}
