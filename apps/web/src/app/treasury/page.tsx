"use client";

import { useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import type { Address } from "viem";
import { TRIALS_ABI } from "@crucible/smith";
import { Chrome } from "@/components/Chrome";
import { deployment } from "@/lib/wagmi";
import { formatWei } from "@/lib/eth";
import { buildWithdraw } from "@/lib/useTx";
import { treasuryConnectionState } from "@/lib/treasury-view";
import { WrongNetworkNotice } from "@/components/Wallet";

export default function TreasuryPage() {
  const dep = deployment();
  const { address, chainId } = useAccount();
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  const treasuryRead = useReadContract({
    abi: TRIALS_ABI,
    address: dep.trials,
    functionName: "treasury",
    query: { enabled: dep.configured },
  });

  const treasury = treasuryRead.data as Address | undefined;
  const gate = treasuryConnectionState({
    configured: dep.configured,
    connectedAddress: address,
    treasuryAddress: treasury,
    treasuryLoading: treasuryRead.isPending,
    treasuryError: Boolean(treasuryRead.error),
  });

  // The on-chain credit is queried only after the exact Treasury Safe is connected.
  // This is a UI disclosure rule, not on-chain privacy: the mapping is publicly readable.
  const creditRead = useReadContract({
    abi: TRIALS_ABI,
    address: dep.trials,
    functionName: "credit",
    args: treasury ? ([treasury] as const) : undefined,
    query: {
      enabled: gate === "treasury",
      refetchInterval: 15_000,
    },
  });

  const correctChain = chainId === undefined || chainId === dep.chainId;
  const credit = creditRead.data as bigint | undefined;
  const canPrepare = gate === "treasury" && correctChain && credit !== undefined && credit > 0n;

  const copy = async (label: string, value: string) => {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setCopied(null);
      setCopyError("Clipboard access was unavailable. Copy the value manually from the code field.");
    }
  };

  return (
    <Chrome>
      <p className="kicker">Company-controlled custody</p>
      <h1 className="page-title">Treasury Safe</h1>
      <p className="hint hint--block">
        Protocol commission accrues to the Treasury Safe configured in the deployed contract.
        It does not go to whichever personal wallet is connected, and this page cannot redirect it.
      </p>

      {!dep.configured ? (
        <section className="surface detail-panel" role="status">
          <h2>Contract not configured</h2>
          <p className="hint hint--block">
            This environment has no configured CrucibleTrials deployment. No treasury amount is
            inferred or shown.
          </p>
        </section>
      ) : gate === "loading-address" ? (
        <section className="surface detail-panel" role="status">
          <h2>Reading treasury configuration</h2>
          <p className="hint hint--block">The configured Treasury Safe is being read from the contract.</p>
        </section>
      ) : gate === "unavailable-address" ? (
        <section className="surface detail-panel" role="alert" data-tone="sear">
          <h2>Could not verify the Treasury Safe</h2>
          <p className="hint hint--block">
            The on-chain treasury read failed. Do not infer a zero balance or attempt a withdrawal.
            Check the RPC and retry.
          </p>
        </section>
      ) : gate === "disconnected" ? (
        <section className="surface detail-panel">
          <h2>Connect the company Treasury Safe</h2>
          <p className="hint hint--block">
            Connect the Safe contract address itself through a compatible wallet context. A personal
            Safe-owner EOA is not the treasury recipient and cannot withdraw its credit.
          </p>
        </section>
      ) : gate === "wrong-wallet" ? (
        <section className="surface detail-panel" role="alert">
          <h2>Wrong wallet for treasury operations</h2>
          <p className="hint hint--block">
            The connected account is not the Treasury Safe returned by the contract. The treasury
            credit is hidden here and no withdrawal action is offered.
          </p>
        </section>
      ) : gate === "treasury" ? (
        <>
          {!correctChain ? <WrongNetworkNotice requiredChainId={dep.chainId} /> : null}
          <section className="surface detail-panel" aria-live="polite">
            <h2>Verified Treasury Safe connection</h2>
            <p className="kv">
              <span className="kv__key">Treasury Safe</span>
              <span className="mono">{treasury}</span>
            </p>
            <p className="kv">
              <span className="kv__key">Escrow contract</span>
              <span className="mono">{dep.trials}</span>
            </p>

            {creditRead.isPending ? (
              <p className="hint hint--block" role="status">Reading accrued credit…</p>
            ) : creditRead.error || credit === undefined ? (
              <p className="hint hint--block" data-tone="sear" role="alert">
                Could not verify the Safe's credit from the chain. The amount is unknown, not zero.
              </p>
            ) : (
              <>
                <p className="kv">
                  <span className="kv__key">Accrued, withdrawable credit</span>
                  <strong className="mono">{formatWei(credit, 18)} ETH</strong>
                </p>
                {credit === 0n ? (
                  <p className="hint hint--block">
                    No protocol credit is currently withdrawable. Credit accrues only after
                    contract settlement; sponsor deposits are not commission payments.
                  </p>
                ) : canPrepare ? (
                  <div className="stack">
                    <p className="hint hint--block">
                      This contract pays `credit[msg.sender]` to `msg.sender`. Execute the
                      call from this exact Safe in the Safe transaction interface. The contract
                      has no arbitrary recipient field.
                    </p>
                    <div className="row">
                      <button
                        className="btn btn-primary"
                        type="button"
                        onClick={() => void copy("escrow", dep.trials)}
                      >
                        {copied === "escrow" ? "Contract copied" : "Copy escrow address"}
                      </button>
                      <button
                        className="btn btn-ghost"
                        type="button"
                        onClick={() => void copy("calldata", buildWithdraw())}
                      >
                        {copied === "calldata" ? "Calldata copied" : "Copy withdraw() calldata"}
                      </button>
                    </div>
                    <p className="hint hint--block">
                      In the Safe UI, create a contract interaction to the escrow address above,
                      paste the calldata, review the target and chain, then collect the approvals
                      required by your Safe threshold before execution.
                    </p>
                  </div>
                ) : (
                  <p className="hint hint--block">
                    Switch the connected Safe to Crucible's configured chain before preparing the
                    withdrawal details.
                  </p>
                )}
              </>
            )}
          </section>
        </>
      ) : null}

      {copyError ? (
        <p className="hint hint--block" data-tone="sear" role="alert">{copyError}</p>
      ) : null}

      <p className="hint hint--block">
        Privacy note: the interface shows the credit only when the exact Treasury Safe is connected,
        but the contract address, credit mapping and transactions are public on the EVM chain.
        This UI gate is not transaction privacy. Never enter or paste a seed phrase or private key.
      </p>
    </Chrome>
  );
}
