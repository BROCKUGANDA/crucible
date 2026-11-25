"use client";

import { useState } from "react";
import Link from "next/link";
import { Chrome, SignalLost } from "@/components/Chrome";
import { EmptyState, MetricCard, SectionHeader, StatusBadge } from "@/components/Primitives";
import { formatBps, useEvidenceBundle, useEvidenceBundles } from "@/lib/useEvidenceBundles";

/**
 * The frozen evidence of a dispute.
 *
 * This is the page a committee reads before deciding. It shows, in order:
 *
 *   - the bundles sealed for the trial, and whether each one predates the
 *     dispute (a bundle sealed afterwards is not the evidence the parties
 *     saw, and the page says so);
 *   - the bundle's CONTENT: what the chain committed to, what the platform
 *     measured, the replays and whether they agreed;
 *   - and the GAPS: what the bundle does not contain.
 *
 * The gaps are shown before the contents, on purpose. A reader who sees
 * "the sponsor has not disclosed the suite" first will read the rest
 * accordingly.
 */
export function DisputeEvidence({ trialId }: { trialId: string }) {
  const summaries = useEvidenceBundles(trialId);
  const [selected, setSelected] = useState<string | null>(null);

  const list = summaries.kind === "ready" ? summaries.value : [];
  const activeId = selected ?? list[0]?.id ?? null;
  const detail = useEvidenceBundle(activeId);

  return (
    <Chrome>
      <p className="kicker">Dispute evidence</p>
      <h1 className="page-title" id="dispute-evidence-panel">
        The frozen evidence of trial {trialId}
      </h1>
      <p className="lede">
        A bundle is a freeze: what the chain committed to, what the platform
        measured, and what is missing from it. It is content-addressed, so
        it cannot be edited afterwards — and the gaps are part of it.
      </p>

      {summaries.kind === "loading" ? <p className="hint">Reading the bundles…</p> : null}
      {summaries.kind === "unreachable" ? (
        <SignalLost
          message={`The bundles could not be read. (${summaries.message})`}
          what="the host"
        />
      ) : null}
      {summaries.kind === "ready" && list.length === 0 ? (
        <EmptyState
          title="No bundle has been sealed for this trial"
          body="A bundle is sealed when a dispute opens. Until then there is nothing frozen, which is the honest state — not an empty list that reads as 'the evidence was checked and found empty'."
        />
      ) : null}

      {list.length > 0 ? (
        <>
          <SectionHeader
            title="Bundles"
            subtitle="Oldest first. Each address is the digest of the bundle's own contents."
          />
          <div className="surface detail-panel">
            <ul className="hint">
              {list.map((summary) => (
                <li key={summary.id}>
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    onClick={() => setSelected(summary.id)}
                    aria-current={summary.id === activeId ? "true" : undefined}
                  >
                    <span className="mono">{summary.id}</span>
                  </button>{" "}
                  — {summary.gaps} stated gap(s) —{" "}
                  {summary.predatesDispute === null ? (
                    <StatusBadge tone="neutral">the chain has not said when the dispute opened</StatusBadge>
                  ) : summary.predatesDispute ? (
                    <StatusBadge tone="success">sealed before the break</StatusBadge>
                  ) : (
                    <StatusBadge tone="warning">sealed after the break</StatusBadge>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {detail.state === "loading" ? <p className="hint">Reading the bundle…</p> : null}
          {detail.state === "unreachable" ? (
            <SignalLost message="The bundle could not be read." what="the host" />
          ) : null}

          {detail.bundle ? (
            <>
              <SectionHeader
                title="What this bundle does not contain"
                subtitle="Stated in the bundle itself. An omission is not a completeness."
              />
              <div className="surface detail-panel">
                <ul className="limits-list" data-testid="bundle-gaps">
                  {detail.bundle.gaps.length === 0 ? (
                    <li>Nothing is missing from this bundle.</li>
                  ) : (
                    detail.bundle.gaps.map((gap, index) => <li key={`${index}-${gap.slice(0, 24)}`}>{gap}</li>)
                  )}
                </ul>
              </div>

              <SectionHeader title="What the chain said" />
              <div className="surface detail-panel">
                {detail.bundle.chain ? (
                  <>
                    <p className="hint">
                      Sponsor <span className="mono">{detail.bundle.chain.sponsor ?? "not published"}</span>{" "}
                      · status {detail.bundle.chain.status ?? "not published"} · verdict{" "}
                      {detail.bundle.chain.verdict ?? "not published"}
                    </p>
                    <p className="hint">
                      Committed spec digest{" "}
                      <span className="mono">{detail.bundle.chain.specDigest ?? "not published"}</span>
                    </p>
                    <p className="hint">
                      Disclosed suite <span className="mono">{detail.bundle.chain.disclosedSpecCid ?? "not disclosed"}</span>
                    </p>
                    <p className="hint">
                      The break:{" "}
                      {detail.bundle.chain.breakSkeptic ? (
                        <>
                          filed by <span className="mono">{detail.bundle.chain.breakSkeptic}</span>, proof{" "}
                          <span className="mono">{detail.bundle.chain.breakProofCid ?? "not disclosed"}</span>
                        </>
                      ) : (
                        "no break has been filed"
                      )}
                    </p>
                  </>
                ) : (
                  <p className="hint">
                    The chain&apos;s facts are not in this bundle: the trial is not known to the chain
                    reader, so nothing here is a chain reading.
                  </p>
                )}
              </div>

              <SectionHeader title="What the platform measured" />
              <div className="row">
                <MetricCard
                  label="Score"
                  value={formatBps(detail.bundle.measurement.aggregateBps)}
                  hint={
                    detail.bundle.measurement.scoreStatus
                      ? detail.bundle.measurement.scoreStatus.toLowerCase()
                      : "no score recorded"
                  }
                />
                <MetricCard
                  label="Replays"
                  value={`${detail.bundle.measurement.replays.length} recorded`}
                  hint={
                    detail.bundle.measurement.replaysAgreed === null
                      ? "nothing to compare"
                      : detail.bundle.measurement.replaysAgreed
                        ? "agreed"
                        : "did not agree"
                  }
                  tone={detail.bundle.measurement.replaysAgreed === false ? "error" : "neutral"}
                />
                <MetricCard
                  label="Dimensions"
                  value={`${detail.bundle.measurement.dimensions.length}`}
                  hint="scored dimensions"
                />
              </div>

              {detail.bundle.measurement.replays.length > 0 ? (
                <div className="surface detail-panel">
                  <h3 className="detail-panel__title">Replays</h3>
                  <ul className="hint">
                    {detail.bundle.measurement.replays.map((replay) => (
                      <li key={`${replay.manifestId}-${replay.replayNumber}`}>
                        #{replay.replayNumber} — {replay.workerIdentity} — {replay.status} —{" "}
                        <span className="mono">{replay.outputDigest ?? "no output recorded"}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="surface detail-panel">
                <h3 className="detail-panel__title">Address</h3>
                <p className="hint">
                  <span className="mono">{detail.bundle.id}</span>
                </p>
                <p className="hint">
                  Digest: <span className="mono">{detail.bundle.digest}</span>
                </p>
                <p className="hint">
                  <StatusBadge tone="neutral">content-addressed</StatusBadge> A bundle cannot be
                  edited: any change produces a different address.
                </p>
              </div>
            </>
          ) : null}
        </>
      ) : null}

      <p className="hint hint--block">
        <Link className="mono" href={`/trials/${trialId}`}>
          The trial
        </Link>{" "}
        ·{" "}
        <Link className="mono" href="/publications">
          Published methods
        </Link>{" "}
        ·{" "}
        {/* The queue of the cases waiting for a reviewer. A case that is
            open for review is a case whose evidence exists and nobody has
            settled it. */}
        <Link className="mono" href="/reviews">
          Review queue
        </Link>
      </p>
    </Chrome>
  );
}
