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

  const cools = useCountdown(trial?.coolsInSec ?? null, serverNowMs);
  const breakLeft = useCountdown(trial?.breakWindowEndsInSec ?? null, serverNowMs);

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
        <div className="surface" style={{ padding: 32, textAlign: "center" }}>
          <h2 style={{ color: "var(--sear)", marginTop: 0 }}>Lost slag.</h2>
          <p style={{ color: "var(--dim)" }}>This page never left the crucible.</p>
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
      <h1 style={{ fontSize: 28, margin: "8px 0" }}>{formatEth(trial.rewardEth)} reward</h1>
      <span className="chip" style={{ color: status.color }}>
        {status.label}
      </span>

      <nav aria-label="Trial sections" style={{ display: "flex", gap: 20, margin: "28px 0", fontSize: 13.5 }}>
        {TABS.map((t, i) => (
          <span key={t} style={{ color: i === 0 ? "var(--text)" : "var(--faint)" }}>
            {t}
          </span>
        ))}
      </nav>

      <div className="surface" style={{ padding: 24, display: "grid", gap: 14 }}>
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
        <div
          className="surface"
          style={{ padding: 24, marginTop: 20, borderColor: verdict.color }}
        >
          <p style={{ margin: 0, color: verdict.color, fontWeight: 600 }}>{verdict.label}</p>
          <p style={{ margin: "8px 0 0", color: "var(--dim)" }}>
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
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
      <span style={{ color: "var(--faint)", fontSize: 13.5 }}>{label}</span>
      <span className={mono ? "mono" : undefined}>{value}</span>
    </div>
  );
}

