"use client";

import { useEffect, useState } from "react";
import type { ApiSnapshot } from "@crucible/indexer";
import { chainNowMs } from "./chainClock";
import type { HealthPayload, ReadyPayload } from "./ops";
import { API_BASE } from "./apiBase";

/**
 * Snapshot polling.
 *
 * Countdowns are never measured against the browser's clock: a client skewed by a few minutes
 * would show a window that closed hours ago as still open. What they are measured against is the
 * chain's clock — `max(headTimestamp + 1, the API's now)` — because the contract enforces
 * `block.timestamp`, and this demo warps that away from wall time on purpose. The API's own clock
 * is still exposed as `serverNowMs`, for the figures that clock wrote, such as a DLQ entry's age.
 * See `lib/chainClock.ts` for why neither clock is enough on its own.
 */

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
  /**
   * The API host's wall clock, ms. Use it only against something that clock wrote — the DLQ's
   * `lastAt`, a probe's age. It is not the reference for a chain deadline: the contract enforces
   * `block.timestamp`, and this demo warps that on purpose.
   */
  serverNowMs: number | null;
  /**
   * `max(headTimestamp + 1, serverNowMs)` — the timestamp the node will stamp its next block with,
   * which is the only clock a `block.timestamp` guard can be counted against. Every countdown and
   * every "is this window closed" test on the site belongs here. See `lib/chainClock.ts`.
   */
  chainNowMs: number | null;
}

export function useSnapshot(pollMs = FALLBACK_POLL_MS): SnapshotState {
  const [state, setState] = useState<SnapshotState>({
    data: null,
    error: null,
    loading: true,
    serverNowMs: null,
    chainNowMs: null,
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
        const res = await fetch(`${API_BASE}/snapshot`, { signal: controller.signal });
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
        if (alive)
          setState({
            data,
            error: null,
            loading: false,
            serverNowMs: data.now,
            chainNowMs: chainNowMs(data),
          });
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
      source = new EventSource(`${API_BASE}/stream`);
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
          setState({
            data,
            error: null,
            loading: false,
            serverNowMs: data.now,
            chainNowMs: chainNowMs(data),
          });
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
 * The operator surface — `/health` and `/ready` — on the same clock as the snapshot.
 *
 * These two endpoints answer the questions a reader of a transparency page actually asks:
 * how far the index reaches, whether the last sync tick failed, what the dead-letter queue
 * holds, which dependency breakers are tripped. Neither is inside `/snapshot`, so the page
 * needs them as a second read — but *not* as a second loop.
 *
 * There is no `setInterval` here. The trigger is the snapshot's own server `now`, which the
 * live stream advances: `useSnapshot` already decides when the site has fresh information, and
 * a probe that ran on its own timer would either race that decision or double the request rate.
 * The `now` is bucketed rather than used directly because the stream pushes on every change to
 * the read model — a busy chain would otherwise re-read the operator endpoints several times a
 * second, and `/health` and `/ready` share the same per-IP budget as `/snapshot`. Spending it
 * would show a visitor "the forge is busy" on the page whose job is to report the truth.
 *
 * A manual retry re-reads both immediately; that is the only way this moves faster than the
 * stream does, and it is always the reader's own click.
 */
const OPS_REFRESH_MS = FALLBACK_POLL_MS;

export interface Probe<T> {
  data: T | null;
  /** the HTTP status the endpoint answered with, kept because a 503 still carries the truth */
  status: number | null;
  error: string | null;
  loading: boolean;
}

const PROBING: Probe<never> = { data: null, status: null, error: null, loading: true };

/**
 * Read one operator endpoint.
 *
 * A non-2xx is parsed rather than discarded: `/health` answers 503 precisely when the indexer
 * has a `syncError`, and `/ready` answers 503 precisely when the read model is incomplete. The
 * body of those two responses is the most valuable thing either endpoint ever says, and a
 * client that treats a red status as "no data" would blank the page at the exact moment the
 * system is failing.
 */
async function readEndpoint<T>(path: string, signal: AbortSignal): Promise<Probe<T>> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { signal });
    if (res.status === 429) {
      return {
        data: null,
        status: 429,
        error: "The forge is busy — too many readers at once.",
        loading: false,
      };
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (body === null || typeof body !== "object") {
      return {
        data: null,
        status: res.status,
        error: res.ok
          ? "the API answered with no body to read"
          : `the API answered ${res.status} with no body to read`,
        loading: false,
      };
    }
    return { data: body as T, status: res.status, error: null, loading: false };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      // The page unmounted or a newer read replaced this one. Nothing to report.
      return { data: null, status: null, error: null, loading: false };
    }
    return { data: null, status: null, error: "The API did not answer.", loading: false };
  }
}

export interface OpsState {
  health: Probe<HealthPayload>;
  ready: Probe<ReadyPayload>;
  /** re-read both endpoints now, on the reader's own request */
  retry: () => void;
}

export function useOps(serverNowMs: number | null): OpsState {
  const [health, setHealth] = useState<Probe<HealthPayload>>(PROBING);
  const [ready, setReady] = useState<Probe<ReadyPayload>>(PROBING);
  const [attempt, setAttempt] = useState(0);

  // `"cold"` rather than `null` so the very first read happens on mount, before any snapshot
  // has arrived to trigger it — a page about whether the API is answering must not wait on the
  // API's most expensive endpoint to find out whether its cheapest ones are.
  const bucket: string | number = serverNowMs === null ? "cold" : Math.floor(serverNowMs / OPS_REFRESH_MS);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setHealth((s) => ({ ...s, loading: true }));
    setReady((s) => ({ ...s, loading: true }));

    void readEndpoint<HealthPayload>("/health", controller.signal).then((p) => {
      if (alive) setHealth(p);
    });
    void readEndpoint<ReadyPayload>("/ready", controller.signal).then((p) => {
      if (alive) setReady(p);
    });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [bucket, attempt]);

  return { health, ready, retry: () => setAttempt((a) => a + 1) };
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
  nowMs: number | null,
): number | null {
  const [offsetSec, setOffsetSec] = useState(0);

  useEffect(() => {
    if (nowMs === null) return;
    // Re-anchor whenever a fresh snapshot arrives.
    setOffsetSec(0);
  }, [nowMs]);

  useEffect(() => {
    const t = setInterval(() => setOffsetSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  if (targetSeconds === null) return null;
  const base = nowMs === null ? Date.now() : nowMs;
  return Math.max(0, Math.floor(targetSeconds - base / 1000 - offsetSec));
}
