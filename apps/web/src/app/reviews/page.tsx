"use client";

import { useState } from "react";
import Link from "next/link";
import { Chrome, SignalLost } from "@/components/Chrome";
import { EmptyState, MetricCard, SectionHeader, StatusBadge } from "@/components/Primitives";
import { formatWei } from "@/lib/eth";
import {
  useReviewActions,
  useReviewQueue,
  type ReviewCase,
  type ReviewerState,
} from "@/lib/useReviewQueue";

/**
 * The review queue — the cases waiting for a reviewer.
 *
 * A reviewer reads the evidence, then says what they found. This page is
 * the queue of what is waiting, and the three things a reviewer may do
 * about a case: take it, step away from it, or declare a conflict of
 * interest with it.
 *
 * The queue shows what the reviewer MAY take. A case they are conflicted
 * with is not listed at all — the platform refuses it, and a queue that
 * merely displayed it would be advice a reviewer in a hurry ignores. A
 * refusal, when it comes, is shown with its reason: "you have a recorded
 * conflict of interest with this trial's sponsor" tells a reviewer
 * something a hidden case never could.
 */
export default function ReviewsPage() {
  // The actions come first: they carry the refresh token the queue reads.
  // Without it the page would show the state it fetched at mount and never
  // show the state the action produced — the reviewer would click "take
  // this case" and watch nothing happen.
  const actions = useReviewActions();
  const queue = useReviewQueue(actions.refreshToken);
  const cases = queue.kind === "ready" ? queue.value.cases : [];

  return (
    <Chrome>
      <p className="kicker">Review queue</p>
      <h1 className="page-title" id="reviews-panel">
        The cases waiting for a reviewer
      </h1>
      <p className="lede">
        A trial is open for review while it is being judged, and while a
        dispute against it is open — those are the windows in which the
        evidence exists and nobody has settled it. Take a case, step away
        from one, or declare that you have a conflict of interest with it.
      </p>

      {queue.kind === "loading" ? <p className="hint">Reading the queue…</p> : null}
      {queue.kind === "unreachable" ? (
        <SignalLost
          message={`The review queue could not be read. (${queue.message})`}
          what="the host"
        />
      ) : null}

      {queue.kind === "ready" && cases.length === 0 ? (
        <EmptyState
          title="Nothing is waiting for a reviewer"
          body="Cases appear here while a trial is being judged or disputed. An empty queue is the honest state, not a missing list."
        />
      ) : null}

      {cases.length > 0 ? (
        <>
          <SectionHeader
            title="Open cases"
            subtitle="One case, one reviewer. A case another reviewer holds is not yours to take."
          />
          <div className="stack">
            {cases.map((reviewCase) => (
              <CaseCard
                key={reviewCase.trialId}
                reviewCase={reviewCase}
                busy={actions.busy}
                onClaim={() => void actions.claim(reviewCase.trialId)}
                onAbstain={(reason) => void actions.abstain(reviewCase.trialId, reason)}
                onConflict={(description) =>
                  void actions.declareConflict(reviewCase.trialId, description)
                }
              />
            ))}
          </div>
        </>
      ) : null}

      {actions.error ? <p className="hint hint--error">{actions.error}</p> : null}

      {queue.kind === "ready" && queue.value.abstentions.length > 0 ? (
        <>
          <SectionHeader
            title="What you stepped away from"
            subtitle="Your own words, kept as you gave them."
          />
          <div className="stack">
            {queue.value.abstentions.map((entry) => (
              <article key={`${entry.trialId}`} className="surface detail-panel">
                <p className="detail-panel__label">
                  <span className="mono">trial {entry.trialId}</span>
                </p>
                <p>{entry.reason}</p>
              </article>
            ))}
          </div>
        </>
      ) : null}
    </Chrome>
  );
}

