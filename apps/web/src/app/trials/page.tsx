"use client";

import { useState } from "react";
import Link from "next/link";
import type { TrialStatus } from "@crucible/indexer";
import { Chrome, ColdForge, Quenching, SignalLost } from "@/components/Chrome";
import { TrialTable } from "@/components/TrialTable";
import { useSnapshot } from "@/lib/useSnapshot";

/**
 * The board of trials.
 *
 * The filter row used to be a strip of chips that were labelled "Filter trials" but selected
 * nothing: the chips were `<span>`s, and the row filter underneath was `t.status !== "open" ||
 * true`, which is always true — so every trial was always shown no matter what a reader tapped.
 * A control that looks like a filter and is not one is worse than no control: it teaches the
 * reader that nothing on this page responds to them. They are real buttons now, they set state,
 * and the list reads from that state.
 *
 * `settled` is labelled "Verified" here rather than "Settled": a settled trial is the thing a
 * first-time reader is looking for — the jobs that held up — and `statusMeta` already calls a
 * settled trial "Settled" on the row itself, so the filter and the row would otherwise use two
 * words for the one state.
 */
const FILTERS: { key: TrialStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "assigned", label: "At the anvil" },
  { key: "judging", label: "Judging" },
  { key: "challenged", label: "Challenged" },
  { key: "settled", label: "Verified" },
];

export default function TrialsPage() {
  const { data, error, loading, serverNowMs } = useSnapshot();
  const [active, setActive] = useState<TrialStatus | "all">("all");

  const rows = data ? data.trials.filter((t) => active === "all" || t.status === active) : [];

  return (
    <Chrome>
      <header className="trials-head">
        <h1 className="page-title">Trials</h1>
        <Link className="btn btn-primary" href="/trials/new">
          Light a trial
        </Link>
      </header>

      <div className="filter-row" role="group" aria-label="Filter trials by where they stand">
        {FILTERS.map((f) => {
          const count = data ? data.counts[f.key] : null;
          const selected = f.key === active;
          return (
            <button
              key={f.key}
              type="button"
              className="filter-chip"
              data-selected={selected || undefined}
              aria-pressed={selected}
              onClick={() => setActive(f.key)}
            >
              {f.label}
              {count !== null ? <span className="filter-chip__count">{count}</span> : null}
            </button>
          );
        })}
      </div>

      {loading ? <Quenching label="quenching trials…" /> : null}
      {error ? <SignalLost message={error} /> : null}
      {data && rows.length === 0 && active === "all" ? (
        <ColdForge
          line="Cold forge. No trials burning yet — a sponsor lights one, and the anvil fills."
          cta="Light the first one"
          href="/trials/new"
        />
      ) : null}
      {data && rows.length === 0 && active !== "all" ? (
        // A filter that matches nothing is not a cold forge — the trials exist, they are
        // simply elsewhere. The clear-the-filter button is a real action here, so a reader is
        // never stranded on an empty tab with no way back to the whole board.
        <div className="surface cold-forge">
          <p className="cold-forge__line">{emptyFor(active)}</p>
          <button type="button" className="btn btn-primary" onClick={() => setActive("all")}>
            Show every trial
          </button>
        </div>
      ) : null}
      {data && rows.length > 0 ? <TrialTable trials={rows} serverNowMs={serverNowMs} /> : null}
    </Chrome>
  );
}

/**
 * A filtered list coming back empty is a different sentence from a forge with nothing in it:
 * the trials exist, they are simply not in this state. Saying which — and what the state means —
 * is what makes the empty state read as designed rather than broken.
 */
function emptyFor(active: TrialStatus | "all"): string {
  switch (active) {
    case "open":
      return "No open trials. Every job here has been claimed — new ones appear when a sponsor lights one.";
    case "assigned":
      return "Nothing is at the anvil right now — no claimed trial is waiting on its work.";
    case "judging":
      return "Nothing is being judged — no handed-in run is inside its skeptic window.";
    case "challenged":
      return "No trial is under challenge — no run has been broken and sent to the committee.";
    case "settled":
      return "Nothing has settled yet. Paid and caught trials are recorded here as they quench.";
    default:
      return "Cold forge. No trials burning yet.";
  }
}
