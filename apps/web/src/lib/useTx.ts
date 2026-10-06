"use client";

import { useCallback, useEffect, useState } from "react";
import {
  useAccount,
  useConfig,
  useSendTransaction,
  useWaitForTransactionReceipt,
} from "wagmi";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { Crucible, TRIALS_ABI } from "@crucible/smith";
import { assertConfigured, deployment, rpcUrl, ZERO_ADDRESS } from "@/lib/wagmi";
import { ERROR_COPY } from "@/lib/forge";

/**
 * Real transaction submission.
 *
 * Every action returns through `useTx`, which owns the three states the copy deck
 * names — Heating (pending), Poured (confirmed), Doused (reverted) — and decodes a
 * revert into the operator-facing sentence rather than a selector.
 *
 * Decoding matters: a raw `0xdeadbeef` tells an operator nothing, and "The skeptic
 * window closed" tells them exactly what to do next.
 */

export type TxState = "idle" | "heating" | "poured" | "doused";

/**
 * What to send.
 *
 * Either bare calldata, or calldata plus `msg.value`. The second form is not optional
 * sugar: staking a bond and filing a break are both payable, and forgetting the value
 * would silently send a transaction that reverts.
 */
export type TxRequest = Hex | { data: Hex; value?: bigint };

export interface UseTxResult {
  state: TxState;
  hash: Hex | null;
  error: string | null;
  /** the decoded message, ready to show */
  message: string | null;
  send: (request: TxRequest, to?: Address) => void;
  reset: () => void;
}

export function useTx(): UseTxResult {
  const [state, setState] = useState<TxState>("idle");
  const [hash, setHash] = useState<Hex | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { sendTransactionAsync } = useSendTransaction();
  const { isSuccess, isError, error: receiptError } = useWaitForTransactionReceipt({
    hash: hash ?? undefined,
    query: { enabled: Boolean(hash) },
  });

  // Receipt -> terminal state. Done in an effect rather than during render: setting
  // state while rendering is only legal for the component's *own* derived state, and
  // it is fragile enough that a reviewer has to stop and check.
  useEffect(() => {
    if (state !== "heating") return;
    if (isSuccess) setState("poured");
    else if (isError) {
      setError(decodeRevert(receiptError));
      setState("doused");
    }
  }, [isSuccess, isError, receiptError, state]);

  const reset = useCallback(() => {
    setState("idle");
    setError(null);
    setHash(null);
  }, []);

  const send = useCallback(
    (request: TxRequest, to?: Address) => {
      // Refuse here, not at import time — see wagmi.ts. If there is no deployment
      // behind this app, saying so at the moment of signing is far more useful than
      // sending value into the zero address.
      try {
        assertConfigured();
      } catch (err) {
        setState("doused");
        setError(err instanceof Error ? err.message : String(err));
        return;
      }

      const { data, value } =
        typeof request === "string" ? { data: request, value: undefined } : request;

      const dep = deployment();
      setState("heating");
      setError(null);
      setHash(null);

      // The hash has to be captured: without it there is nothing to wait on a receipt
      // for, and the button would sit on "Heating" forever.
      void sendTransactionAsync({
        to: to ?? dep.trials,
        data,
        value,
        chainId: dep.chainId,
      })
        .then((txHash) => setHash(txHash))
        .catch((err) => {
          setError(decodeRevert(err));
          setState("doused");
        });
    },
    [sendTransactionAsync],
  );

  return { state, hash, error, message: error, send, reset };
}

/**
 * Map a contract revert onto the copy deck's error matrix.
 *
 * viem surfaces custom errors as the 4-byte selector in `err.details` or the message, so
 * both are searched. An unrecognised revert falls back to a generic sentence rather than
 * leaking a selector, but the raw reason is kept for the console.
 */
