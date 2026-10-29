"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ApiSnapshot } from "@crucible/indexer";
import { ColdForge, Quenching, SignalLost } from "@/components/Chrome";
import { useSnapshot } from "@/lib/useSnapshot";
import { heroBoardFrom, heroBondLine, type HeroBoard } from "@/lib/hero-board";
import { TrialTable } from "@/components/TrialTable";
import { API_BASE } from "@/lib/apiBase";

/**
 * The live trial ticker on the landing page. A separate client component so the
 * rest of the page stays server-rendered and prerenders without the API.
 */
export function LiveFeedInner() {
  const { data, error, loading, chainNowMs } = useSnapshot();

  if (loading) return <Quenching label="quenching trials…" />;
  if (error) return <SignalLost message={error} />;

  if (data && data.trials.length === 0) {
    return (
      <ColdForge
        line="Cold forge. No trials burning yet."
        cta="Light the first one"
        href="/trials/new"
      />
    );
  }

  if (!data) {
    return (
      <div className="surface feed-fallback">
        <p>
          <Link href="/trials" data-tone="ember">
            See every trial
          </Link>{" "}
          — or light the first one.
        </p>
      </div>
    );
  }

  return <TrialTable trials={data.trials.slice(0, 5)} chainNowMs={chainNowMs} />;
}

type HeroRead = { status: "pending" } | { status: "lost" } | { status: "ok"; board: HeroBoard };

/**
 * The hero's preview card — one trial the visitor could actually claim, or the truth about why
 * there is none to show.
 *
 * Deliberately not `useSnapshot`. That hook keeps an EventSource open for as long as it is
 * mounted, and this page already runs one further down; a second one per visitor would double
 * the long-lived connections on the busiest page in the deployment to decorate a card that moves
 * as often as the board does. One read on mount, and the ticker stays the live one.
 */
export function HeroBoardPreview() {
  const [read, setRead] = useState<HeroRead>({ status: "pending" });

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_BASE}/snapshot`, { signal: controller.signal, headers: { accept: "application/json" } })
      .then((res) => (res.ok ? (res.json() as Promise<ApiSnapshot>) : Promise.reject(new Error(String(res.status)))))
      .then((payload) => setRead({ status: "ok", board: heroBoardFrom(payload) }))
      .catch(() => {
        // An abort is this effect cleaning itself up, not a lost board.
        if (!controller.signal.aborted) setRead({ status: "lost" });
      });
    return () => controller.abort();
  }, []);

  if (read.status === "pending") return <Quenching label="reading the board…" />;
  if (read.status === "lost") return <SignalLost message="The board was not read." />;

  const board = read.board;
  if (board.kind === "unread") return <SignalLost message="The board was not read." />;
  if (board.kind === "empty")
    return (
      <ColdForge
        line="Nothing is open to claim right now."
        cta="See every trial"
        href="/trials"
      />
    );

  return (
    <>
      <p className="arena__sub">Live on the board</p>
      <div className="arena__preview__row">
        <span className="arena__preview__id">#{board.id}</span>
        <span className="arena__preview__reward">
          {board.reward} <span className="trial-row__unit">reward</span>
        </span>
        <span className="chip" data-tone={board.tone}>
          {board.status}
        </span>
      </div>
      <p className="arena__preview__hint">
        {heroBondLine(board.bond)} · {board.spec} ·{" "}
        <Link href={board.href} data-tone="ember">
          read what it names
        </Link>
      </p>
    </>
  );
}
