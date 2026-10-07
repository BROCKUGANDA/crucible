import { describe, expect, it } from "vitest";
import { createScrub, staticScrub } from "@/lib/scrub/progress";
import type { ProgressSample, ScrollSource } from "@/lib/scrub/progress";
import { FRAME_COUNT } from "@/lib/scrub/timeline";

/**
 * A stand-in browser. `readScroll` is the only thing that sees real layout, so the whole
 * store can be exercised in node — including the part that matters most: how many frames it
 * asks for.
 */
function fakeWorld(start = { top: 0, max: 1000 }) {
  let state = { ...start };
  let scrollHandler: (() => void) | null = null;
  let queue: (() => void)[] = [];
  let frameRequests = 0;

  const source: ScrollSource = {
    readScroll: () => ({ ...state }),
    subscribeScroll: (onSample) => {
      scrollHandler = onSample;
      return () => {
        scrollHandler = null;
      };
    },
    requestFrame: (cb) => {
      frameRequests += 1;
      queue.push(cb);
      return queue.length;
    },
    cancelFrame: () => {
      queue = [];
    },
  };

  return {
    source,
    /** Drive the page: move the scrollbar and fire the event a browser would fire. */
    scrollTo(top: number, max = state.max) {
      state = { top, max };
      scrollHandler?.();
    },
    /** Move without firing, which is how a layout change (not a scroll) reaches the store. */
    resize(max: number) {
      state = { ...state, max };
      scrollHandler?.();
    },
    /** Run every frame the store asked for. Frames queued by a frame run in the same flush. */
    flush(rounds = 4) {
      for (let r = 0; r < rounds; r += 1) {
        const pending = queue;
        queue = [];
        for (const cb of pending) cb();
        if (queue.length === 0) break;
      }
    },
    get framesRequested() {
      return frameRequests;
    },
    get listenersAttached() {
      return scrollHandler !== null;
    },
  };
}

describe("scrub progress store", () => {
  it("maps scroll position to progress, frame and act", () => {
    const world = fakeWorld();
    const scrub = createScrub(world.source);
    const seen: ProgressSample[] = [];
    scrub.subscribe((s) => seen.push(s));
    scrub.start();

    world.scrollTo(500);
    world.flush();

    const last = seen[seen.length - 1]!;
    expect(last.progress).toBeCloseTo(0.5, 6);
    expect(last.frame).toBe(Math.round(0.5 * (FRAME_COUNT - 1)));
    expect(last.scrollable).toBe(1000);
    scrub.stop();
  });

  it("publishes at most one sample per frame, however many events arrive", () => {
    const world = fakeWorld();
    const scrub = createScrub(world.source);
    let published = 0;
    scrub.subscribe(() => {
      published += 1;
    });
    scrub.start();
    world.flush();
    published = 0;

    // Twelve wheel ticks inside one frame — a browser does this constantly.
    for (let i = 1; i <= 12; i += 1) world.scrollTo(i * 10);
    world.flush();

    expect(published).toBe(1);
    scrub.stop();
  });

  it("asks for no frames at all when nobody scrolls", () => {
    const world = fakeWorld();
    const scrub = createScrub(world.source);
    scrub.start();
    world.flush();

    const afterIdle = world.framesRequested;
    // A self-rescheduling tick would grow this number forever on a still page.
    for (let i = 0; i < 50; i += 1) world.flush();
    expect(world.framesRequested).toBe(afterIdle);
    scrub.stop();
  });

  it("is monotonic while scrolling forward and rewinds exactly going back", () => {
    const world = fakeWorld();
    const scrub = createScrub(world.source);
    scrub.start();

    const forward: number[] = [];
    for (let i = 0; i <= 10; i += 1) {
      world.scrollTo(i * 100);
      world.flush();
      forward.push(scrub.sample().progress);
    }
    for (let i = 1; i < forward.length; i += 1) {
      expect(forward[i]!).toBeGreaterThanOrEqual(forward[i - 1]!);
    }

    world.scrollTo(250);
    world.flush();
    const middle = scrub.sample().progress;

    world.scrollTo(1000);
    world.flush();
    world.scrollTo(250);
    world.flush();
    expect(scrub.sample().progress).toBe(middle);
    scrub.stop();
  });

  it("re-reads the document when the scrollable height changes", () => {
    const world = fakeWorld({ top: 500, max: 500 });
    const scrub = createScrub(world.source);
    scrub.start();
    world.flush();
    expect(scrub.sample().progress).toBeCloseTo(1, 6);

    // Content grows under the reader; the same offset is now a different fraction.
    world.resize(1000);
    world.flush();
    expect(scrub.sample().progress).toBeCloseTo(0.5, 6);
    scrub.stop();
  });

  it("holds still at zero rather than dividing by a page that does not scroll", () => {
    const world = fakeWorld({ top: 0, max: 0 });
    const scrub = createScrub(world.source);
    scrub.start();
    world.flush();
    expect(scrub.sample().progress).toBe(0);
    expect(scrub.sample().frame).toBe(0);
    expect(Number.isNaN(scrub.sample().progress)).toBe(false);
    scrub.stop();
  });

  it("stops listening and stops publishing once stopped", () => {
    const world = fakeWorld();
    const scrub = createScrub(world.source);
    scrub.start();
    world.flush();
    expect(world.listenersAttached).toBe(true);

    let after = 0;
    scrub.subscribe(() => {
      after += 1;
    });
    scrub.stop();
    expect(world.listenersAttached).toBe(false);

    world.scrollTo(900);
    world.flush();
    expect(after).toBe(1); // only the immediate replay on subscribe, never a live sample
  });

  it("replays the current sample to a late subscriber", () => {
    const world = fakeWorld();
    const scrub = createScrub(world.source);
    scrub.start();
    world.scrollTo(800);
    world.flush();

    let received: ProgressSample | null = null;
    scrub.subscribe((s) => {
      received = s;
    });
    expect(received).not.toBeNull();
    expect((received as unknown as ProgressSample).progress).toBeCloseTo(0.8, 6);
    scrub.stop();
  });

  it("staticScrub pins a timeline for hosts with no scrollbar", () => {
    const pinned = staticScrub(0.5);
    pinned.start();
    expect(pinned.sample().progress).toBe(0.5);
    expect(pinned.sample().frame).toBe(Math.round(0.5 * (FRAME_COUNT - 1)));
    let got: ProgressSample | null = null;
    pinned.subscribe((s) => {
      got = s;
    });
    expect(got).not.toBeNull();
    pinned.stop();
  });
});
