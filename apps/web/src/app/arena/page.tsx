"use client";

import { useEffect, useState } from "react";
import { Chrome } from "@/components/Chrome";
import { API_BASE } from "@/lib/apiBase";
import { arenaView, type ArenaView } from "@/lib/arena-view";

/**
 * The Arena — the v2 law, at a URL.
 *
 * Until this page existed the second economic law had no surface at all, which is why a third
 * external brief kept arriving to "fix" the fee: a reader saw 5% and nothing else (ADR-0019).
 * The two rates price different risks for different payers, and this is where that is said out
 * loud instead of argued in a document.
 */
export default function ArenaPage() {
  const [view, setView] = useState<ArenaView | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_BASE}/arena`, { signal: controller.signal, headers: { accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((payload) => setView(arenaView(payload)))
      .catch(() => {
        if (!controller.signal.aborted) setView(arenaView(null));
      });
    return () => controller.abort();
  }, []);

  return (
    <Chrome>
      <p className="kicker">The second law</p>
      <h1 className="page-title">Arena</h1>
      <p className="hint hint--block">
        The arena sits beside the original escrow rather than replacing it. Its fee is charged to
        the sponsor when a trial is posted, and returned with the reward if the trial is broken,
        cancelled, expired or decided without quorum. The escrow&apos;s 5% is a different law: taken
        from the agent&apos;s payout, only when a run holds.
      </p>

      {view === null ? <p className="hint">Reading the arena…</p> : null}

      {view?.kind === "unread" ? (
        <div className="surface detail-panel">
          <p className="kv">
            <span className="kv__key">Arena</span>
            <span className="mono">not read</span>
          </p>
          <p className="hint">{view.detail} Nothing here is a measurement of zero.</p>
        </div>
      ) : null}

      {view?.kind === "not-projected" ? (
        <div className="surface detail-panel">
          <p className="kv">
            <span className="kv__key">Arena</span>
            <span className="mono">not on this host</span>
          </p>
          <p className="hint">
            This deployment indexes no arena ({view.reason}). The contracts exist and are tested;
            what is missing is an address for this host to read.
          </p>
        </div>
      ) : null}

      {view?.kind === "empty" ? (
        <div className="surface detail-panel">
          <p className="kv">
            <span className="kv__key">Arena</span>
            <span className="mono">read · 0 trials</span>
          </p>
          <p className="hint">{view.detail}</p>
        </div>
      ) : null}

      {view?.kind === "list" ? (
        <div className="surface detail-panel">
          <p className="kv">
            <span className="kv__key">Arena</span>
            <span className="mono">read · {view.count} trials</span>
          </p>
          <table className="table">
            <caption className="hint">Every value below was read from this host&apos;s projection.</caption>
            <thead>
              <tr>
                <th scope="col">Trial</th>
                <th scope="col">State</th>
                <th scope="col">Reward</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row, i) => (
                <tr key={`${row.id}-${i}`}>
                  <td className="mono">#{row.id}</td>
                  <td>{row.state}</td>
                  <td className="mono">{row.reward}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Chrome>
  );
}
