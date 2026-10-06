"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { keccak256, stringToHex, type Hex } from "viem";
import { buildFileBreak, useTx } from "@/lib/useTx";
import { formatWei, parseEth } from "@/lib/eth";
import { WrongNetworkNotice } from "@/components/Wallet";
import { deployment } from "@/lib/wagmi";

/**
 * File a break.
 *
 * This is the action the whole product rests on: a skeptic puts up their own stake on
 * the claim being falsifiable, and hands over a proof artifact that Argus re-runs in an
 * identical container. If the proof holds, 30% of the agent's bond is theirs; if it
 * does not, half their stake goes to the agent. Nobody gets paid for an opinion.
 *
 * Three things are deliberately in front of the skeptic before they click:
 *
 *   1. the exact stake, in ETH and in wei
 *   2. the minimum the contract will accept — filing below it reverts
 *   3. what happens if they are wrong
 *
 * A wrong revert here costs a skeptic the whole filing fee and teaches them the tool is
 * hostile. That is the opposite of what this screen is for.
 */
export function BreakPanel({
  trialId,
  rewardEth,
  bondEth,
}: {
  trialId: number;
  /** ETH-denominated, as the indexer reports it */
  rewardEth: string;
  /** ETH-denimited bond, for showing what is at stake */
  bondEth: string;
}) {
  const dep = deployment();
  const { isConnected } = useAccount();
  const tx = useTx();

  const rewardWei = parseEth(rewardEth) ?? 0n;
  // The contract's floor is 1% of the reward; filing under it reverts with Nothing().
  const minStakeWei = rewardWei / 100n;
  const bondWei = parseEth(bondEth) ?? 0n;
  const payoutWei = (bondWei * 30n) / 100n;

  const [stakeText, setStakeText] = useState(() => (minStakeWei > 0n ? formatWei(minStakeWei, 18) : ""));
  const [proof, setProof] = useState("");

  const stakeWei = parseEth(stakeText);
  const proofOk = proof.trim().length > 0;
  const stakeOk = stakeWei !== null && stakeWei >= minStakeWei;

  const busy = tx.state === "heating";
  const canSend = proofOk && stakeOk && !busy && isConnected && dep.configured;

  return (
    <section style={{ marginTop: 28 }}>
      <WrongNetworkNotice requiredChainId={dep.chainId} />
      <h2 style={{ fontSize: 19, margin: "0 0 4px" }}>Break this run</h2>
      <p style={{ color: "var(--dim)", margin: "0 0 16px" }}>
        Stake your own claim that the run is falsified. Argus re-runs the pinned suite in
        an identical container; deterministic evidence beats opinion.
      </p>

      <div className="surface" style={{ padding: 20, display: "grid", gap: 16 }}>
        {/* What is at stake, before anything is typed. */}
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: "8px 18px",
            margin: 0,
            fontSize: 13.5,
          }}
        >
          <dt className="kicker">You receive</dt>
          <dd className="mono" style={{ margin: 0, color: "var(--quench)" }}>
            {formatWei(payoutWei, 18)} ETH — 30% of the {bondEth} ETH bond
          </dd>

          <dt className="kicker">Minimum stake</dt>
          <dd className="mono" style={{ margin: 0, color: stakeOk ? "var(--dim)" : "var(--sear)" }}>
            {formatWei(minStakeWei, 18)} ETH — 1% of the reward
          </dd>

          <dt className="kicker">If you are wrong</dt>
          <dd className="mono" style={{ margin: 0, color: "var(--sear)" }}>
            Half your stake goes to the agent. The other half is burned.
          </dd>
        </dl>

        <label style={{ display: "grid", gap: 6 }}>
          <span className="kicker">Your stake (ETH)</span>
          <input
            className="input mono"
            value={stakeText}
            onChange={(e) => setStakeText(e.target.value)}
            inputMode="decimal"
            aria-invalid={stakeText.length > 0 && !stakeOk}
          />
          {stakeWei !== null ? (
            <span className="mono" style={{ fontSize: 12.5, color: "var(--faint)" }}>
              {stakeWei.toString()} wei
            </span>
          ) : null}
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span className="kicker">Proof</span>
          <textarea
            className="input"
            value={proof}
            onChange={(e) => setProof(e.target.value)}
            rows={4}
            placeholder={
              "What falsifies this run. Pinned test names, the failing assertion, the input that breaks it."
            }
          />
          <span style={{ fontSize: 12.5, color: "var(--faint)" }}>
            Hashed on submission. Pin the artifact to IPFS and cite it here — the contract
            commits to the hash, so the proof cannot be quietly edited afterwards.
          </span>
        </label>

        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <button
            className="btn btn-primary"
            disabled={!canSend}
            onClick={() =>
              tx.send(buildFileBreak(trialId, digestOf(proof), stakeWei ?? 0n))
            }
          >
            {busy ? "Filing the break…" : `File the break on trial ${trialId}`}
          </button>

          {!isConnected ? (
            <span className="mono" style={{ color: "var(--ash)" }}>
              Connect a wallet to stake
            </span>
          ) : null}
          {stakeText.length > 0 && !stakeOk ? (
            <span className="mono" style={{ color: "var(--sear)" }}>
              {stakeWei === null
                ? "That is not an ETH amount"
                : `Below the ${formatWei(minStakeWei, 18)} ETH minimum`}
            </span>
          ) : null}
          {stakeOk && !proofOk ? (
            <span className="mono" style={{ color: "var(--ash)" }}>
              A break needs a proof
            </span>
          ) : null}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <TxStatus state={tx.state} message={tx.message} hash={tx.hash} />
      </div>
    </section>
  );
}

/**
 * The contract stores `bytes32`, so the proof text is hashed rather than stored.
 * `proofDigest` is what makes the filing irreversible: a skeptic who later edits their
 * proof has changed the hash, and the contract will not recognise it.
 */
function digestOf(proof: string): Hex {
  return keccak256(stringToHex(proof.trim()));
}

/** Local copy of the transaction banner, so this component stands alone. */
function TxStatus({
  state,
  message,
  hash,
}: {
  state: "idle" | "heating" | "poured" | "doused";
  message: string | null;
  hash?: string | null;
}) {
  if (state === "idle") return null;

  if (state === "heating") {
    return (
      <p role="status" aria-live="polite" className="mono" style={{ color: "var(--gold)" }}>
        Heating — waiting for the network…
      </p>
    );
  }

  if (state === "poured") {
    return (
      <p role="status" className="mono" style={{ color: "var(--quench)" }}>
        Filed. The claim is now contestable.
        {hash ? ` ${hash.slice(0, 10)}…${hash.slice(-6)}` : null}
      </p>
    );
  }

  return (
    <p role="alert" style={{ color: "var(--sear)" }}>
      Doused. <span style={{ color: "var(--dim)" }}>{message}</span>
    </p>
  );
}