"use client";

import { useEffect, useState } from "react";
import type { ApiSnapshot } from "@crucible/indexer";

/**
 * Snapshot polling.
 *
 * The API's `now` is the server's clock, so countdowns are measured against that
 * rather than the browser's: a client with a skewed clock would otherwise show a
 * window that closed hours ago as still open.
 */

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8787";

export interface SnapshotState {
  data: ApiSnapshot | null;
  error: string | null;
  loading: boolean;
  /** server clock, ms — the reference for every countdown */
  serverNowMs: number | null;
}

export function useSnapshot(pollMs = 4000): SnapshotState {
  const [state, setState] = useState<SnapshotState>({
    data: null,
    error: null,
    loading: true,
    serverNowMs: null,
  });

  useEffect(() => {
    let alive = true;

    // 1. Try the live stream. EventSource reconnects on its own, so a dropped network
    //    self-heals rather than stranding the UI.
    let source: EventSource | null = null;
    try {
      source = new EventSource(`${API}/stream`);
      source.addEventListener("snapshot", (e) => {
        if (!alive) return;
        try {
          const data = JSON.parse((e as MessageEvent).data) as ApiSnapshot;
          setState({ data, error: null, loading: false, serverNowMs: data.now });
        } catch {
          // a malformed event is not a lost signal; wait for the next
        }
      });
      source.addEventListener("error", () => {
        if (!alive) return;
        setState((s) => ({
          ...s,
          error: "Your forge keeps working locally. Reconnecting…",
        }));
        // Fall through to polling fallback below if the stream stays down.
        source?.close();
        source = null;
        fallback();
      });
    } catch {
      fallback();
    }

    // 2. Polling fallback: used when EventSource is unavailable or the stream opened
    //    but never delivered. It is unreachable in the happy path, which is the point.
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    const controller = new AbortController();

    async function poll() {
      try {
        const res = await fetch(`${API}/snapshot`, { signal: controller.signal });
        if (!res.ok) throw new Error(`api responded ${res.status}`);
        const data = (await res.json()) as ApiSnapshot;
        if (alive) setState({ data, error: null, loading: false, serverNowMs: data.now });
      } catch (err) {
        if (!alive || (err as Error).name === "AbortError") return;
        setState((s) => ({
          ...s,
          error: "Your forge keeps working locally. Reconnecting…",
          loading: false,
        }));
      }
    }

      function fallback() {
      if (!alive || pollTimer) return;
      void poll();
      pollTimer = setInterval(poll, pollMs);
    }

    return () => {
      alive = false;
      source?.close();
      if (pollTimer) clearInterval(pollTimer);
      controller.abort();
    };
  }, [pollMs]);

  return state;
}

/**
 * Seconds until an absolute server-clock timestamp.
 *
 * `targetSeconds` is a unix epoch in seconds — `deadlineAt`, `breakWindowEndsAt` — never a
 * remaining duration. A duration in the payload is a fact about the instant the server built
 * it, and subtracting the server's `now` from it yields nonsense: this hook once received
 * `coolsInSec: 2587702` and rendered "cools in 0s", because 2587702 minus "now" is deeply
 * negative. Every countdown on the site read closed, including the skeptic window the whole
 * dispute mechanism depends on.
 *
 * Returns null when there is nothing to count down to, so a caller can render an em dash
 * instead of a misleading "0s".
 */
export function useCountdown(
  targetSeconds: number | null,
  serverNowMs: number | null,
): number | null {
  const [offsetSec, setOffsetSec] = useState(0);

  useEffect(() => {
    if (serverNowMs === null) return;
    // Re-anchor whenever a fresh snapshot arrives.
    setOffsetSec(0);
  }, [serverNowMs]);

  useEffect(() => {
    const t = setInterval(() => setOffsetSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  if (targetSeconds === null) return null;
  const base = serverNowMs === null ? Date.now() : serverNowMs;
  return Math.max(0, Math.floor(targetSeconds - base / 1000 - offsetSec));
}
