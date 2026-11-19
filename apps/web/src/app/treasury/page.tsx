"use client";

import { useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import type { Address } from "viem";
import { TRIALS_ABI } from "@crucible/smith";
import { Chrome } from "@/components/Chrome";
import { useDeployment } from "@/lib/wagmi";
import { formatWei } from "@/lib/eth";
import { buildWithdraw } from "@/lib/useTx";
import { treasuryConnectionState } from "@/lib/treasury-view";
import { WrongNetworkNotice } from "@/components/Wallet";
import {
  prepareSafeWithdrawalDraft,
  SafeDraftError,
  verifySafeOwner,
  type SafeEip1193Provider,
  type SafeOwnerVerification,
  type SafeWithdrawalDraft,
} from "@/lib/safe-withdrawal";

export default function TreasuryPage() {
  const dep = useDeployment();
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
        <>
          <section className="surface detail-panel" role="status">
            <h2>Connected account is not the Treasury Safe</h2>
            <p className="hint hint--block">
              This account cannot withdraw the credit directly. No direct withdrawal is offered. If
              it is an owner of the Treasury Safe returned by the contract, you can verify ownership
              and prepare an unsigned Safe transaction draft below.
            </p>
          </section>
          {chainId !== undefined && !correctChain ? <WrongNetworkNotice requiredChainId={dep.chainId} /> : null}
          {address && treasury ? (
            <SafeOwnerDraftPanel
              connectedAddress={address}
              connectedChainId={chainId}
              expectedChainId={dep.chainId}
              treasuryAddress={treasury}
              escrowAddress={dep.trials}
            />
          ) : null}
        </>
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

function SafeOwnerDraftPanel({
  connectedAddress,
  connectedChainId,
  expectedChainId,
  treasuryAddress,
  escrowAddress,
}: {
  connectedAddress: Address;
  connectedChainId: number | undefined;
  expectedChainId: number;
  treasuryAddress: Address;
  escrowAddress: Address;
}) {
  const { connector } = useAccount();
  const [ownerProof, setOwnerProof] = useState<{ key: string; value: SafeOwnerVerification } | null>(null);
  const [draftState, setDraftState] = useState<{ key: string; value: SafeWithdrawalDraft } | null>(null);
  const [working, setWorking] = useState<"verify" | "draft" | null>(null);
  const [failureState, setFailureState] = useState<{ key: string; message: string } | null>(null);
  const ownerKey = [
    connectedAddress.toLowerCase(),
    connectedChainId ?? "unknown",
    expectedChainId,
    treasuryAddress.toLowerCase(),
    escrowAddress.toLowerCase(),
  ].join(":");

  const verified = ownerProof?.key === ownerKey ? ownerProof.value : null;
  const draft = draftState?.key === ownerKey ? draftState.value : null;
  const failure = failureState?.key === ownerKey ? failureState.message : null;
  const creditRead = useReadContract({
    abi: TRIALS_ABI,
    address: escrowAddress,
    functionName: "credit",
    args: [treasuryAddress],
    query: {
      enabled: expectedChainId !== 1 && Boolean(verified && connectedChainId === expectedChainId),
      refetchInterval: 15_000,
    },
  });
  const credit = creditRead.data as bigint | undefined;
  const mainnetDisabled = expectedChainId === 1;

  const getProvider = async (): Promise<SafeEip1193Provider> => {
    if (!connector) throw new SafeDraftError("Connect an EVM owner wallet to continue.");
    const provider = await connector.getProvider();
    if (!provider || typeof provider !== "object" || typeof (provider as { request?: unknown }).request !== "function") {
      throw new SafeDraftError("The connected wallet did not expose an EVM provider.");
    }
    return provider as SafeEip1193Provider;
  };

  const messageFor = (error: unknown) =>
    error instanceof SafeDraftError
      ? error.message
      : "Could not verify or prepare the Safe draft through this wallet. No signature or transaction was sent.";

  const verifyOwner = async () => {
    const requestedKey = ownerKey;
    setWorking("verify");
    setFailureState(null);
    try {
      const value = await verifySafeOwner({
        provider: await getProvider(),
        connectedAddress,
        connectedChainId,
        expectedChainId,
        treasuryAddress,
        escrowAddress,
      });
      setOwnerProof({ key: requestedKey, value });
      setDraftState(null);
    } catch (error) {
      setFailureState({ key: requestedKey, message: messageFor(error) });
    } finally {
      setWorking(null);
    }
  };

  const buildDraft = async () => {
    const requestedKey = ownerKey;
    setWorking("draft");
    setFailureState(null);
    try {
      const value = await prepareSafeWithdrawalDraft({
        provider: await getProvider(),
        connectedAddress,
        connectedChainId,
        expectedChainId,
        treasuryAddress,
        escrowAddress,
        creditWei: credit,
      });
      setDraftState({ key: requestedKey, value });
    } catch (error) {
      setFailureState({ key: requestedKey, message: messageFor(error) });
    } finally {
      setWorking(null);
    }
  };

  if (mainnetDisabled) {
    return (
      <section className="surface detail-panel" role="status">
        <h2>Mainnet Safe drafts are disabled</h2>
        <p className="hint hint--block">
          Crucible&apos;s mainnet release gates remain incomplete. This page will not prepare a
          mainnet withdrawal draft until the ADR-0020 evidence is approved and verified.
        </p>
      </section>
    );
  }

  return (
    <section className="surface detail-panel" aria-live="polite">
      <h2>Safe owner tools</h2>
      <p className="hint hint--block">
        Verify this account against the deployed Safe&apos;s on-chain owner list. A personal account
        cannot withdraw treasury credit; only the Safe can call the escrow, subject to its owner
        threshold.
      </p>
      {!verified ? (
        <button
          className="btn btn-primary"
          type="button"
          disabled={working !== null || connectedChainId !== expectedChainId}
          onClick={() => void verifyOwner()}
        >
          {working === "verify" ? "Verifying Safe owner…" : "Verify Safe ownership"}
        </button>
      ) : (
        <>
          <p className="kv">
            <span className="kv__key">On-chain owner check</span>
            <strong>Verified · {verified.threshold} of {verified.ownerCount} approvals required</strong>
          </p>
          <p className="kv">
            <span className="kv__key">Treasury Safe</span>
            <span className="mono">{verified.safeAddress}</span>
          </p>
          <p className="kv">
            <span className="kv__key">Connected owner EOA</span>
            <span className="mono">{verified.ownerAddress}</span>
          </p>
          <p className="kv">
            <span className="kv__key">Configured chain id</span>
            <span className="mono">{verified.chainId}</span>
          </p>
          {creditRead.isPending ? (
            <p className="hint hint--block" role="status">Reading the Safe&apos;s current credit…</p>
          ) : creditRead.error || credit === undefined ? (
            <p className="hint hint--block" data-tone="sear" role="alert">
              The Safe&apos;s credit is unknown, not zero. No draft can be prepared until the chain read succeeds.
            </p>
          ) : credit === 0n ? (
            <p className="hint hint--block">The verified Safe currently has no withdrawable credit.</p>
          ) : (
            <>
              <p className="kv">
                <span className="kv__key">Current on-chain credit</span>
                <strong className="mono">{formatWei(credit, 18)} ETH</strong>
              </p>
              <button
                className="btn btn-primary"
                type="button"
                disabled={working !== null}
                onClick={() => void buildDraft()}
              >
                {working === "draft" ? "Building unsigned draft…" : "Prepare unsigned Safe draft"}
              </button>
            </>
          )}
        </>
      )}

      {draft ? (
        <div className="stack" data-testid="safe-withdrawal-draft">
          <h3>Unsigned Safe transaction draft</h3>
          <p className="kv"><span className="kv__key">Safe transaction hash</span><span className="mono">{draft.safeTxHash}</span></p>
          <p className="kv"><span className="kv__key">Safe nonce</span><span className="mono">{draft.nonce}</span></p>
          <p className="kv"><span className="kv__key">Chain id</span><span className="mono">{draft.chainId}</span></p>
          <p className="kv"><span className="kv__key">Target escrow</span><span className="mono">{draft.targetAddress}</span></p>
          <p className="kv"><span className="kv__key">Call value</span><span className="mono">{draft.value} ETH</span></p>
          <p className="kv"><span className="kv__key">Calldata</span><span className="mono">{draft.data}</span></p>
          <p className="hint hint--block">
            The displayed credit is a point-in-time read, not an amount encoded in this call.
            <code>withdraw()</code> asks the escrow to pay the Safe&apos;s current credit to the Safe
            when executed. This draft is unsigned and local: Crucible does not collect signatures,
            submit it to a Safe Transaction Service, broadcast it, or execute it. Verify the Safe,
            target, chain and current credit in the Safe interface before any separate approval.
          </p>
        </div>
      ) : null}

      {failure ? <p className="hint hint--block" data-tone="sear" role="alert">{failure}</p> : null}
    </section>
  );
}
