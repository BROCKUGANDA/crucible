"use client";

import { useState } from "react";
import { Chrome } from "@/components/Chrome";
import { Modal } from "@/components/Modal";
import { SponsorshipGlyph } from "@/components/Glyphs";
import { API_BASE } from "@/lib/apiBase";
import { useAccount } from "wagmi";

/**
 * Apply for test ETH from the funder.
 *
 * The funder dispenses test funds to a connected wallet; CRUCIBLE never holds
 * them and the escrow still settles in native ETH. On mainnet, sponsorship is
 * requested through the external application form instead.
 */
export default function FaucetPage() {
  const { address, isConnected } = useAccount();
  const [amount, setAmount] = useState("0.1");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const externalUrl = (process.env.NEXT_PUBLIC_SPONSORSHIP_URL ?? "").trim();

  async function confirmApply() {
    if (!address) return;
    setConfirming(false);
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`${API_BASE}/faucet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: address, amountEth: Number(amount) }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; grantedEth?: string | null; reason?: string | null; fundable?: boolean }
        | null;
      if (res.ok && body?.ok) {
        setResult(
          body.grantedEth
            ? `Granted ${body.grantedEth} ETH. It is on its way to ${address}.`
            : "Request accepted.",
        );
      } else {
        setError(
          body?.reason ??
            (body?.fundable === false
              ? "No funder is configured on this host."
              : `The request was refused (${res.status}).`),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function requestApply() {
    if (!address) {
      setError("Connect a wallet first — the request needs a destination address.");
      return;
    }
    setError(null);
    setResult(null);
    setConfirming(true);
  }

  return (
    <Chrome>
      <p className="kicker">Apply for ETH</p>
      <h1 className="page-title">
        <SponsorshipGlyph className="glyph--drop" /> Sponsorship of test ETH
      </h1>
      <p className="hint hint--block">
        Request test ETH for a connected wallet. The funder decides the amount and
        sends it to your own wallet; CRUCIBLE never holds it, and the escrow still
        settles in native ETH.
      </p>

      <div className="surface detail-panel">
        <label className="field">
          <span>Amount (ETH)</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
          />
        </label>

        {isConnected && address ? (
          <p className="hint">Destination: {address}</p>
        ) : (
          <p className="hint" role="alert">
            Connect a wallet first.
          </p>
        )}

        <button
          type="button"
          className="btn btn-primary"
          onClick={requestApply}
          disabled={busy || !isConnected}
        >
          {busy ? "Requesting…" : "Apply for sponsorship"}
        </button>

        {result ? (
          <p className="hint" data-tone="quench" role="status">
            {result}
          </p>
        ) : null}
        {error ? (
          <p className="hint" data-tone="sear" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <Modal
        open={confirming}
        title="Apply for ETH sponsorship"
        onRequestClose={() => setConfirming(false)}
        busy={busy}
        actions={
          <>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={confirmApply}
              disabled={busy}
            >
              {busy ? "Requesting…" : "Confirm"}
            </button>
          </>
        }
      >
        <p>
          Request {amount} ETH for {address}? The funder decides the final amount
          and sends it to your own wallet.
        </p>
      </Modal>

      {externalUrl ? (
        <p className="hint hint--block">
          On mainnet, sponsorship is requested through the application form:{" "}
          <a href={externalUrl} target="_blank" rel="noreferrer">
            Apply for ETH sponsorship
          </a>
          .
        </p>
      ) : null}
    </Chrome>
  );
}
