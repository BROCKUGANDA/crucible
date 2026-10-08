import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Deadline, TimeoutError, withTimeout } from "../src/patterns.js";
import { deferred, VirtualClock, watchUnhandledRejections } from "./support/vclock";

/** A promise that reports what it settled with, so a test can assert without throwing. */
function observe<T>(p: Promise<T>) {
  const out = { done: false, value: undefined as unknown, err: undefined as unknown };
  p.then(
    (value) => {
      out.done = true;
      out.value = value;
    },
    (err) => {
      out.done = true;
      out.err = err;
    },
  );
  return out;
}

/**
 * `withTimeout` is built on `setTimeout`, and `Deadline` reads `Date.now()` when no clock is
 * injected, so these suites drive both with vitest's fakes instead of spending real time.
 */
function useFakeClock(): void {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

describe("withTimeout", () => {
  useFakeClock();

  it("resolves with the work's value when the work is faster", async () => {
    const work = deferred<string>();
    const raced = withTimeout(work.promise, 500, "getTrial");

    await vi.advanceTimersByTimeAsync(100);
    work.resolve("trial-1");

    await expect(raced).resolves.toBe("trial-1");
    // The losing timer is cleared: a deadline that stays armed for its whole length holds a
    // handle per call, which is a leak under load.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with a typed TimeoutError carrying the tag", async () => {
    const work = deferred<string>();
    const raced = observe(withTimeout(work.promise, 500, "ipfs.pin"));

    await vi.advanceTimersByTimeAsync(500);

    expect(raced.done).toBe(true);
    expect(raced.err).toBeInstanceOf(TimeoutError);
    expect((raced.err as TimeoutError).name).toBe("TimeoutError");
    expect((raced.err as TimeoutError).tag).toBe("ipfs.pin");
    expect((raced.err as TimeoutError).afterMs).toBe(500);
    expect((raced.err as TimeoutError).reason).toBe("deadline");
    expect((raced.err as TimeoutError).message).toContain('"ipfs.pin" did not return within 500ms');
  });

  it("waits the whole budget and no more than the budget", async () => {
    const work = deferred<string>();
    const raced = observe(withTimeout(work.promise, 500, "sign"));

    await vi.advanceTimersByTimeAsync(499);
    expect(raced.done).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(raced.done).toBe(true);
    expect(raced.err).toBeInstanceOf(TimeoutError);
  });

  it("hands the deadline to the abort hook so the work actually stops", async () => {
    const controller = new AbortController();
    let sideEffectRounds = 0;
    let observedAbort = false;

    // The shape of a real caller: the work listens on the signal it was handed.
    const work = new Promise<string>((resolve, reject) => {
      const tick = () => {
        if (controller.signal.aborted) {
          observedAbort = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          return;
        }
        sideEffectRounds += 1;
        setTimeout(tick, 100);
      };
      tick();
    });
    work.catch(() => undefined);

    const raced = observe(
      withTimeout(work, 250, "forge.run", {
        signal: controller.signal,
        onTimeout: () => controller.abort(),
      }),
    );

    await vi.advanceTimersByTimeAsync(250);
    expect(raced.err).toBeInstanceOf(TimeoutError);
    expect((raced.err as TimeoutError).reason).toBe("deadline");

    await vi.advanceTimersByTimeAsync(500);
    expect(observedAbort).toBe(true);
    // 250ms of work at 100ms per round: without the abort it would have kept going.
    expect(sideEffectRounds).toBeLessThanOrEqual(3);
  });

  it("reports a hook that throws as the cause, never as a lost deadline", async () => {
    const work = deferred<string>();
    const hookErr = new Error("abort plumbing is broken");
    const raced = observe(
      withTimeout(work.promise, 100, "relay", {
        onTimeout: () => {
          throw hookErr;
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(raced.err).toBeInstanceOf(TimeoutError);
    expect((raced.err as TimeoutError).cause).toBe(hookErr);
  });

  it("ends the wait immediately on an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const work = deferred<string>();
    const raced = withTimeout(work.promise, 10_000, "slow-call", { signal: controller.signal });

    // Nothing is advanced: the cancellation is answered without waiting for a deadline that
    // will never be relevant, and without arming a timer for it.
    const err = await raced.then(
      () => null,
      (e) => e as unknown,
    );
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).reason).toBe("cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cuts the remaining budget short when the caller aborts mid-flight", async () => {
    const controller = new AbortController();
    const work = deferred<string>();
    const raced = withTimeout(work.promise, 1_000, "watch", { signal: controller.signal });

    await vi.advanceTimersByTimeAsync(200);
    controller.abort();
    // Answered by the abort: fake time never reached the 1s deadline, so a wrapper that only
    // honoured the timer would still be waiting here.
    const err = await raced.then(
      () => null,
      (e) => e as unknown,
    );
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).reason).toBe("cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets the work's own error win when it arrives first", async () => {
    const boom = new Error("HTTP 503");
    const raced = observe(withTimeout(Promise.reject(boom), 500, "submitRun"));

    await vi.advanceTimersByTimeAsync(0);

    expect(raced.err).toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not turn a late rejection into an unhandledRejection", async () => {
    const watcher = watchUnhandledRejections();
    try {
      let rejectLate!: (err: unknown) => void;
      const late = new Promise<string>((_, rej) => {
        rejectLate = rej;
      });
      const afterDeadline = observe(withTimeout(late, 50, "cid-fetch"));
      await vi.advanceTimersByTimeAsync(50);
      expect(afterDeadline.err).toBeInstanceOf(TimeoutError);

      // The wrapper has given up but the call has not: this rejection lands after the fact,
      // and if nothing is attached to it Node takes the process down over it.
      rejectLate(new Error("too late, but still a rejection"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(watcher.seen).toEqual([]);

      let rejectAborted!: (err: unknown) => void;
      const abandoned = new Promise<string>((_, rej) => {
        rejectAborted = rej;
      });
      const controller = new AbortController();
      controller.abort();
      observe(withTimeout(abandoned, 5_000, "already-cancelled", { signal: controller.signal }));
      rejectAborted(new Error("nobody is listening"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(watcher.seen).toEqual([]);
    } finally {
      watcher.stop();
    }
  });

  it("refuses a budget it cannot honour", () => {
    expect(() => withTimeout(Promise.resolve(1), Number.NaN, "x")).toThrow(/finite/);
    expect(() => withTimeout(Promise.resolve(1), -1, "x")).toThrow(/non-negative/);
    expect(() => withTimeout(Promise.resolve(1), Number.POSITIVE_INFINITY, "x")).toThrow(/non-negative/);
  });

  it("accepts a zero budget as an immediate deadline, which is what an expired child gets", async () => {
    const work = deferred<string>();
    const raced = observe(withTimeout(work.promise, 0, "child-after-deadline"));
    await vi.advanceTimersByTimeAsync(0);

    expect(raced.done).toBe(true);
    expect((raced.err as TimeoutError).afterMs).toBe(0);
  });
});

describe("Deadline", () => {
  useFakeClock();

  it("hands a child the remainder, never a fresh budget", () => {
    const clock = new VirtualClock();
    const parent = new Deadline(1_000, { now: clock.now, label: "request" });

    clock.current = 700;
    expect(parent.remainingMs()).toBe(300);
    expect(parent.child()).toBe(300);
    expect(parent.child()).toBeLessThan(1_000);
  });

  it("shrinks with every child taken, so a chain cannot exceed the budget", () => {
    const clock = new VirtualClock();
    const dl = new Deadline(1_000, { now: clock.now });
    const budgets: number[] = [];

    for (let i = 0; i < 4; i += 1) {
      budgets.push(dl.child());
      clock.current += 100;
    }

    expect(budgets).toEqual([1_000, 900, 800, 700]);
  });

  it("reserves headroom for the parent with a fraction", () => {
    const clock = new VirtualClock();
    const dl = new Deadline(1_000, { now: clock.now });
    clock.current = 600;

    expect(dl.child(0.5)).toBe(200);
    expect(dl.child(0.99)).toBe(396);
    expect(dl.remainingMs()).toBe(400);
  });

  it("gives out nothing once spent", () => {
    const clock = new VirtualClock();
    const dl = new Deadline(1_000, { now: clock.now });

    dl.expire();

    expect(dl.remainingMs()).toBe(0);
    expect(dl.child()).toBe(0);
    expect(dl.child(0.5)).toBe(0);
    expect(dl.expired).toBe(true);
  });

  it("reads as expired when the clock ran past it", () => {
    const clock = new VirtualClock();
    const dl = new Deadline(1_000, { now: clock.now });
    expect(dl.expired).toBe(false);

    clock.current = 1_500;

    expect(dl.expired).toBe(true);
    expect(dl.remainingMs()).toBe(0);
  });

  it("adopts a deadline propagated from the caller, so one budget spans the boundary", () => {
    const upstream = new VirtualClock();
    const parent = new Deadline(2_000, { now: upstream.now });

    const downstream = new VirtualClock();
    downstream.current = 1_500;
    const child = new Deadline({ at: parent.at }, { now: downstream.now, label: "handler" });

    expect(child.at).toBe(parent.at);
    expect(child.remainingMs()).toBe(500);
    expect(child.child(0.5)).toBe(250);
  });

  it("a propagated deadline that already expired downstream gives zero, not a fresh start", () => {
    const upstream = new VirtualClock();
    const parent = new Deadline(100, { now: upstream.now });

    const downstream = new VirtualClock();
    downstream.current = 900;
    const child = new Deadline({ at: parent.at }, { now: downstream.now });

    expect(child.remainingMs()).toBe(0);
    expect(child.expired).toBe(true);
    expect(child.child()).toBe(0);
  });

  it("refuses a budget it cannot spend", () => {
    const clock = new VirtualClock();
    expect(() => new Deadline(0, { now: clock.now })).toThrow(/positive/);
    expect(() => new Deadline(-5, { now: clock.now })).toThrow(/positive/);
    expect(() => new Deadline(Number.NaN, { now: clock.now })).toThrow(/positive/);
    expect(() => new Deadline({ at: Number.NaN }, { now: clock.now })).toThrow(/finite/);

    const dl = new Deadline(1_000, { now: clock.now });
    expect(() => dl.child(0)).toThrow(/fraction/);
    expect(() => dl.child(1.5)).toThrow(/fraction/);
    expect(() => dl.child(-0.5)).toThrow(/fraction/);
    expect(() => dl.child(Number.NaN)).toThrow(/fraction/);
  });

  it("drives a real child call inside the parent's window, not its own", async () => {
    const started = Date.now();
    const parent = new Deadline(1_000, { label: "request" });

    await vi.advanceTimersByTimeAsync(600);
    const budget = parent.child();
    expect(budget).toBe(400);

    const work = deferred<string>();
    const raced = observe(withTimeout(work.promise, budget, "child-call"));
    await vi.advanceTimersByTimeAsync(399);
    expect(raced.done).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(raced.err).toBeInstanceOf(TimeoutError);
    expect((raced.err as TimeoutError).afterMs).toBe(400);
    // The whole chain ends at 1s from the request, which is what the caller was promised.
    expect(Date.now() - started).toBe(1_000);
  });

  it("lets a call that fits the remainder succeed", async () => {
    const parent = new Deadline(1_000, { label: "request" });
    await vi.advanceTimersByTimeAsync(600);

    const work = deferred<string>();
    const raced = observe(withTimeout(work.promise, parent.child(), "child-call"));
    await vi.advanceTimersByTimeAsync(100);
    work.resolve("in time");
    await vi.advanceTimersByTimeAsync(0);

    expect(raced.value).toBe("in time");
    expect(raced.err).toBeUndefined();
  });
});
