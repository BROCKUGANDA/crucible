"use client";

import { useState } from "react";
import { Chrome } from "@/components/Chrome";
import { useReadContract } from "wagmi";
import { VERIFICATION_RECEIPT_ABI } from "@/lib/verificationReceipt";
import { receiptView } from "@/lib/verify-view";

/**
 * Public-verify page (gate 417): paste a tokenId → verdictHash + promptHash shown.
 * Reads straight from the VerificationReceipt contract; no API, no trust in Crucible's backend.
 */
export default function VerifyPage() {
  const [input, setInput] = useState("");
  const tokenId = /^\d+$/.test(input.trim()) ? BigInt(input.trim()) : undefined;
  const invalid = input.trim() !== "" && tokenId === undefined;

  const receipt = verificationReceiptAddress();

  const ownerRead = useReadContract({
    address: receipt,
    abi: VERIFICATION_RECEIPT_ABI,
    functionName: "ownerOf",
    args: tokenId ? [tokenId] : undefined,
    query: { enabled: tokenId !== undefined },
  });

  const uriRead = useReadContract({
    address: receipt,
    abi: VERIFICATION_RECEIPT_ABI,
    functionName: "tokenURI",
    args: tokenId ? [tokenId] : undefined,
    query: { enabled: tokenId !== undefined },
  });

  // One state for the whole panel, so a refusal, a pending read and an unwired deployment stop
  // printing the same em dash. See lib/verify-view.ts for why the difference is the feature.
  const view = receiptView({
    address: receipt,
    typed: tokenId !== undefined,
    reading: ownerRead.isPending || uriRead.isPending,
    error: ownerRead.error ?? uriRead.error,
    owner: ownerRead.data === undefined ? undefined : String(ownerRead.data),
    uri: uriRead.data === undefined ? undefined : String(uriRead.data),
  });

  return (
    <Chrome>
      <p className="kicker">Verify a receipt</p>
      <h1 className="page-title">Verification Receipt</h1>
      <p className="hint hint--block">
        Paste a token id from a Crucible VerificationReceipt. The chain answers; no
        Crucible API is consulted.
      </p>
      <form onSubmit={(e) => e.preventDefault()}>
        <label className="field" htmlFor="token-id">
          <span>Token id</span>
          <input
            id="token-id"
            type="text"
            inputMode="numeric"
            aria-label="Token id (numbers only)"
            aria-describedby="token-id-hint"
            aria-invalid={invalid}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="1"
          />
          <p id="token-id-hint" className="hint hint--block">
            Numbers only — a token id is the whole number minted on the receipt.
          </p>
          {invalid && (
            <p role="alert" className="hint hint--block" data-tone="sear">
              That token id is not numeric. Enter a whole number.
            </p>
          )}
        </label>
      </form>
      {view.kind === "found" ? (
        <div aria-live="polite" className="surface detail-panel">
          <p className="kv">
            <span className="kv__key">Owner</span>
            <span className="mono">{view.owner}</span>
          </p>
          <p className="kv">
            <span className="kv__key">Metadata URI</span>
            <span className="mono">{view.uri ?? "no metadata published"}</span>
          </p>
        </div>
      ) : view.kind === "idle" ? null : (
        <div aria-live="polite" className="surface detail-panel">
          <p className="kv">
            <span className="kv__key">Chain</span>
            <span className="mono">{view.kind}</span>
          </p>
          <p className="hint hint--block">{view.detail}</p>
        </div>
      )}
    </Chrome>
  );
}

function verificationReceiptAddress(): `0x${string}` {
  // Read from NEXT_PUBLIC env at build time; the address is baked into the bundle.
  const addr = process.env.NEXT_PUBLIC_VERIFICATION_RECEIPT_ADDRESS;
  if (!addr) return "0x0000000000000000000000000000000000000000";
  return addr as `0x${string}`;
}
