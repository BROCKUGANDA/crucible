"use client";

import { formatDuration, phaseLabel, turnRows, type StsTurn } from "@/lib/sts";

/**
 * The turn monitor.
 *
 * A conversation is a series of exchanges, and this panel reads them: what the
 * visitor said, what Frenchy said, and what each step cost. The durations are the
 * host's measurements, not the client's estimates, and a step that did not run
 * shows a dash rather than a zero — a step that never happened did not take no
 * time, and printing `0 ms` for it would be a number the panel does not have.
 */
export function TurnMonitor({
  turns,
  phase,
  error,
}: {
  turns: StsTurn[];
  phase: string | null;
  error?: string | null;
}) {
  const rows = turnRows(turns);

  return (
    <section className="surface detail-panel" aria-labelledby="turn-monitor">
      <p className="kicker" id="turn-monitor">
        Turn monitor
      </p>
      <h2 className="page-title">The conversation, turn by turn</h2>

      <p className="kv">
        <span className="kv__key">Now</span>
        <span className="badge badge--info" data-phase={phase ?? "unknown"}>
          {phaseLabel(phase)}
        </span>
      </p>

      {error ? (
        <p className="hint hint--block" role="status">
          {error}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="hint">
          Nothing has been said yet. The turns appear here as they are spoken.
        </p>
      ) : (
        <ol className="turn-monitor">
          {rows.map((row) => (
            <li key={row.id} className="turn-monitor__row" data-outcome={row.outcome}>
              <p className="kv">
                <span className="kv__key">Turn</span>
                <span className="mono">{row.id}</span>
              </p>
              <p className="kv">
                <span className="kv__key">You said</span>
                <span>{row.userText ?? "—"}</span>
              </p>
              <p className="kv">
                <span className="kv__key">Frenchy said</span>
                <span>{row.agentText ?? "—"}</span>
              </p>
              <p className="kv">
                <span className="kv__key">Took</span>
                <span className="mono">{formatDuration(row.totalMs)}</span>
              </p>
              <ul className="turn-monitor__steps">
                {row.steps.map((step) => (
                  <li key={step.label}>
                    <span className="turn-monitor__step-label">{step.label}</span>
                    <span className="mono">{formatDuration(step.ms)}</span>
                  </li>
                ))}
              </ul>
              {row.running ? (
                <p className="hint">
                  <span className="badge badge--pending">in flight</span> This turn has not
                  finished, so its cost is not known yet.
                </p>
              ) : null}
              {row.outcome === "failed" && row.reason ? (
                <p className="hint">
                  <span className="badge badge--warning">failed</span> {row.reason}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
