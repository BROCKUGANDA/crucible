"use client";

import Link from "next/link";
import type { ApiTrial } from "@crucible/indexer";
import {
  statusMeta,
  verdictMeta,
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
    <div style={{ display: "grid", gap: 12 }}>
      {trials.map((t) => (
        <TrialRow key={t.id} trial={t} serverNowMs={serverNowMs ?? null} />
      ))}
    </div>
  );
}

function TrialRow({ trial, serverNowMs }: { trial: ApiTrial; serverNowMs: number | null }) {
  const status = statusMeta(trial.status);
  const verdict = verdictMeta(trial.verdict);
  const cools = useCountdown(trial.coolsInSec ?? trial.deadline, serverNowMs);
  const breakLeft = useCountdown(trial.breakWindowEndsInSec, serverNowMs);

  return (
    <Link href={`/trials/${trial.id}`} className="surface" style={{ display: "block", padding: 18 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <p className="mono" style={{ margin: 0, color: "var(--faint)" }}>
            TRIAL {trial.id}
          </p>
          <p style={{ margin: "4px 0 0", fontSize: 21, fontWeight: 600 }}>
            {formatEth(trial.rewardEth)}{" "}
            <span style={{ color: "var(--faint)", fontSize: 13.5 }}>reward</span>
          </p>
          <p className="mono" style={{ margin: "6px 0 0", color: "var(--faint)" }}>
            suite {shortCid(trial.testsCID)}
          </p>
        </div>

        <div style={{ textAlign: "right" }}>
          <span className="chip" style={{ color: status.color }}>
            {status.label}
          </span>
          {trial.verdict !== "none" ? (
            <p className="mono" style={{ color: verdict.color, margin: "10px 0 0" }}>
              {verdict.label}
            </p>
          ) : null}
          <p className="mono" style={{ color: "var(--dim)", margin: "10px 0 0" }}>
            {trial.status === "judging" && breakLeft !== null
              ? `break window ${formatDuration(breakLeft)}`
              : `cools in ${formatDuration(cools)}`}
          </p>
        </div>
      </div>

      {trial.runHash ? (
        <p className="mono" style={{ margin: "12px 0 0", color: "var(--faint)" }}>
          run {shortHash(trial.runHash)}
        </p>
      ) : null}
    </Link>
  );
}
