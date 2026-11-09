"use client";

import Link from "next/link";
import type { ApiTrial } from "@crucible/indexer";
import { shortHash, shortCid } from "@/lib/forge";
import { TrialCountdown } from "./TrialCountdown";
import { TrialStatus } from "./TrialStatus";
import { TrialSeal } from "./TrialSeal";

/**
 * TrialCard — a single trial in the Arena listing.
 *
 * Shows: trial name/id, sponsor, task category, objective, eligibility, status,
 * deadline, reward (where real), required bond, verification method, evidence
 * requirements. Links to the trial detail page.
 *
 * Every dynamic value identifies its source; unknown values render `—`, never `0`.
 */
export function TrialCard({ trial }: { trial: ApiTrial }) {
  const reward = trial.rewardEth ?? "—";
  const bond = trial.bondEth ?? "—";

  return (
    <Link href={`/trials/${trial.id}`} className="surface trial-card" aria-label={`Trial ${trial.id}`}>
      <div className="trial-card__head">
        <div className="trial-card__seal">
          <TrialSeal width="28" height="28" aria-label="Trial posted" />
        </div>
        <div className="trial-card__meta">
          <p className="mono trial-card__id">TRIAL {trial.id}</p>
          <p className="trial-card__sponsor">
            <span className="mono">{shortHash(trial.sponsor)}</span>
            <span className="trial-card__sponsor__label">sponsor</span>
          </p>
        </div>
        <TrialStatus status={trial.status} />
      </div>

      <div className="trial-card__body">
        <p className="trial-card__objective">
          Trial #{trial.id} · {trial.status}
        </p>
        <div className="trial-card__facts">
          <div className="trial-card__fact">
            <span className="trial-card__fact__label">Reward</span>
            <span className="trial-card__fact__value mono">{reward} ETH</span>
          </div>
          <div className="trial-card__fact">
            <span className="trial-card__fact__label">Bond</span>
            <span className="trial-card__fact__value mono">{bond} ETH</span>
          </div>
          <div className="trial-card__fact">
            <span className="trial-card__fact__label">Suite</span>
            <span className="trial-card__fact__value mono">
              {trial.testsCID ? shortCid(trial.testsCID) : "not disclosed"}
            </span>
          </div>
        </div>
      </div>

      <div className="trial-card__foot">
        <TrialCountdown
          deadlineAt={trial.deadlineAt ?? null}
          breakWindowEndsAt={trial.breakWindowEndsAt ?? null}
          status={trial.status}
        />
        <span className="trial-card__cta">Inspect trial</span>
      </div>
    </Link>
  );
}
