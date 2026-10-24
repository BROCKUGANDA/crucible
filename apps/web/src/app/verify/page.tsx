"use client";

import { useState } from "react";
import { Chrome } from "@/components/Chrome";
import { useReadContract } from "wagmi";
import { VERIFICATION_RECEIPT_ABI } from "@/lib/verificationReceipt";

/**
 * Public-verify page (gate 417): paste a tokenId → verdictHash + promptHash shown.
 * Reads straight from the VerificationReceipt contract; no API, no trust in Crucible's backend.
 */
export default function VerifyPage() {
  const [input, setInput] = useState("");
  const tokenId = /^\d+$/.test(input.trim()) ? BigInt(input.trim()) : undefined;

  const { data: owner } = useReadContract({
    address: verificationReceiptAddress(),
    abi: VERIFICATION_RECEIPT_ABI,
    functionName: "ownerOf",
    args: tokenId ? [tokenId] : undefined,
    query: { enabled: tokenId !== undefined },
  });

  const { data: uri } = useReadContract({
    address: verificationReceiptAddress(),
    abi: VERIFICATION_RECEIPT_ABI,
    functionName: "tokenURI",
    args: tokenId ? [tokenId] : undefined,
    query: { enabled: tokenId !== undefined },
  });

  return (
    <Chrome>
      <p className="kicker">Verify a receipt</p>
      <h1 className="page-title">Verification Receipt</h1>
      <p className="hint hint--block">
        Paste a token id from a Crucible VerificationReceipt. The chain answers; no
        Crucible API is consulted.
      </p>
      <label className="field">
        <span>Token id</span>
        <input
          type="text"
          inputMode="numeric"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="1"
        />
      </label>
      {tokenId !== undefined ? (
        <div className="surface detail-panel">
          <p className="kv">
            <span className="kv__key">Owner</span>
            <span className="mono">{owner ? String(owner) : "—"}</span>
          </p>
          <p className="kv">
            <span className="kv__key">Metadata URI</span>
            <span className="mono">{uri ? String(uri) : "—"}</span>
          </p>
        </div>
      ) : null}
    </Chrome>
  );
}

function verificationReceiptAddress(): `0x${string}` {
  // Read from NEXT_PUBLIC env at build time; the address is baked into the bundle.
  const addr = process.env.NEXT_PUBLIC_VERIFICATION_RECEIPT_ADDRESS;
  if (!addr) return "0x0000000000000000000000000000000000000000";
  return addr as `0x${string}`;
}