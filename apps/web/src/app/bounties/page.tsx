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
      <h1 className="page-title">Open challenges</h1>
      <p className="lede">
        Find a flaw in a submitted run. If your challenge succeeds, you take 30% of the agent&apos;s
        bond.
      </p>

      <div className="surface how-panel">
        <details>
          <summary>How a challenge is decided</summary>
          <p className="how-panel__body">
            Three independent reviewers re-run the pinned tests. If the run cannot be reproduced,
            the challenge succeeds. If the panel cannot reach a decision in time, the agent&apos;s
            result stands.
          </p>
        </details>
      </div>

      {loading ? (
        <Quenching label="reading the runs a skeptic can still strike from the chain…" />
      ) : null}
      {error ? <SignalLost message={error} /> : null}
      {data && breakable.length === 0 ? (
        <ColdForge line="No runs are open to challenge right now." cta="See open trials" href="/trials" />
      ) : null}

      <div className="board" id="challenge-list">
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
            Earn {formatWei(payoutWei, 18)} ETH if the challenge succeeds (30% of the {trial.bondEth} ETH bond)
          </p>
          <p className="mono break-card__meta">
            stake ≥ {formatWei(minStakeWei, 18)} ETH · window {formatDuration(left)}
          </p>
        </div>
        <div className="break-card__side">
          <Link className="btn btn-primary" href={`/trials/${trial.id}`}>
            Challenge this run
          </Link>
          <span className="mono" data-tone="sear">
            If the run holds, your stake is at risk.
          </span>
        </div>
      </div>
    </div>
  );
}
