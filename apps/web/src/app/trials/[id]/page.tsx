"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Chrome, Quenching, SignalLost } from "@/components/Chrome";
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
import { useCountdown } from "@/lib/useSnapshot";

const TABS = ["The charge", "Struck work", "Break attempts", "The quench"] as const;

export default function TrialDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params?.id);
  const { data, error, loading, serverNowMs } = useSnapshot();
  const trial = data?.trials.find((t) => t.id === id);

  const cools = useCountdown(trial?.deadlineAt ?? null, serverNowMs);
  const breakLeft = useCountdown(trial?.breakWindowEndsAt ?? null, serverNowMs);

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

  return (
    <Chrome>
      <p className="kicker">Trial {trial.id}</p>
      <h1 className="page-title trial-title">{formatEth(trial.rewardEth)} reward</h1>
      <span className="chip" data-tone={status.tone}>
        {status.label}
      </span>

      <nav aria-label="Trial sections" className="trial-tabs">
        {TABS.map((t, i) => (
          <span key={t} className="trial-tabs__tab" data-active={i === 0 || undefined}>
            {t}
          </span>
        ))}
      </nav>

      <div className="surface detail-panel">
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
        {trial.operator ? <Field label="Agent" value={trial.operator} mono /> : null}
        {trial.runHash ? <Field label="Run" value={shortHash(trial.runHash)} mono /> : null}
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
      ) : null}

      {trial.status === "judging" ? (
        <BreakPanel
          trialId={trial.id}
          rewardEth={trial.rewardEth}
          bondEth={trial.bondEth}
        />
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