/** What the state of a case means, in words. */
function stateBadge(state: ReviewerState): { tone: "success" | "warning" | "pending" | "neutral"; label: string } {
  switch (state.kind) {
    case "yours":
      return { tone: "success", label: "You hold this case" };
    case "held":
      return { tone: "warning", label: "Another reviewer holds this case" };
    case "abstained":
      return { tone: "neutral", label: "You stepped away from this case" };
    default:
      return { tone: "pending", label: "Open" };
  }
}

/** One case in the queue. */
function CaseCard({
  reviewCase,
  busy,
  onClaim,
  onAbstain,
  onConflict,
}: {
  reviewCase: ReviewCase;
  busy: boolean;
  onClaim: () => void;
  onAbstain: (reason: string) => void;
  onConflict: (description: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [description, setDescription] = useState("");
  const badge = stateBadge(reviewCase.state);

  return (
    <article className="surface detail-panel" data-testid="review-case">
      <p className="detail-panel__label">
        <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>{" "}
        <span className="mono">trial {reviewCase.trialId}</span>
      </p>
      <h3 className="detail-panel__title">
        Sponsored by <span className="mono">{reviewCase.sponsor}</span>
      </h3>
      <div className="row">
        <MetricCard
          label="Reward"
          value={`${formatWei(BigInt(reviewCase.rewardWei))} ETH`}
          hint="test ETH worth nothing on this chain"
        />
        <MetricCard
          label="Agent"
          value={reviewCase.agent ?? "—"}
          hint={reviewCase.agent ? "the agent that was judged" : "no agent recorded yet"}
        />
        <MetricCard
          label="Disclosure"
          value={reviewCase.disclosed ? "Published" : "—"}
          hint={
            reviewCase.disclosed
              ? "the sponsor has published the suite"
              : "the sponsor has not published the suite yet"
          }
        />
      </div>
      <p className="hint">
        {reviewCase.status === "judging"
          ? "The trial is being judged."
          : "A dispute is open against this trial."}{" "}
        <Link className="mono" href={`/disputes/${reviewCase.trialId}`}>
          Read the sealed evidence
        </Link>
      </p>

      {reviewCase.state.kind === "open" ? (
        <div className="detail-panel">
          <button className="btn" type="button" disabled={busy} onClick={onClaim}>
            {busy ? "Working…" : "Take this case"}
          </button>

          <label className="detail-panel__label" htmlFor={`abstain-${reviewCase.trialId}`}>
            Or step away from it, and say why
          </label>
          <input
            id={`abstain-${reviewCase.trialId}`}
            className="input"
            value={reason}
            placeholder="I built the suite"
            onChange={(event) => setReason(event.target.value)}
          />
          <button
            className="btn"
            type="button"
            disabled={busy || reason.trim() === ""}
            onClick={() => onAbstain(reason)}
          >
            Step away
          </button>

          <label
            className="detail-panel__label"
            htmlFor={`conflict-${reviewCase.trialId}`}
          >
            Or declare a conflict of interest with it
          </label>
          <input
            id={`conflict-${reviewCase.trialId}`}
            className="input"
            value={description}
            placeholder="I work for the sponsor"
            onChange={(event) => setDescription(event.target.value)}
          />
          <button
            className="btn"
            type="button"
            disabled={busy || description.trim() === ""}
            onClick={() => onConflict(description)}
          >
            Declare the conflict
          </button>
          <p className="hint">
            A declared conflict is a record that outlives this session, and it
            bars you from this case and from every other case that sponsor
            runs.
          </p>
        </div>
      ) : null}

      {reviewCase.state.kind === "held" ? (
        <p className="hint">
          Another reviewer holds this case. It cannot be released by you.
        </p>
      ) : null}
      {reviewCase.state.kind === "yours" ? (
        <p className="hint">You hold this case. Read the sealed evidence before you say anything about it.</p>
      ) : null}
      {reviewCase.state.kind === "abstained" ? (
        <p className="hint">You stepped away from this case: {reviewCase.state.reason}</p>
      ) : null}
    </article>
  );
}
