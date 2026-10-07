import { FRAME_COUNT, actIndexAt, clamp01, frameAt } from "./timeline";

/**
 * The single source of truth for "how far through the page are we".
 *
 * Two rules shape this file:
 *
 * 1. **One sampler, many readers.** A `scroll` event does no work — it only marks the
 *    sample dirty, and one rAF tick reads layout once and publishes. Six HUD nodes and a
 *    canvas all read the same number, so the counter, the rail and the drawing cannot
 *    drift. Reading `scrollHeight` per listener would be six forced layouts per frame.
 *
 * 2. **Nothing here touches the DOM directly.** Every ambient access arrives through
 *    `ScrollSource`, so the store is testable in plain node and the page is free to
 *    replace it (a reduced-motion build pins progress without faking a scrollbar).
 */

export interface ProgressSample {
  /** 0..1 across the scrollable document. */
  progress: number;
  /** Index into the virtual frame ruler, 0..FRAME_COUNT-1. */
  frame: number;
  /** Zero-based act index into ACTS. */
  act: number;
  /** Signed scroll delta since the published sample, in pixels. */
  velocity: number;
  /** Scrollable distance in pixels; 0 when the document fits the viewport. */
  scrollable: number;
}

/** The ambient world the store needs. Nothing more is ever read from the page. */
export interface ScrollSource {
  readScroll: () => { top: number; max: number };
  subscribeScroll: (onSample: () => void) => () => void;
  requestFrame: (cb: () => void) => number;
  cancelFrame: (handle: number) => void;
}

export interface ScrubController {
  subscribe(listener: (sample: ProgressSample) => void): () => void;
  sample(): ProgressSample;
  /** Read and publish unconditionally. Call after a resize or a layout change. */
  refresh(): void;
  start(): void;
  stop(): void;
}

/** Below this, a sample is not a move. Stops sub-pixel churn from repainting the canvas. */
const EPSILON = 1 / (FRAME_COUNT * 4);

export function createScrub(source: ScrollSource): ScrubController {
  const listeners = new Set<(sample: ProgressSample) => void>();

  let current: ProgressSample = { progress: 0, frame: 0, act: 0, velocity: 0, scrollable: 0 };
  let dirty = true;
  let running = false;
  let tickHandle: number | null = null;
  let teardownScroll: (() => void) | null = null;
  let lastTop = 0;

  function compute(): ProgressSample {
    const { top, max } = source.readScroll();
    const safeMax = Number.isFinite(max) && max > 0 ? max : 0;
    const progress = safeMax === 0 ? 0 : clamp01(top / safeMax);
    const velocity = top - lastTop;
    lastTop = top;
    return { progress, frame: frameAt(progress), act: actIndexAt(progress), velocity, scrollable: safeMax };
  }

  function publish(next: ProgressSample): void {
    current = next;
    for (const listener of listeners) listener(next);
  }

  function tick(): void {
    tickHandle = null;
    if (!running || !dirty) return;
    dirty = false;

    const next = compute();
    // A page that cannot scroll publishes once and then never again; that is the point, not
    // a bug to animate around.
    if (
      Math.abs(next.progress - current.progress) > EPSILON ||
      next.scrollable !== current.scrollable
    ) {
      publish(next);
    }

    // Only ask for another frame if a scroll landed while this one was running. A tick that
    // rescheduled itself unconditionally would keep the compositor busy on a page nobody is
    // moving, and the idle cost this file claims would be false.
    if (dirty) tickHandle = source.requestFrame(tick);
  }

  function schedule(): void {
    dirty = true;
    if (running && tickHandle === null) tickHandle = source.requestFrame(tick);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
    sample() {
      return current;
    },
    refresh() {
      publish(compute());
    },
    start() {
      if (running) return;
      running = true;
      teardownScroll = source.subscribeScroll(schedule);
      schedule();
    },
    stop() {
      running = false;
      if (teardownScroll) {
        teardownScroll();
        teardownScroll = null;
      }
      if (tickHandle !== null) {
        source.cancelFrame(tickHandle);
        tickHandle = null;
      }
    },
  };
}

/**
 * The browser wiring, kept separate from `createScrub` so the logic above has no ambient
 * dependency at all. `max` is recomputed per read: a section that grows after an image
 * or a data fetch must not need a manual invalidation.
 */
export function windowSource(): ScrollSource {
  if (typeof window === "undefined") {
    return {
      readScroll: () => ({ top: 0, max: 0 }),
      subscribeScroll: () => () => {},
      requestFrame: (cb) => {
        cb();
        return -1;
      },
      cancelFrame: () => {},
    };
  }
  return {
    readScroll: () => {
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      return { top: window.scrollY, max };
    },
    subscribeScroll: (onSample) => {
      const handler = () => onSample();
      window.addEventListener("scroll", handler, { passive: true });
      window.addEventListener("resize", handler);
      return () => {
        window.removeEventListener("scroll", handler);
        window.removeEventListener("resize", handler);
      };
    },
    requestFrame: (cb) => requestAnimationFrame(cb),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
  };
}

/**
 * A fixed timeline for surfaces with no scrollbar of their own — a reduced-motion reader,
 * or a host that scrolls a container instead of the document.
 */
export function staticScrub(progress: number): ScrubController {
  const sample: ProgressSample = (() => {
    const p = clamp01(progress);
    return { progress: p, frame: frameAt(p), act: actIndexAt(p), velocity: 0, scrollable: 0 };
  })();
  return {
    subscribe(listener) {
      listener(sample);
      return () => {};
    },
    sample: () => sample,
    refresh: () => {},
    start: () => {},
    stop: () => {},
  };
}
