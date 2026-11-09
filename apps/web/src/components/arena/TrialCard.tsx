"use client";

import Link from "next/link";
import type { ApiTrial } from "@crucible/indexer";
import { shortHash, shortCid } from "@/lib/forge";
import { TrialCountdown } from "./TrialCountdown";
import { TrialStatus } from "./TrialStatus";
import { TrialSeal } from "./TrialSeal";

/**
 * TrialCard — a single trial in the board.
 *
 * Shows: the trial's public identity (id + the spec fingerprint it was posted with),
 * sponsor, status, reward and bond (where real), the pinned suite this claim will be
 * judged against, the verification path (pinned suite, or Argus once a break is filed),
 * and the countdown to the deadline that actually decides the next act. Links to the
 * trial detail page.
 *
 * There is deliberately no `name` field: the chain stores a spec digest, not a title,
 * so any name this card printed would be invented. The id is the name the protocol
 * gives a trial, and `spec` is the fingerprint it was posted with — both real, both
 * checkable. Unknown values render `—`, never `0`.
 */
export function TrialCard({
  trial,
  chainNowMs,
}: {
  trial: ApiTrial;
  /** Anchor for the countdown: `max(headTimestamp + 1, serverNow)` from the snapshot. */
  chainNowMs?: number | null;
}) {
  const reward = trial.rewardEth ?? "—";
  const bond = trial.bondEth ?? "—";
  // The verification path is a fact of the trial's state, not a choice the card makes:
  // every claim is judged by the sponsor's pinned suite, and a filed break moves the
  // question to the committee. The card says which of the two is currently in force.
  const underChallenge = trial.breakSkeptic !== null || trial.dispute !== null;
  const verification = underChallenge
    ? { method: "Pinned suite → Argus", note: "a skeptic filed a break — the committee grades the claim" }
    : { method: "Pinned suite", note: "the sponsor's pinned tests decide — anyone can file a break" };

  return (
    <Link
      href={`/trials/${trial.id}`}
      className="surface trial-card"
      aria-label={`Trial ${trial.id}, sponsor ${trial.sponsor}, status ${trial.status}`}
    >
      <div className="trial-card__head">
        <div className="trial-card__seal" aria-hidden="true">
          <TrialSeal width="28" height="28" />
        </div>
        <div className="trial-card__meta">
          <p className="mono trial-card__id">TRIAL {trial.id}</p>
          <p className="trial-card__sponsor">
            <span className="mono">{shortHash(trial.sponsor)}</span>
            <span className="trial-card__sponsor__label">sponsor</span>
          </p>
          {/* The spec fingerprint is the closest thing to a name this protocol has — a
              claim the chain can check, not a title anyone typed. */}
          <p className="mono trial-card__spec" title={trial.specDigest}>
            spec {shortHash(trial.specDigest)}
          </p>
        </div>
        <TrialStatus status={trial.status} />
      </div>

      <div className="trial-card__body">
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
              {trial.testsCID ? shortCid(trial.testsCID) : "not disclosed yet"}
            </span>
          </div>
          <div className="trial-card__fact trial-card__fact--wide">
            <span className="trial-card__fact__label">Verification</span>
            <span className="trial-card__fact__value" title={verification.note}>
              {verification.method}
            </span>
          </div>
        </div>
      </div>

      <div className="trial-card__foot">
        <TrialCountdown
          deadlineAt={trial.deadlineAt ?? null}
          breakWindowEndsAt={trial.breakWindowEndsAt ?? null}
          status={trial.status}
          chainNowMs={chainNowMs ?? null}
        />
        <span className="trial-card__cta">Inspect trial</span>
      </div>
    </Link>
  );
}
