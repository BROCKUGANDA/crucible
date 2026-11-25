"use client";

import Link from "next/link";
import { Chrome, SignalLost } from "@/components/Chrome";
import { EmptyState, MetricCard, SectionHeader, StatusBadge } from "@/components/Primitives";
import { agentLabel, formatBps, usePublication } from "@/lib/usePublications";

/**
 * One published method — the method card of a score.
 *
 * This page is the thing a reader of a number is meant to read BEFORE the
 * number: what was measured, how, how many times, and what the result does
 * not establish.
 *
 * The card is content-addressed. The address at the bottom is not a
 * decoration: it is the digest of everything above, and it is what makes a
 * published method impossible to edit after the fact.
 */
export function PublicationDetail({ id }: { id: string }) {
  const state = usePublication(id);
  const card = state.kind === "ready" ? state.value[0] : undefined;

  return (
    <Chrome>
      <p className="kicker">Published method</p>

      {state.kind === "loading" ? <p className="hint">Reading the method…</p> : null}
      {state.kind === "unreachable" ? (
        <SignalLost message={`The published method could not be read. (${state.message})`} what="the host" />
      ) : null}
      {state.kind === "ready" && !card ? (
        <EmptyState
          title="No such publication"
          body="Nothing is published under this address. A published method is content-addressed, so it either exists under exactly this address or it does not exist at all."
        />
      ) : null}

      {card ? (
        <>
          <h1 className="page-title" id="publication-card">
            {agentLabel(card)}
          </h1>
          <p className="lede">
            A score of {formatBps(card.rubric.aggregateBps)} measured by{" "}
            {card.suite ? `${card.suite.name} ${card.suite.version}` : "a pinned measurement with no suite"}.
          </p>

          <SectionHeader
            title="What this score does not establish"
            subtitle="These are derived from the measurement, not written by hand. They are the reason the number is a measurement and not a claim."
          />
          <div className="surface detail-panel">
            <ul className="limits-list" data-testid="publication-limits">
              {card.limits.map((limit, index) => (
                <li key={`${index}-${limit.slice(0, 24)}`}>{limit}</li>
              ))}
            </ul>
          </div>

          <SectionHeader title="How it was measured" />
          <div className="row">
            <MetricCard
              label="Score"
              value={formatBps(card.rubric.aggregateBps)}
              hint={
                card.rubric.confidenceLowerBps !== null && card.rubric.confidenceUpperBps !== null
                  ? `${formatBps(card.rubric.confidenceLowerBps)}–${formatBps(card.rubric.confidenceUpperBps)} over ${card.rubric.sampleCount} sample(s)`
                  : "no interval published"
              }
              tone={card.rubric.scoreStatus === "VERIFIED" ? "success" : "neutral"}
            />
            <MetricCard
              label="Status"
              value={card.rubric.scoreStatus ?? "—"}
              hint={`rubric ${card.rubric.status.toLowerCase()}`}
            />
            <MetricCard
              label="Repetitions"
              value={`${card.repetitions.performed} of ${card.repetitions.required}`}
              hint={
                card.repetitions.agreed === null
                  ? "not run"
                  : card.repetitions.agreed
                    ? "agreed"
                    : "did not agree"
              }
              tone={card.repetitions.agreed === false ? "error" : "success"}
            />
          </div>

          <div className="surface detail-panel">
            <h3 className="detail-panel__title">Suite</h3>
            {card.suite ? (
              <>
                <p className="hint">
                  {card.suite.name} — version {card.suite.version} — {card.suite.difficulty} ·{" "}
                  {card.suite.evaluationProtocol}
                </p>
                <p className="hint">
                  Digest: <span className="mono">{card.suite.specDigest || "not published"}</span>
                </p>
                {card.suite.knownLimitations ? (
                  <p className="hint">The suite&apos;s own limitations: {card.suite.knownLimitations}</p>
                ) : null}
              </>
            ) : (
              <p className="hint">No suite is published for this measurement.</p>
            )}
            <p className="hint">
              What was measured: <span className="mono">{card.measurementKey}</span> (pinned by{" "}
              {card.measurementKeySource === "spec" ? "the evaluation spec" : "the manifest"})
            </p>
          </div>

          <div className="surface detail-panel">
            <h3 className="detail-panel__title">Rubric</h3>
            <p className="hint">
              {card.rubric.name || card.rubric.rubricId || "no rubric published"} —{" "}
              {card.rubric.dimensions.length} dimension(s)
            </p>
            {card.rubric.dimensions.length === 0 ? (
              <p className="hint">No dimension weights are published.</p>
            ) : (
              <ul className="hint">
                {card.rubric.dimensions.map((dimension) => (
                  <li key={dimension.dimension}>
                    <strong>{dimension.dimension}</strong> — weight{" "}
                    {(dimension.weightBps / 100).toFixed(0)}% — score{" "}
                    {formatBps(dimension.scoreBps)}
                    {dimension.methodology ? ` — ${dimension.methodology}` : " — no methodology published"}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="surface detail-panel">
            <h3 className="detail-panel__title">Judge</h3>
            <p className="hint">
              Version {card.judge.judgeVersion ?? "not published"} · runtime{" "}
              <span className="mono">{card.judge.runtimeImageDigest ?? "not published"}</span>
            </p>
            {card.judge.modelId ? <p className="hint">Model: {card.judge.modelId}</p> : null}
          </div>

          <div className="surface detail-panel">
            <h3 className="detail-panel__title">Repetitions</h3>
            <p className="hint">{card.repetitions.agreementRule}</p>
            {card.repetitions.replays.length === 0 ? (
              <p className="hint">No repetition has been recorded.</p>
            ) : (
              <ul className="hint">
                {card.repetitions.replays.map((replay) => (
                  <li key={replay.replayNumber}>
                    #{replay.replayNumber} — {replay.workerIdentity} — {replay.status} —{" "}
                    <span className="mono">{replay.outputDigest ?? "no output recorded"}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="surface detail-panel">
            <h3 className="detail-panel__title">Address</h3>
            <p className="hint">
              <span className="mono">{card.id}</span>
            </p>
            <p className="hint">
              Digest of this method: <span className="mono">{card.digest}</span>
            </p>
            <p className="hint">
              Comparability key: <span className="mono">{card.comparabilityKey}</span>
            </p>
            <p className="hint">
              <StatusBadge tone="neutral">content-addressed</StatusBadge> A published method
              cannot be edited: any change produces a different address.
            </p>
          </div>

          <p className="hint hint--block">
            <Link className="mono" href="/publications">
              All published methods
            </Link>{" "}
            ·{" "}
            <Link className="mono" href="/studio">
              Evaluation Studio
            </Link>
          </p>
        </>
      ) : null}
    </Chrome>
  );
}
