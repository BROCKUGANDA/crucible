"use client";

import { useState } from "react";
import Link from "next/link";
import type { TrialStatus } from "@crucible/indexer";
import { Chrome, Quenching, SignalLost } from "@/components/Chrome";
import { useSnapshot } from "@/lib/useSnapshot";
import { TRIALS_PAGE, windowed, windowLabel } from "@/lib/paging";
import { TrialCard } from "@/components/arena/TrialCard";
import { TrialSeal } from "@/components/arena/TrialSeal";
import { SearchPanel } from "@/components/arena/SearchPanel";
import { FilterBar } from "@/components/arena/FilterBar";
import { EmptyState } from "@/components/arena/EmptyState";
import { StaleDataIndicator } from "@/components/arena/StaleDataIndicator";

/**
 * The board of trials — the Arena listing.
 *
 * Real data from the snapshot stream: every trial, its status, reward, bond,
 * deadline, and verification method. Filtering, search, and pagination are real
 * client-side operations over the live snapshot — no simulated activity.
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
  const { data, error, loading, chainNowMs } = useSnapshot();
  const [active, setActive] = useState<TrialStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(TRIALS_PAGE);

  const all = data ? data.trials : [];
  const filtered = all.filter((t) => {
    const byStatus = active === "all" || t.status === active;
    const byQuery =
      !query ||
      String(t.id).includes(query) ||
      t.sponsor?.toLowerCase().includes(query.toLowerCase()) ||
      t.specDigest?.toLowerCase().includes(query.toLowerCase()) ||
      (t.specCID ?? "").toLowerCase().includes(query.toLowerCase());
    return byStatus && byQuery;
  });
  const page = windowed(filtered, shown);

  return (
    <Chrome>
      <header className="trials-head">
        <div className="trials-head__brand">
          <TrialSeal width="32" height="32" aria-label="Arena" />
          <h1 className="page-title">The Arena</h1>
          <p className="lede">Trials posted to the proving ground. Filter, search, and inspect.</p>
        </div>
        <div className="trials-head__actions">
          <SearchPanel placeholder="Search by id, sponsor, spec digest or CID" onSearch={setQuery} />
          <Link className="btn btn-primary" href="/trials/new">
            Post a trial
          </Link>
        </div>
      </header>

      <div className="trials-meta">
        <FilterBar
          options={FILTERS}
          activeKey={active}
          onChange={(key) => {
            setActive((key ?? "all") as TrialStatus | "all");
            setShown(TRIALS_PAGE);
          }}
          groupLabel="Filter trials by where they stand"
        />
        <div className="trials-meta__count">
          {data ? (
            <>
              <span className="mono figures">{data.counts.all ?? all.length}</span>{" "}
              trials posted ·
              <StaleDataIndicator
                state={chainNowMs ? "live" : "cached"}
                lastUpdated={chainNowMs ? new Date(chainNowMs).toISOString() : undefined}
              />
            </>
          ) : (
            <>
              <span className="mono figures">—</span> trials posted
            </>
          )}
        </div>
      </div>

      {loading ? (
        <Quenching label="reading the board from the chain…" />
      ) : (
        <>
          {error ? <SignalLost message={error} /> : null}

          {filtered.length === 0 ? (
            <EmptyState
              line={
                active === "all"
                  ? "Cold forge. No trials burning yet — a sponsor lights one, and the anvil fills."
                  : `No ${active} trials. The trials exist — they are simply elsewhere.`
              }
              cta={active === "all" ? "Post a trial" : "Show every trial"}
              href={active === "all" ? "/trials/new" : undefined}
            />
          ) : (
            <>
              <div className="trial-grid" id="trial-table">
                {page.visible.map((t) => (
                  <TrialCard key={t.id} trial={t} chainNowMs={chainNowMs ?? null} />
                ))}
              </div>

              <div className="board-foot">
                <p className="board-foot__count" aria-live="polite">
                  {windowLabel({ ...page, total: filtered.length })}
                </p>
                {page.hasMore ? (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setShown((s) => s + TRIALS_PAGE)}
                  >
                    Show {Math.min(TRIALS_PAGE, page.withheld)} more
                  </button>
                ) : null}
              </div>
            </>
          )}
        </>
      )}
    </Chrome>
  );
}
