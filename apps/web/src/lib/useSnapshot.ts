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

/** Where the browser reaches the API. Baked into the bundle at build time. */
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8787";

/**
 * How long the live stream gets to deliver its first frame before the page
 * stops waiting on it.
 *
 * A stream that opens and then says nothing is the failure this exists for: a
 * proxy that buffers the response, an API that cannot read the chain yet, a
 * quiet socket. The browser reports no error in any of those cases — the
 * connection is simply open and empty — so a client that only falls back on
 * an error sits on its loading state for as long as the socket lives.
 */
const FIRST_FRAME_TIMEOUT_MS = 4_000;

/**
 * How often the polling fallback asks for a snapshot once the stream has not
 * proven itself.
 *
 * Deliberately slower than the stream's own tick: the fallback exists for the
 * case where the push channel is dead, and a fallback that then hammers the
 * API at the live rate would turn a degraded connection into a rate-limited
 * one — which is the failure a visitor would actually notice.
 */
const FALLBACK_POLL_MS = 15_000;

export interface SnapshotState {
  data: ApiSnapshot | null;
  error: string | null;
  loading: boolean;
  /** server clock, ms — the reference for every countdown */
  serverNowMs: number | null;
}

export function useSnapshot(pollMs = FALLBACK_POLL_MS): SnapshotState {
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
    let streamDelivered = false;
    let firstFrameTimer: ReturnType<typeof setTimeout> | undefined;

    // 2. Polling. It starts now rather than on the stream's first error, because the
    //    error is the part that does not arrive. A stream that opens and then says
    //    nothing — buffered by a proxy, or an API that cannot read the chain yet — never
    //    raises one, and the page would sit on "weighing the alloy…" until the socket
    //    died. Polling until the stream proves itself keeps the first paint real and
    //    costs nothing once the stream is live: the interval is cleared the moment the
    //    first frame lands.
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    const controller = new AbortController();

    async function poll() {
      try {
        const res = await fetch(`${API}/snapshot`, { signal: controller.signal });
        if (res.status === 429) {
          // The API is rate limiting this client. It says how long to wait, and
          // the answer is worth believing: a client that ignores it and keeps
          // asking is the reason it is limited. The reader is told the truth
          // rather than a generic "reconnecting", because the two have
          // different causes and different remedies.
          const retryAfterMs = Number(res.headers.get("retry-after") ?? "1") * 1000;
          if (alive) {
            setState(s => ({
              ...s,
              error: "The forge is busy — too many readers at once. Retrying shortly.",
              loading: false,
            }));
          }
          await new Promise((r) => setTimeout(r, Math.max(1000, retryAfterMs)));
          return;
        }
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

    function startPolling(intervalMs: number) {
      if (!alive || pollTimer) return;
      void poll();
      pollTimer = setInterval(poll, intervalMs);
    }

    function stopPolling() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    }

    // The first poll is immediate: it is the only thing that guarantees the page
    // has something to render. It is a single request, not a poll loop — the
    // interval only starts if the stream fails to prove itself.
    void poll();

    try {
      source = new EventSource(`${API}/stream`);
      source.addEventListener("snapshot", (e) => {
        if (!alive) return;
        try {
          const data = JSON.parse((e as MessageEvent).data) as ApiSnapshot;
          streamDelivered = true;
          if (firstFrameTimer) {
            clearTimeout(firstFrameTimer);
            firstFrameTimer = undefined;
          }
          // The stream is live, so the polling fallback has nothing left to do.
          stopPolling();
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
        // EventSource has already given up on this attempt; polling carries the page.
        source?.close();
        source = null;
        startPolling(FALLBACK_POLL_MS);
      });
    } catch {
      startPolling(FALLBACK_POLL_MS);
    }

    // The stream's first frame is given a deadline. If it has not arrived by then,
    // the stream is treated as unusable: the client closes it and keeps the polling
    // fallback, rather than leaving the page on a loading state forever.
    firstFrameTimer = setTimeout(() => {
      if (!alive || streamDelivered) return;
      source?.close();
      source = null;
      startPolling(FALLBACK_POLL_MS);
    }, FIRST_FRAME_TIMEOUT_MS);

    return () => {
      alive = false;
      source?.close();
      stopPolling();
      if (firstFrameTimer) clearTimeout(firstFrameTimer);
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
