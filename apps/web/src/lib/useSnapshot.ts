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
    const controller = new AbortController();

    async function load() {
      try {
        const res = await fetch(`${API}/snapshot`, { signal: controller.signal });
        if (!res.ok) throw new Error(`api responded ${res.status}`);
        const data = (await res.json()) as ApiSnapshot;
        if (alive) {
          setState({ data, error: null, loading: false, serverNowMs: data.now });
        }
      } catch (err) {
        if (!alive) return;
        if ((err as Error).name === "AbortError") return;
        setState((s) => ({
          ...s,
          error: "Signal lost — your forge keeps working locally. Reconnecting…",
          loading: false,
        }));
      }
    }

    void load();
    const timer = setInterval(load, pollMs);
    return () => {
      alive = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [pollMs]);

  return state;
}

/**
 * Seconds until an absolute server-clock timestamp.
 *
 * Returns null when there is nothing to count down to, so a caller can render an
 * em dash instead of a misleading "0s".
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
