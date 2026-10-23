"use client";

import Link from "next/link";
import { Chrome, ColdForge, Quenching, SignalLost } from "@/components/Chrome";
import { useSnapshot, useCountdown } from "@/lib/useSnapshot";
import { formatDuration, shortHash } from "@/lib/forge";
import { formatWei, parseEth } from "@/lib/eth";

/**
 * The Break — the skeptic board.
 *
 * Every row states the payout and the risk before the click, because the whole
 * design rests on a skeptic knowing they are betting their own stake.
 */
export default function BountiesPage() {
  const { data, error, loading, chainNowMs } = useSnapshot();
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
          <BreakRow key={t.id} trial={t} chainNowMs={chainNowMs} />
        ))}
      </div>
    </Chrome>
  );
}

function BreakRow({
  trial,
  chainNowMs,
}: {
  trial: NonNullable<ReturnType<typeof useSnapshot>["data"]>["trials"][number];
  chainNowMs: number | null;
}) {
  const left = useCountdown(trial.breakWindowEndsAt, chainNowMs);
  // Same arithmetic as `BreakPanel`, in wei. This board advertises the figure a skeptic is about
  // to sign for, and the float version it replaced divided a reward by 100 and printed
  // `toFixed(6)` — which rounds, so a floor like 0.0000004 advertised a stake below the
  // contract's and the filing reverted. Full 18 decimals is deliberate: at that precision
  // nothing rounds, so board and panel cannot disagree.
  const rewardWei = parseEth(trial.rewardEth) ?? 0n;
  const bondWei = parseEth(trial.bondEth) ?? 0n;
  const minStakeWei = rewardWei / 100n;
  const payoutWei = (bondWei * 30n) / 100n;

  return (
    <div className="surface break-card">
      <div className="break-card__head">
        <div>
          <p className="mono break-card__id">
            TRIAL {trial.id} · run {shortHash(trial.runHash)}
          </p>
          <p className="break-card__payout">
            Earn {formatWei(payoutWei, 18)} ETH if it breaks (30% of the {trial.bondEth} ETH bond)
          </p>
          <p className="mono break-card__meta">
            stake ≥ {formatWei(minStakeWei, 18)} ETH · window {formatDuration(left)}
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
