"use client";

import { useMemo, useState, useEffect } from "react";
import { ARENA_STAGES, type ArenaEvent, type ArenaStage } from "@crucible/arena-events";

/**
 * Live trial room renderer (bible §16.10).
 *
 * Consumes a list of `ArenaEvent`s and renders the stage rail plus one card per event.
 * Pure presentation: no chain reads, no clock. The event stream (chain/indexer/Harena/Argus)
 * is fed in by the parent. Late joiners get a snapshot + the last `ROOM_BACKFILL_EVENTS`.
 */
const STAGE_LABEL: Record<ArenaStage, string> = {
  I: "Pignus",
  II: "Sacramentum",
  III: "Harena",
  IV: "Provocatio",
  V: "Sententia",
  VI: "Auctoritas",
  VII: "Ludi",
};

export function ArenaRoom({ events, trialId }: { events?: ArenaEvent[]; trialId?: string }) {
  const [liveEvents, setLiveEvents] = useState<ArenaEvent[]>(events ?? []);
  const allEvents = events ?? liveEvents;

  // Subscribe to the trial-scoped SSE stream (bible §16.10 transport).
  useEffect(() => {
    if (!trialId) return;
    const base = (process.env.NEXT_PUBLIC_API_URL as string) || "";
    const es = new EventSource(`${base}/trials/${encodeURIComponent(trialId)}/events`);
    es.addEventListener("snapshot", (msg) => {
      try {
        const body = JSON.parse((msg as MessageEvent).data);
        if (Array.isArray(body.events)) setLiveEvents(body.events as ArenaEvent[]);
      } catch {
        // ignore malformed frames
      }
    });
    return () => es.close();
  }, [trialId]);

  const [judgeMode, setJudgeMode] = useState(false);

  const activeStage = useMemo<ArenaStage | null>(() => {
    if (allEvents.length === 0) return null;
    const last = allEvents[allEvents.length - 1];
    return last ? last.stage : null;
  }, [allEvents]);

  return (
    <div className="arena-room">
      <nav className="arena-room__rail" aria-label="Stages">
        {ARENA_STAGES.map((s) => (
          <span
            key={s}
            className="arena-room__stage"
            data-active={activeStage === s ? "true" : "false"}
            title={STAGE_LABEL[s]}
          >
            {s} {STAGE_LABEL[s]}
          </span>
        ))}
      </nav>

      <div className="arena-room__toolbar">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setJudgeMode((v) => !v)}
          aria-pressed={judgeMode}
        >
          {judgeMode ? "Judge mode: on" : "Judge mode"}
        </button>
      </div>

      <ul className="arena-room__events">
        {allEvents.map((e) => (
          <li key={e.id} className="arena-room__event" data-kind={e.kind} data-mode={e.mode}>
            <span className="arena-room__kind">{e.kind}</span>
            {e.actor ? (
              <span className="arena-room__actor">
                {e.actor.role}: {e.actor.handle}
              </span>
            ) : null}
            {judgeMode && e.chainRef ? (
              <span className="arena-room__chain mono">
                {e.chainRef.caip2} · {e.chainRef.tx} · {e.chainRef.slotOrBlock} ·{" "}
                {e.chainRef.commitment}
              </span>
            ) : null}
            <span className="arena-room__at">{e.at}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
