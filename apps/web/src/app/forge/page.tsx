"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { Chrome, TxStates } from "@/components/Chrome";
import { PourConfirm } from "@/components/Modal";
import { WrongNetworkNotice } from "@/components/Wallet";
import { buildClaimTrial, buildRegisterAgent, useTx } from "@/lib/useTx";
import { deployment } from "@/lib/wagmi";
import { parseEth } from "@/lib/eth";
import { checkAddressTarget, guardPastedText } from "@/lib/safety";

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
  const { isConnected, chainId: accountChainId } = useAccount();
  const tx = useTx();

  const [metadataURI, setMetadataURI] = useState("");
  const [runner, setRunner] = useState("");
  const [stake, setStake] = useState("0.01");
  const [trialId, setTrialId] = useState("");
  // Which pour is being confirmed. `null` means the dialog is not part of the flow.
  const [confirm, setConfirm] = useState<null | "register" | "claim">(null);
  // The paste guard's answer, said at the field it belongs to rather than dropped silently.
  const [seedWarning, setSeedWarning] = useState<string | null>(null);

  const stakeWei = parseEth(stake);
  /**
   * One check, two questions.
   *
   * The format rule lived in `eth.ts` and the network rule lived in `Wallet.tsx`'s banner, and
   * this form consulted only the first — so a runner key shaped perfectly and pasted from
   * another chain passed, opened the confirm dialog, and asked the wallet to sign for a machine
   * that does not exist here. The validator is called before the action because after it there
   * is nothing left to warn about.
   */
  const runnerCheck = checkAddressTarget({
    value: runner,
    connectedChainId: accountChainId,
    expectedChainId: dep.chainId,
  });
  const runnerValid = runnerCheck.ok;
  const uriValid = metadataURI.trim().length > 0;
  const canRegister = uriValid && runnerValid && stakeWei !== null && stakeWei > 0n && !seedWarning;
  const trialValid = /^\d+$/.test(trialId.trim());

  function refuseSeedPaste(event: React.ClipboardEvent<HTMLInputElement>) {
    const decision = guardPastedText(event.clipboardData?.getData("text") ?? "");
    if (!decision.refuse) return;
    event.preventDefault();
    setSeedWarning(decision.warning);
  }

  const busy = tx.busy;

  const pour =
    confirm === "register" && stakeWei !== null
      ? {
          title: "Post the bond",
          amount: `${stake} ETH`,
          confirmLabel: "Register agent",
          detail: (
            <div className="pour-detail">
              <p>
                This stake is held by Crucible, not paid to anyone. It is returned when a run
                you claimed is verified, and burned when a skeptic falsifies it.
              </p>
              <p className="mono pour-detail__meta">
                runner {runner.slice(0, 10)}… · metadata {metadataURI.slice(0, 34)}
              </p>
            </div>
          ),
          onConfirm: () => {
            tx.send(
              buildRegisterAgent({
                metadataURI: metadataURI.trim(),
                runner: runner.trim() as `0x${string}`,
                stakeWei,
              }),
            );
            setConfirm(null);
          },
        }
      : confirm === "claim"
        ? {
            title: `Claim trial #${trialId.trim()}`,
            amount: "gas only",
            confirmLabel: "Claim trial",
            detail: (
              <div className="pour-detail">
                <p>
                  The reward is already escrowed, so claiming costs nothing but gas. Your bond
                  moves into escrow with it, and is what a falsified run would be slashed against.
                </p>
              </div>
            ),
            onConfirm: () => {
              tx.send(buildClaimTrial(Number(trialId.trim())));
              setConfirm(null);
            },
          }
        : null;

  return (
    <Chrome>
      <WrongNetworkNotice requiredChainId={dep.chainId} />
      <h1 className="page-title">The Forge</h1>
      <p className="lede">Your agents, your heat, your scars.</p>

      {!isConnected ? (
        <p className="mono" data-tone="ash">
          Connect a wallet to post a bond.
        </p>
      ) : null}

      <section className="console-section">
        <h2 className="section-title">Register an agent</h2>
        <div className="surface form-panel">
          <label className="field">
            <span className="kicker">Agent metadata</span>
            <input
              className="input mono"
              value={metadataURI}
              onChange={(e) => {
                setMetadataURI(e.target.value);
                setSeedWarning(null);
              }}
              onPaste={refuseSeedPaste}
              placeholder="ipfs://… or https://…"
              aria-describedby="metadata-help"
            />
            <span id="metadata-help" className="hint">
              Pinned manifest describing this agent. Written by ERC-8004, read by the
              skeptics deciding whether to take the job.
            </span>
          </label>

          <label className="field">
            <span className="kicker">Runner key</span>
            <input
              className="input mono"
              value={runner}
              onChange={(e) => {
                setRunner(e.target.value);
                setSeedWarning(null);
              }}
              onPaste={refuseSeedPaste}
              placeholder={RUNNER_HINT}
              spellCheck={false}
              aria-invalid={runner.length > 0 && !runnerValid}
            />
            <span className="hint">
              The only key allowed to sign this agent&apos;s claims. Keep it off the machine
              that holds the bond.
            </span>
            {runner.length > 0
              ? runnerCheck.problems.map((problem) => (
                  <span
                    key={problem.check}
                    className="mono"
                    data-tone="sear"
                    role={problem.kind === "error" ? "alert" : "status"}
                  >
                    {problem.message}
                  </span>
                ))
              : null}
          </label>

          <label className="field field--narrow">
            <span className="kicker">Bond</span>
            <input
              className="input mono"
              value={stake}
              onChange={(e) => setStake(e.target.value)}
              inputMode="decimal"
              placeholder="0.01"
            />
            <span className="hint">
              Slashed if a run you claimed turns out to be falsified.
            </span>
          </label>

          {seedWarning ? (
            <span className="mono" data-tone="sear" role="alert">
              {seedWarning}
            </span>
          ) : null}

          <div>
            <button
              className="btn btn-primary"
              disabled={!canRegister || busy || !isConnected}
              aria-busy={busy || undefined}
              onClick={() => setConfirm("register")}
            >
              {busy ? "Posting bond…" : "Register agent"}
            </button>
          </div>
        </div>
      </section>

      <section className="console-section">
        <h2 className="section-title">Claim a trial</h2>
        <div className="surface form-panel--row">
          <label className="field field--trial-id">
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
            aria-busy={busy || undefined}
            onClick={() => setConfirm("claim")}
          >
            {busy ? "Claiming…" : "Claim trial"}
          </button>
        </div>
      </section>

      {pour ? (
        <PourConfirm
          open
          title={pour.title}
          amount={pour.amount}
          detail={pour.detail}
          confirmLabel={pour.confirmLabel}
          busy={busy}
          onConfirm={pour.onConfirm}
          onRequestClose={() => setConfirm(null)}
        />
      ) : null}

      <div className="tx-anchor">
        <TxStates state={tx.state} message={tx.message} hash={tx.hash} />
      </div>

      <h2 className="section-title section-title--detached">Run console</h2>
      <div className="raised console-log">
        <p className="kicker console-log__head">HEAT — live run log</p>
        <p className="console-log__empty">
          Register an agent and claim a trial to see live logs here.
        </p>
      </div>
    </Chrome>
  );
}