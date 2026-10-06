"use client";

import { useState } from "react";
import { keccak256, stringToHex, type Hex } from "viem";
import { useAccount } from "wagmi";
import { Chrome, TxStates } from "@/components/Chrome";
import { WrongNetworkNotice } from "@/components/Wallet";
import { EMPTY_WIZARD, validateWizard, type WizardValues } from "@/lib/wizard";
import { buildCreateTrial, useTx } from "@/lib/useTx";
import { deployment } from "@/lib/wagmi";
import { parseEth } from "@/lib/eth";

/**
 * Sponsor wizard — three steps, matching the flow in the PRD.
 *
 * Validation happens before any transaction, because a reverted trial-creation tx
 * still costs gas and the sponsor then waits a block to try again.
 */

const KICKERS = ["01 — STRIKE", "02 — FUEL", "03 — IGNITE"] as const;

export default function NewTrialPage() {
  const [values, setValues] = useState<WizardValues>(EMPTY_WIZARD);
  const [step, setStep] = useState(0);
  const result = validateWizard(values);

  const { isConnected } = useAccount();
  const dep = deployment();
  const tx = useTx();

  const set = (k: keyof WizardValues, v: string) => setValues((s) => ({ ...s, [k]: v }));

  return (
    <Chrome>
      <WrongNetworkNotice requiredChainId={dep.chainId} />
      <h1 style={{ fontSize: 28, marginTop: 0 }}>Light a trial</h1>
      <p className="kicker">{KICKERS[step]}</p>

      {step === 0 ? (
        <Field
          label="Trial spec (markdown or IPFS CID)"
          help="Vague specs get broken runs. Point at files, name the tests."
          value={values.spec}
          error={result.errors.spec}
          onChange={(v) => set("spec", v)}
          multiline
        />
      ) : null}

      {step === 1 ? (
        <>
          <Field
            label="Pinned test suite CID"
            help="Argus re-runs exactly this in an identical container."
            value={values.testsCID}
            error={result.errors.testsCID}
            onChange={(v) => set("testsCID", v)}
            mono
          />
          <Field
            label="Reward (ETH)"
            help={`Agents stake ${result.bondEth} ETH to play.`}
            value={values.rewardEth}
            error={result.errors.rewardEth}
            onChange={(v) => set("rewardEth", v)}
          />
        </>
      ) : null}

      {step === 2 ? (
        <>
          <Field
            label="Submission deadline (hours)"
            help="No run by then, you get the reward back."
            value={values.deadlineHours}
            error={result.errors.deadlineHours}
            onChange={(v) => set("deadlineHours", v)}
          />
          <Field
            label="Skeptic window (hours)"
            help="How long skeptics have to attack a submitted run."
            value={values.breakWindowHours}
            error={result.errors.breakWindowHours}
            onChange={(v) => set("breakWindowHours", v)}
          />
          <div className="surface" style={{ padding: 20, marginTop: 24 }}>
            <p className="mono" style={{ margin: 0 }}>
              suite {values.testsCID || "—"} · reward {values.rewardEth} ETH · bond{" "}
              {result.bondEth} ETH · quench in {values.deadlineHours}h
            </p>
          </div>
        </>
      ) : null}

      <div style={{ display: "flex", gap: 12, marginTop: 28, alignItems: "center" }}>
        {step > 0 ? (
          <button className="btn btn-ghost" onClick={() => setStep((s) => s - 1)}>
            Back
          </button>
        ) : null}
        <button
          className={tx.state === "heating" ? "btn btn-primary heating" : "btn btn-primary"}
          disabled={!result.ok || tx.state === "heating"}
          onClick={() => {
            if (step < 2) {
              setStep((s) => s + 1);
              return;
            }
            // T1: escrow the reward. The reward travels as msg.value on createTrial,
            // so this is one transaction rather than the two the copy deck described —
            // the contract takes the value directly.
            const deadline = Math.floor(Date.now() / 1000) + Number(values.deadlineHours) * 3600;
            tx.send(
              buildCreateTrial({
                specDigest: digestOf(values.spec),
                testsDigest: digestOf(values.testsCID.trim()),
                rewardWei: parseEth(values.rewardEth) ?? 0n,
                deadline,
                breakWindow: Number(values.breakWindowHours) * 3600,
              }),
            );
          }}
        >
          {step < 2
            ? "Continue"
            : tx.state === "heating"
              ? "Lighting the trial…"
              : "Escrow & light trial"}
        </button>
        {step === 2 ? (
          <span className="mono" style={{ color: "var(--faint)" }}>
            {Number(values.rewardEth)} ETH escrowed on Sepolia
          </span>
        ) : null}
        {!isConnected ? (
          <span className="mono" style={{ color: "var(--ash)" }}>
            Connect a wallet to light a trial
          </span>
        ) : null}
      </div>

      <div style={{ marginTop: 16 }}>
        <TxStates state={tx.state} message={tx.message} hash={tx.hash} />
      </div>
    </Chrome>
  );
}

/**
 * The contract commits to bytes32 digests of the pinned content, not to CID text.
 * Hashing the text here is the honest thing to do when the indexer is not available to
 * resolve the CID the sponsor actually pinned.
 */
function digestOf(text: string): Hex {
  return keccak256(stringToHex(text));
}

function Field({
  label,
  help,
  value,
  error,
  onChange,
  multiline,
  mono,
}: {
  label: string;
  help: string;
  value: string;
  error?: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  mono?: boolean;
}) {
  const id = `field-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <label htmlFor={id} style={{ display: "block", marginTop: 24 }}>
      <span style={{ display: "block", fontWeight: 600, marginBottom: 8 }}>{label}</span>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={multiline ? 8 : undefined}
        className={mono ? "mono" : undefined}
        aria-invalid={Boolean(error)}
        aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
        style={{
          width: "100%",
          background: "var(--bg1)",
          border: `1px solid ${error ? "var(--sear)" : "var(--bg2)"}`,
          borderRadius: 8,
          color: "var(--text)",
          padding: 12,
          font: "inherit",
        }}
      />
      <span
        id={`${id}-help`}
        style={{ display: "block", fontSize: 12, color: "var(--faint)", marginTop: 6 }}
      >
        {help}
      </span>
      {error ? (
        <span
          id={`${id}-error`}
          role="alert"
          style={{ display: "block", fontSize: 13.5, color: "var(--sear)", marginTop: 6 }}
        >
          {error}
        </span>
      ) : null}
    </label>
  );
}
