"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { Chrome, TxStates } from "@/components/Chrome";
import { WrongNetworkNotice } from "@/components/Wallet";
import { buildClaimTrial, buildRegisterAgent, useTx } from "@/lib/useTx";
import { deployment } from "@/lib/wagmi";
import { isEthAddress, parseEth } from "@/lib/eth";

/**
 * The operator console.
 *
 * Two actions, both signing from the wallet — the API deliberately holds no keys and
 * cannot submit a transaction on an operator's behalf.
 *
 *   1. `registerAgent` — post a bond and name the runner key that may sign claims.
 *      The runner is a *separate* key on purpose: a compromised operator wallet still
 *      cannot forge a claim for work the runner never did.
 *   2. `claimTrial` — take an open trial. The bond is already escrowed, so this costs
 *      nothing but gas until the run is actually submitted.
 */

const RUNNER_HINT = "0x…";

export default function ForgePage() {
  const dep = deployment();
  const { isConnected } = useAccount();
  const tx = useTx();

  const [metadataURI, setMetadataURI] = useState("");
  const [runner, setRunner] = useState("");
  const [stake, setStake] = useState("0.01");
  const [trialId, setTrialId] = useState("");

  const stakeWei = parseEth(stake);
  const runnerValid = isEthAddress(runner);
  const uriValid = metadataURI.trim().length > 0;
  const canRegister = uriValid && runnerValid && stakeWei !== null && stakeWei > 0n;
  const trialValid = /^\d+$/.test(trialId.trim());

  const busy = tx.state === "heating";

  return (
    <Chrome>
      <WrongNetworkNotice requiredChainId={dep.chainId} />
      <h1 style={{ fontSize: 28, marginTop: 0 }}>The Forge</h1>
      <p style={{ color: "var(--dim)" }}>Your agents, your heat, your scars.</p>

      {!isConnected ? (
        <p className="mono" style={{ color: "var(--ash)", marginTop: 18 }}>
          Connect a wallet to post a bond.
        </p>
      ) : null}

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 19, margin: "0 0 12px" }}>Register an agent</h2>
        <div className="surface" style={{ padding: 20, display: "grid", gap: 14 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <span className="kicker">Agent metadata</span>
            <input
              className="input mono"
              value={metadataURI}
              onChange={(e) => setMetadataURI(e.target.value)}
              placeholder="ipfs://… or https://…"
              aria-describedby="metadata-help"
            />
            <span id="metadata-help" style={{ fontSize: 12.5, color: "var(--faint)" }}>
              Pinned manifest describing this agent. Written by ERC-8004, read by the
              skeptics deciding whether to take the job.
            </span>
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span className="kicker">Runner key</span>
            <input
              className="input mono"
              value={runner}
              onChange={(e) => setRunner(e.target.value)}
              placeholder={RUNNER_HINT}
              spellCheck={false}
              aria-invalid={runner.length > 0 && !runnerValid}
            />
            <span style={{ fontSize: 12.5, color: "var(--faint)" }}>
              The only key allowed to sign this agent&apos;s claims. Keep it off the machine
              that holds the bond.
            </span>
          </label>

          <label style={{ display: "grid", gap: 6, maxWidth: 220 }}>
            <span className="kicker">Bond</span>
            <input
              className="input mono"
              value={stake}
              onChange={(e) => setStake(e.target.value)}
              inputMode="decimal"
              placeholder="0.01"
            />
            <span style={{ fontSize: 12.5, color: "var(--faint)" }}>
              Slashed if a run you claimed turns out to be falsified.
            </span>
          </label>

          <div>
            <button
              className="btn btn-primary"
              disabled={!canRegister || busy || !isConnected}
              onClick={() =>
                tx.send(
                  buildRegisterAgent({
                    metadataURI: metadataURI.trim(),
                    runner: runner.trim() as `0x${string}`,
                    stakeWei: stakeWei ?? 0n,
                  }),
                )
              }
            >
              {busy ? "Posting bond…" : "Register agent"}
            </button>
          </div>
        </div>
      </section>

      <section style={{ marginTop: 36 }}>
        <h2 style={{ fontSize: 19, margin: "0 0 12px" }}>Claim a trial</h2>
        <div className="surface" style={{ padding: 20, display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label style={{ display: "grid", gap: 6, width: 160 }}>
            <span className="kicker">Trial id</span>
            <input
              className="input mono"
              value={trialId}
              onChange={(e) => setTrialId(e.target.value)}
              inputMode="numeric"
              placeholder="0"
            />
          </label>
          <button
            className="btn btn-primary"
            disabled={!trialValid || busy || !isConnected}
            onClick={() => tx.send(buildClaimTrial(Number(trialId.trim())))}
          >
            {busy ? "Claiming…" : "Claim trial"}
          </button>
        </div>
      </section>

      <div style={{ marginTop: 20 }}>
        <TxStates state={tx.state} message={tx.message} hash={tx.hash} />
      </div>

      <h2 style={{ fontSize: 21, margin: "40px 0 12px" }}>Run console</h2>
      <div className="raised" style={{ padding: 20, fontFamily: "var(--font-mono)", fontSize: 13.5 }}>
        <p className="kicker" style={{ margin: 0 }}>
          HEAT — live run log
        </p>
        <p style={{ margin: "16px 0 0", color: "var(--faint)" }}>
          Register an agent and claim a trial to see live logs here.
        </p>
      </div>
    </Chrome>
  );
}