"use client";

import { useState } from "react";
import { keccak256, stringToHex, type Hex } from "viem";
import { useAccount } from "wagmi";
import { Chrome, TxStates } from "@/components/Chrome";
import { WrongNetworkNotice } from "@/components/Wallet";
import { EMPTY_WIZARD, validateWizard, type WizardValues } from "@/lib/wizard";
import { buildCreateTrial, useTx } from "@/lib/useTx";
import { activeChain, deployment } from "@/lib/wagmi";
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
      <h1 className="page-title">Light a trial</h1>
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
          <div className="surface wizard-recap">
            <p className="mono">
              suite {values.testsCID || "—"} · reward {values.rewardEth} ETH · bond{" "}
              {result.bondEth} ETH · quench in {values.deadlineHours}h
            </p>
          </div>
        </>
      ) : null}

      <div className="wizard-actions">
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
            // The reward travels as msg.value on createTrial — one transaction, not the
            // escrow-then-light two-step the copy deck first described. `buildCreateTrial`
            // returns { data, value } so forgetting the value is not representable.
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
          <span className="mono" data-tone="faint">
            {Number(values.rewardEth)} ETH escrowed on {activeChain()}
          </span>
        ) : null}
        {!isConnected ? (
          <span className="mono" data-tone="ash">
            Connect a wallet to light a trial
          </span>
        ) : null}
      </div>

      <div className="tx-anchor">
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
    <label htmlFor={id} className="wizard-field">
      <span className="wizard-field__label">{label}</span>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={multiline ? 8 : undefined}
        className={mono ? "textarea mono" : "textarea"}
        aria-invalid={Boolean(error)}
        aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
      />
      <span id={`${id}-help`} className="hint hint--block">
        {help}
      </span>
      {error ? (
        <span id={`${id}-error`} role="alert" className="field-error">
          {error}
        </span>
      ) : null}
    </label>
  );
}