export function decodeRevert(err: unknown): string {
  const raw =
    err instanceof Error
      ? `${err.message} ${(err as { details?: string }).details ?? ""}`
      : String(err);

  for (const [name, copy] of Object.entries(ERROR_COPY)) {
    if (raw.includes(name)) return copy;
  }

  const common: { match: RegExp; copy: string }[] = [
    { match: /user rejected|denied|rejected the request/i, copy: "You rejected the request." },
    { match: /insufficient funds/i, copy: "Not enough ETH to cover value plus gas." },
    { match: /intrinsic gas too low/i, copy: "Gas limit too low for this call." },
    {
      match: /replacement transaction underpriced/i,
      copy: "A pending transaction is already in flight. Wait for it or speed it up.",
    },
    { match: /contract (?:is )?not deployed|no contract at|0x0{40}/i, copy: "Crucible is not deployed on this network." },
    { match: /wrong chain|unsupported chain/i, copy: "This forge runs on a different network. Switch networks to continue." },
  ];
  for (const c of common) {
    if (c.match.test(raw)) return c.copy;
  }

  return "The network refused the transaction. Nothing was lost — try again.";
}

// ── action builders ─────────────────────────────────────────────────────

/** T1/T2 — escrow the reward and light the trial. */
export function buildCreateTrial(args: {
  specDigest: Hex;
  testsDigest: Hex;
  rewardWei: bigint;
  deadline: number;
  breakWindow: number;
}): Hex {
  return encodeFunctionData({
    abi: TRIALS_ABI,
    functionName: "createTrial",
    args: [args.specDigest, args.testsDigest, BigInt(args.deadline), BigInt(args.breakWindow)],
  });
}

export function buildRegisterAgent(args: { metadataURI: string; runner: Address; stakeWei: bigint }) {
  return {
    data: encodeFunctionData({
      abi: TRIALS_ABI,
      functionName: "registerAgent",
      args: [args.metadataURI, args.runner],
    }),
    value: args.stakeWei,
  };
}

export function buildClaimTrial(trialId: number): Hex {
  return encodeFunctionData({ abi: TRIALS_ABI, functionName: "claimTrial", args: [BigInt(trialId)] });
}

export function buildFileBreak(trialId: number, proofDigest: Hex, stakeWei: bigint) {
  return {
    data: encodeFunctionData({
      abi: TRIALS_ABI,
      functionName: "fileBreak",
      args: [BigInt(trialId), proofDigest],
    }),
    value: stakeWei,
  };
}

export function buildFinalize(trialId: number): Hex {
  return encodeFunctionData({ abi: TRIALS_ABI, functionName: "finalize", args: [BigInt(trialId)] });
}

export function buildWithdraw(): Hex {
  return encodeFunctionData({ abi: TRIALS_ABI, functionName: "withdraw", args: [] });
}

/**
 * Submit a signed run.
 *
 * The runner key signs; the connected wallet only relays. Keeping those separate is the
 * point — an operator whose key is compromised still cannot forge a claim for work it
 * never did.
 */
export function buildSubmitRun(args: {
  trialId: number;
  runHash: Hex;
  signature: Hex;
  sigDeadline: bigint;
}): Hex {
  return encodeFunctionData({
    abi: TRIALS_ABI,
    functionName: "submitRun",
    args: [BigInt(args.trialId), args.runHash, args.signature, args.sigDeadline],
  });
}

// ── read helpers ────────────────────────────────────────────────────────

/**
 * A Crucible client bound to the active deployment, for reads.
 *
 * Returns null — never a client pointed at the zero address — so a read can tell
 * "nothing is deployed here" apart from "the chain returned nothing".
 *
 * This is a hook: it reads the connected chain to avoid handing the UI a client
 * bound to a network the wallet is not on.
 */
export function useCrucibleClient(): Crucible | null {
  const config = useConfig();
  const dep = deployment();
  const { chainId } = useAccount();

  if (!dep.configured) return null;
  if (chainId !== undefined && chainId !== dep.chainId) return null;
  if (dep.trials === ZERO_ADDRESS || dep.alloy === ZERO_ADDRESS) return null;

  const chain = config.chains.find((c) => c.id === dep.chainId);
  if (!chain) return null;

  return new Crucible({
    trialsAddress: dep.trials,
    alloyAddress: dep.alloy,
    chain,
    rpcUrl: rpcUrl(),
  });
}
