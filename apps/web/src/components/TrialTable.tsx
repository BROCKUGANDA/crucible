"use client";

import Link from "next/link";
import type { ApiTrial } from "@crucible/indexer";
import {
  statusMeta,
  verdictMeta,
  deadlineHeat,
  heatTone,
  formatDuration,
  formatEth,
  shortCid,
  shortHash,
} from "@/lib/forge";
import { useCountdown } from "@/lib/useSnapshot";

export function TrialTable({
  trials,
  serverNowMs,
}: {
  trials: ApiTrial[];
  serverNowMs?: number | null;
}) {
  if (trials.length === 0) return null;
  return (
    <div className="trial-list">
      {trials.map((t) => (
        <TrialRow key={t.id} trial={t} serverNowMs={serverNowMs ?? null} />
      ))}
    </div>
  );
}

function TrialRow({ trial, serverNowMs }: { trial: ApiTrial; serverNowMs: number | null }) {
  const status = statusMeta(trial.status);
  const verdict = verdictMeta(trial.verdict);
  const cools = useCountdown(trial.deadlineAt, serverNowMs);
  const breakLeft = useCountdown(trial.breakWindowEndsAt, serverNowMs);

  // A judging trial is already past its submission deadline: what is actually running out on
  // that row is the skeptic window, so that is the countdown the row reads its urgency from.
  // One number feeds both the text and the tone — a colour that described a different
  // countdown than the one the reader is shown would be decoration wearing a measurement.
  const onBreakWindow = trial.status === "judging" && breakLeft !== null;
  const remaining = onBreakWindow ? breakLeft : cools;
  const heat = deadlineHeat(remaining);

  return (
    <Link href={`/trials/${trial.id}`} className="surface trial-row">
      <div className="trial-row__head">
        <div>
          <p className="mono trial-row__id">TRIAL {trial.id}</p>
          <p className="trial-row__reward">
            {formatEth(trial.rewardEth)} <span className="trial-row__unit">reward</span>
          </p>
          <p className="mono trial-row__suite">suite {shortCid(trial.testsCID)}</p>
        </div>

        <div className="trial-row__side">
          <span className="chip" data-tone={status.tone}>
            {status.label}
          </span>
          {trial.verdict !== "none" ? (
            <p className="mono trial-row__verdict" data-tone={verdict.tone}>
              {verdict.label}
            </p>
          ) : null}
          <p className="mono trial-row__cool" data-tone={heatTone(heat)}>
            {onBreakWindow
              ? `break window ${formatDuration(remaining)}`
              : `cools in ${formatDuration(remaining)}`}
          </p>
        </div>
      </div>

      {trial.runHash ? (
        <p className="mono trial-row__run">run {shortHash(trial.runHash)}</p>
      ) : null}
    </Link>
  );
}
