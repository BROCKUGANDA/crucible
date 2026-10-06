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
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ fontSize: 28, margin: 0 }}>Trials</h1>
        <Link className="btn btn-primary" href="/trials/new">
          Light a trial
        </Link>
      </header>

      <nav
        aria-label="Filter trials"
        style={{ display: "flex", gap: 8, margin: "24px 0", flexWrap: "wrap" }}
      >
        {FILTERS.map((f) => (
          <span key={f.key} className="chip" style={{ color: "var(--dim)" }}>
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
