"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useRef, useState, type KeyboardEvent } from "react";
import { Chrome, Quenching, SignalLost, TxLink, TxStates } from "@/components/Chrome";
import { BreakPanel } from "@/components/BreakPanel";
import { useSnapshot } from "@/lib/useSnapshot";
import {
  formatDuration,
  formatEth,
  shortCid,
  shortHash,
  statusMeta,
  verdictMeta,
} from "@/lib/forge";
import { buildFinalize, useTx } from "@/lib/useTx";
import { useCountdown } from "@/lib/useSnapshot";

const TABS = ["The charge", "Struck work", "Break attempts", "The quench"] as const;

export default function TrialDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params?.id);
  const { data, error, loading, serverNowMs } = useSnapshot();
  const trial = data?.trials.find((t) => t.id === id);

  const cools = useCountdown(trial?.deadlineAt ?? null, serverNowMs);
  const breakLeft = useCountdown(trial?.breakWindowEndsAt ?? null, serverNowMs);

  const [tab, setTab] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tx = useTx();

  /** Quenchable: the skeptic window has closed, nothing was filed, and Argus holds
   * no dispute. Finalize is permissionless — whoever calls it moves none of their own
   * money — so this is a plain action, not a pour. */
  const quenchable =
    trial?.status === "judging" &&
    trial.breakWindowEndsAt !== null &&
    (serverNowMs ?? Date.now()) / 1000 >= trial.breakWindowEndsAt;

  if (loading) {
    return (
      <Chrome>
        <Quenching label="drawing the trial from the fire…" />
      </Chrome>
    );
  }
  if (error) {
    return (
      <Chrome>
        <SignalLost message={error} />
      </Chrome>
    );
  }
  if (!trial) {
    return (
      <Chrome>
        <div className="surface void-panel">
          <h2 className="void-panel__title" data-tone="sear">
            Lost slag.
          </h2>
          <p className="void-panel__body">This page never left the crucible.</p>
          <Link className="btn btn-primary" href="/trials">
            Back to the forge
          </Link>
        </div>
      </Chrome>
    );
  }

  const status = statusMeta(trial.status);
  const verdict = verdictMeta(trial.verdict);

  /** APG tabs, selection-follows-focus: the arrow keys move the selected tab itself,
   * so one keystroke does the whole job for both pointer-less and sighted keyboard
   * operators. Arrow keys wrap, because a strip that dead-ends is a strip that
   * teaches people to stop using the keyboard. */
  function onTabKeyDown(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    let next: number;
    if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    else return;
    e.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <Chrome>
      <p className="kicker">Trial {trial.id}</p>
      <h1 className="page-title trial-title">{formatEth(trial.rewardEth)} reward</h1>
      <span className="chip" data-tone={status.tone}>
        {status.label}
      </span>

      <div role="tablist" aria-label="Trial sections" className="trial-tabs">
        {TABS.map((t, i) => (
          <button
            key={t}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`trial-tab-${t}`}
            aria-selected={i === tab}
            aria-controls={`trial-panel-${t}`}
            tabIndex={i === tab ? 0 : -1}
            className="trial-tabs__tab"
            data-active={i === tab || undefined}
            onClick={() => setTab(i)}
            onKeyDown={(e) => onTabKeyDown(e, i)}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 0 ? (
        <div
          role="tabpanel"
          id="trial-panel-The charge"
          aria-labelledby="trial-tab-The charge"
          className="surface detail-panel"
        >
          <Field label="Sponsor" value={trial.sponsor} mono />
          <Field label="Bond" value={formatEth(trial.bondEth)} mono />
          <Field
            label="Suite"
            value={
              trial.testsCID
                ? shortCid(trial.testsCID)
                : `${shortHash(trial.testsDigest)} (awaiting disclosure)`
            }
            mono
          />
          <Field
            label="Spec"
            value={
              trial.specCID
                ? shortCid(trial.specCID)
                : `${shortHash(trial.specDigest)} (awaiting disclosure)`
            }
            mono
          />
          <Field
            label="Countdown"
            value={
              trial.status === "judging" && breakLeft !== null
                ? `break window closes in ${formatDuration(breakLeft)}`
                : trial.status === "settled"
                  ? "settled"
                  : `submission deadline in ${formatDuration(cools)}`
            }
          />
        </div>
      ) : null}

      {tab === 1 ? (
        <div
          role="tabpanel"
          id="trial-panel-Struck work"
          aria-labelledby="trial-tab-Struck work"
          className="surface detail-panel"
        >
          {trial.operator ? (
            <Field label="Agent" value={trial.operator} mono />
          ) : null}
          {trial.runHash ? <Field label="Run" value={shortHash(trial.runHash)} mono /> : null}
          {!trial.operator && !trial.runHash ? (
            <p className="hint hint--block">
              Nothing on the anvil yet — no agent has claimed this trial.
            </p>
          ) : null}
        </div>
      ) : null}

      {tab === 2 ? (
        <div
          role="tabpanel"
          id="trial-panel-Break attempts"
          aria-labelledby="trial-tab-Break attempts"
        >
          {trial.status === "judging" ? (
            <BreakPanel trialId={trial.id} rewardEth={trial.rewardEth} bondEth={trial.bondEth} />
          ) : trial.breakSkeptic ? (
            <div className="surface detail-panel">
              <Field label="Skeptic" value={trial.breakSkeptic} mono />
              <Field label="Stake" value={formatEth(trial.breakStakeEth)} mono />
            </div>
          ) : (
            <p className="hint hint--block">
              No breaks filed. Skeptics can strike only while the trial is being judged.
            </p>
          )}
        </div>
      ) : null}

      {tab === 3 ? (
        <div
          role="tabpanel"
          id="trial-panel-The quench"
          aria-labelledby="trial-tab-The quench"
        >
          {trial.verdict !== "none" ? (
            <div className="surface verdict-panel" data-tone={verdict.tone}>
              <p className="verdict-panel__label">{verdict.label}</p>
              <p className="verdict-panel__why">
                {trial.verdict === "paid"
                  ? "Verified. The run survived every strike."
                  : trial.verdict === "slashed"
                    ? "Broken. The skeptic's proof held. Bond split: 30% to the skeptic, 70% to the treasury. Sponsor refunded."
                    : "Reclaimed. No run arrived before the deadline. The reward went home; the agent's bond went back."}
              </p>
            </div>
          ) : trial.status === "challenged" ? (
            <p className="hint hint--block">
              A break is under review — Argus holds the tongs until the committee's verdict.
            </p>
          ) : quenchable ? (
            <div className="surface detail-panel">
              <p className="verdict-panel__why">
                The skeptic window closed and nothing survived to challenge the claim. Anyone
                may quench now — the agent takes the reward, the bond stands, and the alloy
                mints. Quenching moves none of your own money.
              </p>
              <button
                type="button"
                className="btn btn-primary"
                disabled={tx.busy}
                aria-busy={tx.busy || undefined}
                onClick={() => tx.send(buildFinalize(trial.id))}
              >
                {tx.busy ? "Quenching…" : "Quench the trial"}
              </button>
              <TxStates state={tx.state} hash={tx.hash} message={tx.error} />
              {tx.state === "poured" && tx.hash ? (
                <p className="hint">
                  Quenched on-chain. The ledger catches up in a moment —{" "}
                  <TxLink hash={tx.hash} />.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="hint hint--block">
              Not quenched yet.{" "}
              {trial.status === "judging" && breakLeft !== null
                ? `The skeptic window closes in ${formatDuration(breakLeft)} — quenching comes after.`
                : "The verdict lands once the skeptic window closes."}
            </p>
          )}
        </div>
      ) : null}
    </Chrome>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="kv">
      <span className="kv__key">{label}</span>
      <span className={mono ? "mono" : undefined}>{value}</span>
    </div>
  );
}

