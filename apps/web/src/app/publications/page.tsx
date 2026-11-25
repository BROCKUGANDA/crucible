"use client";

import { useState } from "react";
import Link from "next/link";
import { Chrome, SignalLost } from "@/components/Chrome";
import { EmptyState, MetricCard, SectionHeader, StatusBadge } from "@/components/Primitives";
import {
  agentLabel,
  formatBps,
  useComparison,
  usePublications,
  type PublishedMethod,
} from "@/lib/usePublications";

/**
 * The published methods — what was measured, and what it does not
 * establish.
 *
 * This page is the reading surface for a score. It shows the score, the
 * suite it was measured against, the rubric, the judge, the repetitions —
 * and, above all, the LIMITS. A number without its limits is a marketing
 * claim; the limits are what make it a measurement.
 *
 * The comparison at the bottom is the other half: two scores may be
 * compared only when they were measured the same way, and when they were
 * not, the page says so and says why. It never subtracts two numbers that
 * came from different suites.
 */
export default function PublicationsPage() {
  const publications = usePublications();
  const [left, setLeft] = useState<string | null>(null);
  const [right, setRight] = useState<string | null>(null);
  const { verdict, busy, error, compare } = useComparison();

  const cards = publications.kind === "ready" ? publications.value : [];

  return (
    <Chrome>
      <p className="kicker">Published methods</p>
      <h1 className="page-title" id="publications-panel">
        What was measured, and what it does not establish
      </h1>
      <p className="lede">
        Every published score carries the method it was measured with — the
        suite version, the rubric and its weights, the judge, the repetitions
        — and the things it does not prove. Read the limits before you read
        the number.
      </p>

      {publications.kind === "loading" ? <p className="hint">Reading the published methods…</p> : null}
      {publications.kind === "unreachable" ? (
        <SignalLost message={`The published methods could not be read. (${publications.message})`} what="the host" />
      ) : null}

      {publications.kind === "ready" && cards.length === 0 ? (
        <EmptyState
          title="Nothing has been published yet"
          body="A method is published when a trial has been run three times and the score has been agreed. Until then there is nothing to show — which is the honest state, not an empty list."
        />
      ) : null}

      {cards.length > 0 ? (
        <>
          <SectionHeader
            title="Published methods"
            subtitle="Newest first. Each card is content-addressed: what it says cannot change afterwards."
          />
          <div className="stack">
            {cards.map((card) => (
              <MethodCard key={card.id} card={card} />
            ))}
          </div>

          <SectionHeader
            title="Compare two scores"
            subtitle="Only scores measured the same way may be compared. The rest get an explicit refusal with a reason."
          />
          <div className="surface detail-panel">
            <div className="row">
              <Pick
                label="First"
                cards={cards}
                value={left}
                onPick={setLeft}
                exclude={right}
              />
              <Pick
                label="Second"
                cards={cards}
                value={right}
                onPick={setRight}
                exclude={left}
              />
            </div>
            <p className="hint">
              {cards.length < 2
                ? "Two published methods are needed for a comparison."
                : "Compare when both are chosen."}
            </p>
            {left && right ? (
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => void compare(left, right)}
              >
                {busy ? "Comparing…" : "Compare"}
              </button>
            ) : null}
            {error ? <p className="hint hint--error">{error}</p> : null}
            {verdict ? (
              <div className="detail-panel" data-testid="comparison-verdict">
                <p>
                  <StatusBadge tone={verdict.comparable ? "success" : "warning"}>
                    {verdict.comparable ? "Comparable" : "Not comparable"}
                  </StatusBadge>
                </p>
                <p className="hint">{verdict.reason}</p>
                {verdict.differences.length > 0 ? (
                  <ul className="hint">
                    {verdict.differences.map((difference) => (
                      <li key={difference}>{difference}</li>
                    ))}
                  </ul>
                ) : null}
                <div className="row">
                  <MetricCard
                    label={verdict.left.subject.id}
                    value={formatBps(verdict.left.aggregateBps)}
                    hint={`${verdict.left.limits} stated limit(s)`}
                  />
                  <MetricCard
                    label={verdict.right.subject.id}
                    value={formatBps(verdict.right.aggregateBps)}
                    hint={`${verdict.right.limits} stated limit(s)`}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      <p className="hint hint--block">
        The <Link className="mono" href="/studio">Evaluation Studio</Link> runs a
        measurement; this page is what the measurement turned into.
      </p>
    </Chrome>
  );
}

function Pick({
  label,
  cards,
  value,
  onPick,
  exclude,
}: {
  label: string;
  cards: PublishedMethod[];
  value: string | null;
  onPick: (id: string) => void;
  exclude: string | null;
}) {
  return (
    <div className="detail-panel">
      <p className="detail-panel__label">{label}</p>
      <select
        className="input"
        value={value ?? ""}
        onChange={(event) => onPick(event.target.value || "")}
        aria-label={label}
      >
        <option value="">Choose a published method…</option>
        {cards
          .filter((card) => card.id !== exclude)
          .map((card) => (
            <option key={card.id} value={card.id}>
              {card.subject.id} — {agentLabel(card)}
            </option>
          ))}
      </select>
    </div>
  );
}

/** One published method. */
function MethodCard({ card }: { card: PublishedMethod }) {
  const agreed = card.repetitions.agreed;
  return (
    <article className="surface detail-panel" data-testid="published-method">
      <p className="detail-panel__label">
        <StatusBadge tone={card.rubric.scoreStatus === "VERIFIED" ? "success" : "pending"}>
          {card.rubric.scoreStatus ?? "no score"}
        </StatusBadge>{" "}
        <span className="mono">{card.subject.id}</span>
      </p>
      <h3 className="detail-panel__title">
        <Link href={`/publications/${card.id}`}>{agentLabel(card)}</Link>
      </h3>
      <div className="row">
        <MetricCard
          label="Score"
          value={formatBps(card.rubric.aggregateBps)}
          hint={
            card.rubric.confidenceLowerBps !== null && card.rubric.confidenceUpperBps !== null
              ? `${formatBps(card.rubric.confidenceLowerBps)}–${formatBps(card.rubric.confidenceUpperBps)}`
              : "no interval published"
          }
        />
        <MetricCard
          label="Measured against"
          value={card.suite?.version ?? "—"}
          hint={card.suite ? `${card.suite.difficulty} · ${card.suite.evaluationProtocol}` : "no suite published"}
        />
        <MetricCard
          label="Repetitions"
          value={`${card.repetitions.performed} of ${card.repetitions.required}`}
          hint={agreed === null ? "not run" : agreed ? "agreed" : "did not agree"}
          tone={agreed === false ? "error" : agreed ? "success" : "neutral"}
        />
      </div>
      <p className="hint">
        {card.limits.length} stated limit{card.limits.length === 1 ? "" : "s"} — read them
        before the number. <Link className="mono" href={`/publications/${card.id}`}>Method card</Link>
      </p>
    </article>
  );
}
