"use client";

import Link from "next/link";
import { Chrome, ColdForge, Quenching, SignalLost } from "@/components/Chrome";
import { useSnapshot, useCountdown } from "@/lib/useSnapshot";
import { formatDuration, formatEth, shortHash } from "@/lib/forge";

/**
 * The Break — the skeptic board.
 *
 * Every row states the payout and the risk before the click, because the whole
 * design rests on a skeptic knowing they are betting their own stake.
 */
export default function BountiesPage() {
  const { data, error, loading, serverNowMs } = useSnapshot();
  const breakable = data?.trials.filter((t) => t.status === "judging") ?? [];

  return (
    <Chrome>
      <h1 className="page-title">The Break</h1>
      <p className="lede">
        Paid skepticism. Find the flaw, stake the claim, split the bond.
      </p>

      <div className="surface how-panel">
        <details>
          <summary>How breaks settle</summary>
          <p className="how-panel__body">
            Argus re-runs the pinned suite in an identical container. Deterministic
            evidence beats opinion. Timeout defaults to the agent — the burden of proof
            is yours.
          </p>
        </details>
      </div>

      {loading ? <Quenching label="sharpening the chisels…" /> : null}
      {error ? <SignalLost message={error} /> : null}
      {data && breakable.length === 0 ? (
        <ColdForge line="Nothing to break — every run is holding." cta="Watch for new runs" href="/trials" />
      ) : null}

      <div className="board">
        {breakable.map((t) => (
          <BreakRow key={t.id} trial={t} serverNowMs={serverNowMs} />
        ))}
      </div>
    </Chrome>
  );
}

function BreakRow({
  trial,
  serverNowMs,
}: {
  trial: NonNullable<ReturnType<typeof useSnapshot>["data"]>["trials"][number];
  serverNowMs: number | null;
}) {
  const left = useCountdown(trial.breakWindowEndsAt, serverNowMs);
  const reward = Number(trial.rewardEth);
  const bond = Number(trial.bondEth);
  const minStake = reward / 100;
  const payout = bond * 0.3;

  return (
    <div className="surface break-card">
      <div className="break-card__head">
        <div>
          <p className="mono break-card__id">
            TRIAL {trial.id} · run {shortHash(trial.runHash)}
          </p>
          <p className="break-card__payout">
            Earn {payout.toFixed(4)} ETH if it breaks (30% of the {bond} ETH bond)
          </p>
          <p className="mono break-card__meta">
            stake ≥ {minStake.toFixed(6)} ETH · window {formatDuration(left)}
          </p>
        </div>
        <div className="break-card__side">
          <Link className="btn btn-primary" href={`/trials/${trial.id}`}>
            Stake to break
          </Link>
          <span className="mono" data-tone="sear">
            Lose, and half your stake goes to the agent.
          </span>
        </div>
      </div>
    </div>
  );
}
