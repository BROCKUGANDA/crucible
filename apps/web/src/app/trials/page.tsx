"use client";

import Link from "next/link";
import type { TrialStatus } from "@crucible/indexer";
import { Chrome, ColdForge, Quenching, SignalLost } from "@/components/Chrome";
import { TrialTable } from "@/components/TrialTable";
import { useSnapshot } from "@/lib/useSnapshot";

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

  const rows = data
    ? data.trials.filter((t) => t.status !== "open" || true)
    : [];

  return (
    <Chrome>
      <header className="trials-head">
        <h1 className="page-title">Trials</h1>
        <Link className="btn btn-primary" href="/trials/new">
          Light a trial
        </Link>
      </header>

      <nav aria-label="Filter trials" className="filter-row">
        {FILTERS.map((f) => (
          <span key={f.key} className="chip" data-tone="dim">
            {f.label}
            {data ? ` ${data.counts[f.key]}` : ""}
          </span>
        ))}
      </nav>

      {loading ? <Quenching label="quenching trials…" /> : null}
      {error ? <SignalLost message={error} /> : null}
      {data && rows.length === 0 ? (
        <ColdForge
          line="Cold forge. No trials burning yet."
          cta="Light the first one"
          href="/trials/new"
        />
      ) : null}
      {data && rows.length > 0 ? <TrialTable trials={rows} serverNowMs={serverNowMs} /> : null}
    </Chrome>
  );
}
