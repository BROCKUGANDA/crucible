"use client";

import { useState } from "react";
import { Chrome } from "@/components/Chrome";
import { Modal } from "@/components/Modal";
import { AirdropGlyph } from "@/components/Glyphs";
import { API_BASE } from "@/lib/apiBase";
import { useAccount } from "wagmi";

/**
 * Airdrops — request test ETH for a connected wallet.
 *
 * Reuses the funder's allocation endpoint (the same path as sponsorship) so a
 * wallet can claim test funds without a separate contract. CRUCIBLE never holds
 * them.
 */
export default function AirdropsPage() {
  const { address, isConnected } = useAccount();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const externalUrl = (process.env.NEXT_PUBLIC_AIRDROP_URL ?? "").trim();

  async function confirmClaim() {
    if (!address) return;
    setConfirming(false);
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`${API_BASE}/faucet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: address, amountEth: 0.1 }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; grantedEth?: string | null; reason?: string | null; fundable?: boolean }
        | null;
      if (res.ok && body?.ok) {
        setResult(
          body.grantedEth
            ? `Airdropped ${body.grantedEth} ETH to ${address}.`
            : "Claim accepted.",
        );
      } else {
        setError(
          body?.reason ??
            (body?.fundable === false
              ? "No funder is configured on this host."
              : `The claim was refused (${res.status}).`),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function requestClaim() {
    if (!address) {
      setError("Connect a wallet first.");
      return;
    }
    setError(null);
    setResult(null);
    setConfirming(true);
  }

  return (
    <Chrome>
      <p className="kicker">Airdrops</p>
      <h1 className="page-title">
        <AirdropGlyph className="glyph--chute" /> Claim test ETH
      </h1>
      <p className="hint hint--block">
        Claim a small test allocation for a connected wallet. The funder decides
        the amount and sends it to your own wallet; CRUCIBLE never holds it.
      </p>

      <div className="surface detail-panel">
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
          onClick={requestClaim}
          disabled={busy || !isConnected}
        >
          {busy ? "Claiming…" : "Claim airdrop"}
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
        title="Claim airdrop"
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
              onClick={confirmClaim}
              disabled={busy}
            >
              {busy ? "Claiming…" : "Confirm claim"}
            </button>
          </>
        }
      >
        <p>Claim the test ETH airdrop for {address}?</p>
      </Modal>

      {externalUrl ? (
        <p className="hint hint--block">
          External airdrop program:{" "}
          <a href={externalUrl} target="_blank" rel="noreferrer">
            Apply
          </a>
          .
        </p>
      ) : null}
    </Chrome>
  );
}
