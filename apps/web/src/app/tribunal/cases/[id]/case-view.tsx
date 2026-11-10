"use client";

/**
 * Tribunal case — the evidence a claim stands on, and the verdict it got.
 *
 * Honest scope, stated plainly on the page: Crucible has no reviewer panel UI. The
 * Argus app carries the seat view and the signing flow; this page reports only what
 * the chain published — the break, the seat seals, the unseals, the verdict — and
 * the evidence artifacts this host discloses (the spec and suite CIDs, when the
 * sponsor made them readable). It never invents a seat, a tally, a timestamp or a
 * reviewer's thinking.
 */

import Link from "next/link";
import { Chrome, Quenching, SignalLost } from "@/components/Chrome";
import { EvidencePacket } from "@/components/arena/EvidencePacket";
import { VerdictPanel } from "@/components/arena/VerdictPanel";
import { StaleDataIndicator } from "@/components/arena/StaleDataIndicator";
import { useSnapshot, useCountdown } from "@/lib/useSnapshot";
import { formatDuration, formatEth, shortCid, shortHash, statusMeta } from "@/lib/forge";
import { formatWhen } from "@/lib/clock";

export function CaseView({ id }: { id: number }) {
  const { data, error, loading, chainNowMs } = useSnapshot();
  const trial = data?.trials.find((t) => t.id === id);

  const breakLeft = useCountdown(trial?.breakWindowEndsAt ?? null, chainNowMs);

  if (loading) {
    return (
      <Chrome>
        <Quenching label="drawing the case file…" />
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
            No such case.
          </h2>
          <p className="void-panel__body">No trial carries that number — or this host does not index it.</p>
          <Link className="btn btn-primary" href="/tribunal">
            Back to the queue
          </Link>
        </div>
      </Chrome>
    );
  }

  const status = statusMeta(trial.status);
  const committed = trial.dispute?.committed ?? [];
  const revealed = trial.dispute?.revealed ?? [];
  const underChallenge = Boolean(trial.breakSkeptic);
  const disputeTimeoutDays = 3; // DISPUTE_TIMEOUT, the contract's own constant — never "recall".

  const evidence = [
    trial.specCID
      ? { id: `spec-${trial.id}`, type: "Spec", source: "Sponsor's pinned spec", timestamp: trial.createdAt ? new Date(trial.createdAt * 1000).toISOString() : null, verified: null as boolean | null, artifactUrl: `/content/${encodeURIComponent(trial.specCID)}` }
      : null,
    trial.testsCID
      ? { id: `suite-${trial.id}`, type: "Suite", source: "Sponsor's pinned test suite", timestamp: trial.createdAt ? new Date(trial.createdAt * 1000).toISOString() : null, verified: null as boolean | null, artifactUrl: `/content/${encodeURIComponent(trial.testsCID)}` }
      : null,
    trial.runHash
      ? { id: `run-${trial.id}`, type: "Run artifact", source: "Agent's signed run", timestamp: trial.runAt ? new Date(trial.runAt * 1000).toISOString() : null, verified: null as boolean | null, artifactUrl: `/trials/${trial.id}/replay` }
      : null,
  ].filter((e): e is NonNullable<typeof e> => e !== null);

  return (
    <Chrome>
      <p className="kicker">Case · Trial {trial.id}</p>
      <h1 className="page-title">The Tribunal</h1>
      <span className="chip" data-tone={status.tone}>
        {status.label}
      </span>

      <div className="case-grid">
        {/* ── the charge: what was posted ─────────────────────────────── */}
        <section className="surface detail-panel case-panel" id="case-charge">
          <p className="case-panel__kicker">The charge</p>
          <div className="kv">
            <span className="kv__key">Sponsor</span>
            <span className="mono">{shortHash(trial.sponsor)}</span>
          </div>
          <div className="kv">
            <span className="kv__key">Reward</span>
            <span className="mono figures">{formatEth(trial.rewardEth)} ETH</span>
          </div>
          <div className="kv">
            <span className="kv__key">Agent bond</span>
            <span className="mono figures">{formatEth(trial.bondEth)} ETH</span>
          </div>
          <div className="kv">
            <span className="kv__key">Suite</span>
            <span className="mono" title={trial.testsDigest}>
              {trial.testsCID ? shortCid(trial.testsCID) : `${shortHash(trial.testsDigest)} — fingerprint only`}
            </span>
          </div>
          <div className="kv">
            <span className="kv__key">Spec</span>
            <span className="mono" title={trial.specDigest}>
              {trial.specCID ? shortCid(trial.specCID) : `${shortHash(trial.specDigest)} — fingerprint only`}
            </span>
          </div>
        </section>

        {/* ── the claim: who says it holds ────────────────────────────── */}
        <section className="surface detail-panel case-panel">
          <p className="case-panel__kicker">The claim</p>
          {trial.operator ? (
            <div className="kv">
              <span className="kv__key">Agent</span>
              <span className="mono">{shortHash(trial.operator)}</span>
            </div>
          ) : (
            <p className="hint hint--block">No agent has claimed this trial.</p>
          )}
          {trial.runHash ? (
            <>
              <div className="kv">
                <span className="kv__key">Run</span>
                <span className="mono">{shortHash(trial.runHash)}</span>
              </div>
              <div className="kv">
                <span className="kv__key">Submitted</span>
                <span className="mono">{trial.runAt ? formatWhen(trial.runAt * 1000) : "—"}</span>
              </div>
              <p className="hint">
                <Link href={`/trials/${trial.id}/replay`} data-tone="ember">
                  Replay the signed run
                </Link>
              </p>
            </>
          ) : (
            <p className="hint hint--block">Nothing on the anvil yet.</p>
          )}
        </section>

        {/* ── the challenge: what was tested ──────────────────────────── */}
        <section className="surface detail-panel case-panel">
          <p className="case-panel__kicker">The challenge</p>
          {underChallenge ? (
            <>
              <div className="kv">
                <span className="kv__key">Skeptic</span>
                <span className="mono">{shortHash(trial.breakSkeptic)}</span>
              </div>
              <div className="kv">
                <span className="kv__key">Stake</span>
                <span className="mono figures">{trial.breakStakeEth ? formatEth(trial.breakStakeEth) : "—"} ETH</span>
              </div>
              {breakLeft !== null ? (
                <div className="kv">
                  <span className="kv__key">Window</span>
                  <span className="mono">{formatDuration(breakLeft)} remaining</span>
                </div>
              ) : null}
            </>
          ) : (
            <p className="hint hint--block">No break filed against this claim. Anyone may stake against it while the trial is judging.</p>
          )}
        </section>

        {/* ── the committee: what the logs published ──────────────────── */}
        <section className="surface detail-panel case-panel">
          <p className="case-panel__kicker">The committee</p>
          {underChallenge ? (
            <>
              <div className="kv">
                <span className="kv__key">Seats sealed</span>
                <span className="mono figures">{committed.length}</span>
              </div>
              {committed.length > 0 ? (
                <p className="hint mono case-seats">{committed.map(shortHash).join(" · ")}</p>
              ) : null}
              <div className="kv">
                <span className="kv__key">Seats unsealed</span>
                <span className="mono figures">{revealed.length}</span>
              </div>
              {revealed.length > 0 ? (
                <p className="hint mono case-seats">{revealed.map(shortHash).join(" · ")}</p>
              ) : null}
              <p className="hint">
                Two of three settle it. If the panel never forms, {disputeTimeoutDays} days after the dispute opens
                the agent&apos;s pass stands.
              </p>
            </>
          ) : (
            <p className="hint hint--block">No dispute — there is no panel without a break.</p>
          )}
        </section>

        {/* ── the evidence: artifacts the sponsor disclosed ───────────── */}
        <section className="case-panel case-panel--wide">
          <EvidencePacket items={evidence} />
        </section>

        {/* ── the verdict: what it got ─────────────────────────────────── */}
        <section className="case-panel case-panel--wide">
          <VerdictPanel
            verdict={(trial.verdict as "none" | "paid" | "slashed" | "reclaimed") ?? "none"}
            rationale={
              trial.verdict === "paid"
                ? "The run survived every strike. The agent takes the reward."
                : trial.verdict === "slashed"
                  ? "The skeptic's proof held. The challenger takes 30% of the bond; the sponsor is refunded."
                  : trial.verdict === "reclaimed"
                    ? "No run arrived before the deadline. The reward returns to the sponsor."
                    : "No verdict yet — the claim awaits its window and, if broken, the committee."
            }
            reviewProcess={underChallenge ? "committee" : trial.runHash ? "automated" : undefined}
          />
        </section>
      </div>

      <div className="case-provenance">
        <StaleDataIndicator
          state={chainNowMs ? "live" : "cached"}
          lastUpdated={chainNowMs ? new Date(chainNowMs).toISOString() : undefined}
        />
        <Link href={`/trials/${trial.id}`} className="case-provenance__link">
          Open the full trial board →
        </Link>
      </div>
    </Chrome>
  );
}
