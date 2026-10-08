import { describe, expect, it, vi } from "vitest";
import {
  Flags,
  Killed,
  selfSchedulingLoop,
  type FlagMap,
  type LoopHandle,
} from "../src/patterns.js";
import { deferred, flush, VirtualClock } from "./support/vclock";

describe("selfSchedulingLoop", () => {
  it("cannot overlap: an iteration that outruns the interval still runs alone", async () => {
    const clock = new VirtualClock();
    const starts: number[] = [];
    let running = 0;
    let peak = 0;

    const loop = selfSchedulingLoop(
      async () => {
        starts.push(clock.current);
        running += 1;
        peak = Math.max(peak, running);
        await clock.sleep(5_000);
        running -= 1;
      },
      { intervalMs: 1_000, sleep: clock.sleep },
    );
    loop.start();
    expect(loop.ticks).toBe(1);

    await clock.advance(20_000);
    loop.stop();
    // stop() does not abort the iteration already running: it just refuses to schedule another.
    await clock.advance(6_000);
    await loop.settled();

    // Each run waits the interval *after finishing*, so a 5s job never overlaps itself. A
    // setInterval on the same period would have launched 20 of these, 5 deep at any moment.
    expect(peak).toBe(1);
    expect(starts).toEqual([0, 6_000, 12_000, 18_000]);
    expect(loop.ticks).toBe(4);
    expect(loop.isRunning()).toBe(false);
  });

  it("spaces quick iterations by interval plus work time, not by interval alone", async () => {
    const clock = new VirtualClock();
    const starts: number[] = [];

    const loop = selfSchedulingLoop(
      async () => {
        starts.push(clock.current);
        await clock.sleep(100);
      },
      { intervalMs: 1_000, sleep: clock.sleep },
    );
    loop.start();
    await clock.advance(2_300);
    loop.stop();
    await loop.settled();

    expect(starts).toEqual([0, 1_100, 2_200]);
  });

  it("yields the event loop between runs instead of spinning", async () => {
    const clock = new VirtualClock();
    const order: string[] = [];

    let ticksSeen = 0;
    const loop = selfSchedulingLoop(
      async () => {
        ticksSeen += 1;
        order.push(`tick${ticksSeen}`);
        if (ticksSeen === 1) setImmediate(() => order.push("immediate"));
        await clock.sleep(10);
      },
      { intervalMs: 50, sleep: clock.sleep },
    );
    loop.start();
    await clock.advance(200);
    loop.stop();
    await loop.settled();

    expect(order[0]).toBe("tick1");
    expect(order[1]).toBe("immediate");
    expect(order).toContain("tick2");
  });

  it("stop() during an awaited iteration schedules nothing further", async () => {
    const clock = new VirtualClock();
    const fn = vi.fn(async () => {
      await clock.sleep(5_000);
    });

    const loop = selfSchedulingLoop(fn, { intervalMs: 1_000, sleep: clock.sleep });
    loop.start();
    expect(loop.isRunning()).toBe(true);

    loop.stop();
    expect(loop.isRunning()).toBe(false);

    await clock.advance(60_000);
    await loop.settled();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(loop.ticks).toBe(1);
  });

  it("stop() cuts a pending wait short so settled() resolves without the clock moving", async () => {
    const clock = new VirtualClock();
    const fn = vi.fn(async () => undefined);

    const loop = selfSchedulingLoop(fn, {
      intervalMs: 60_000,
      sleep: clock.sleep,
      runImmediately: false,
    });
    loop.start();

    let done = false;
    void loop.settled().then(() => {
      done = true;
    });
    loop.stop();
    await flush();

    expect(done).toBe(true);
    expect(fn).not.toHaveBeenCalled();
    expect(clock.current).toBe(0);
  });

  it("a throwing iteration is reported and the loop keeps running", async () => {
    const clock = new VirtualClock();
    const errors: unknown[] = [];
    let n = 0;

    const loop = selfSchedulingLoop(
      async () => {
        n += 1;
        throw new Error(`tick ${n} failed`);
      },
      { intervalMs: 10, sleep: clock.sleep, onError: (err) => errors.push(err) },
    );
    loop.start();
    await clock.advance(200);
    loop.stop();
    await loop.settled();

    expect(loop.ticks).toBe(21);
    expect(n).toBe(21);
    expect(errors).toHaveLength(21);
    expect((errors[0] as Error).message).toBe("tick 1 failed");
    expect((errors[20] as Error).message).toBe("tick 21 failed");
    expect(loop.lastError).toBe(errors[20]);
  });

  it("reports the tick number alongside the failure", async () => {
    const clock = new VirtualClock();
    const seen: Array<{ tick: number; message: string }> = [];

    const loop = selfSchedulingLoop(
      async () => {
        await clock.sleep(1);
        throw new Error("nope");
      },
      {
        intervalMs: 100,
        sleep: clock.sleep,
        onError: (err, info) => seen.push({ tick: info.tick, message: (err as Error).message }),
      },
    );
    loop.start();
    await clock.advance(250);
    loop.stop();
    await loop.settled();

    expect(seen).toEqual([
      { tick: 1, message: "nope" },
      { tick: 2, message: "nope" },
      { tick: 3, message: "nope" },
    ]);
  });

  it("an onError that itself throws does not silence the loop", async () => {
    const clock = new VirtualClock();
    let n = 0;

    const loop = selfSchedulingLoop(
      async () => {
        n += 1;
        throw new Error("work broke");
      },
      {
        intervalMs: 10,
        sleep: clock.sleep,
        onError: () => {
          throw new Error("reporting broke");
        },
      },
    );
    loop.start();
    await clock.advance(100);
    expect(loop.isRunning()).toBe(true);
    expect(n).toBe(11);
    expect((loop.lastError as Error).message).toBe("reporting broke");

    loop.stop();
    await loop.settled();
  });

  it("start() is idempotent, so a double start is not a double job", async () => {
    const clock = new VirtualClock();
    const fn = vi.fn(async () => {
      await clock.sleep(1);
    });

    const loop = selfSchedulingLoop(fn, { intervalMs: 100, sleep: clock.sleep });
    loop.start();
    loop.start();
    await clock.advance(320);
    loop.stop();
    await loop.settled();

    expect(fn).toHaveBeenCalledTimes(4);
    expect(loop.ticks).toBe(4);
  });

  it("waits a full interval before the first run when asked to", async () => {
    const clock = new VirtualClock();
    const fn = vi.fn(async () => {
      await clock.sleep(1);
    });

    const loop = selfSchedulingLoop(fn, {
      intervalMs: 500,
      sleep: clock.sleep,
      runImmediately: false,
    });
    loop.start();
    await flush();
    expect(fn).not.toHaveBeenCalled();

    await clock.advance(501);
    expect(fn).toHaveBeenCalledTimes(1);
    loop.stop();
    await loop.settled();
  });

  it("restarts after a stop and keeps counting", async () => {
    const clock = new VirtualClock();
    const fn = vi.fn(async () => {
      await clock.sleep(1);
    });

    const loop: LoopHandle = selfSchedulingLoop(fn, { intervalMs: 100, sleep: clock.sleep });
    loop.start();
    await clock.advance(250);
    loop.stop();
    await loop.settled();
    expect(loop.ticks).toBe(3);

    loop.start();
    await clock.advance(250);
    loop.stop();
    await loop.settled();

    expect(loop.ticks).toBe(6);
    expect(loop.isRunning()).toBe(false);
  });

  it("refuses an interval it cannot schedule", () => {
    const clock = new VirtualClock();
    expect(() => selfSchedulingLoop(() => undefined, { intervalMs: -1, sleep: clock.sleep })).toThrow(
      /intervalMs/,
    );
    expect(() =>
      selfSchedulingLoop(() => undefined, { intervalMs: Number.NaN, sleep: clock.sleep }),
    ).toThrow(/intervalMs/);
  });

  it("settled() is answerable before the loop ever starts", async () => {
    const loop = selfSchedulingLoop(() => undefined, { intervalMs: 10 });
    await expect(loop.settled()).resolves.toBeUndefined();
    expect(loop.ticks).toBe(0);
    expect(loop.isRunning()).toBe(false);
  });

  it("keeps working with the real timer as the default sleep", async () => {
    // The only test here that touches a real timer, and only for one tick of 1ms.
    const done = deferred<string>();
    const loop = selfSchedulingLoop(
      () => done.resolve("ran with the default sleep"),
      { intervalMs: 1, runImmediately: false },
    );
    loop.start();
    expect(await done.promise).toBe("ran with the default sleep");
    loop.stop();
    await loop.settled();
  });
});

describe("Flags / kill switch", () => {
  function store(initial: FlagMap) {
    const state = { ...initial };
    const source = vi.fn(async (): Promise<FlagMap> => ({ ...state }));
    return {
      state,
      source,
      flip: (next: FlagMap) => Object.assign(state, next),
    };
  }

  it("documents the defaults that make a no-deploy flip land in under a minute", () => {
    const clock = new VirtualClock();
    const flags = new Flags({ source: () => ({}), now: clock.now, sleep: clock.sleep });

    expect(flags.pollMs).toBe(10_000);
    expect(flags.ttlMs).toBe(15_000);
    expect(flags.pollMs).toBeLessThanOrEqual(60_000);
    void flags.stop();
  });

  it("a flipped switch lands on the next poll with no deploy and no new reader", async () => {
    const clock = new VirtualClock();
    const back = store({ "submit-run": false });
    const flags = new Flags({
      source: back.source,
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 1_000,
    });

    expect(flags.enabled("submit-run")).toBe(false);

    back.flip({ "submit-run": true });
    expect(flags.enabled("submit-run")).toBe(false);

    await clock.advance(1_000);
    expect(flags.enabled("submit-run")).toBe(true);
    await expect(flags.require("submit-run", () => "submitted")).rejects.toBeInstanceOf(Killed);

    await flags.stop();
  });

  it("require() runs the guarded work while the switch is off and returns its value", async () => {
    const clock = new VirtualClock();
    const flags = new Flags({
      source: () => ({ "submit-run": false }),
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 1_000,
    });

    await expect(flags.require("submit-run", () => "ok")).resolves.toBe("ok");
    await expect(flags.require("submit-run", async () => 42)).resolves.toBe(42);
    await flags.stop();
  });

  it("names the flag on the typed Killed error", async () => {
    const clock = new VirtualClock();
    const flags = new Flags({
      source: () => ({ withdrawals: true }),
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 1_000,
    });

    const err = await flags
      .require("withdrawals", () => "moved")
      .then(
        () => null,
        (e) => e as unknown,
      );

    expect(err).toBeInstanceOf(Killed);
    expect((err as Killed).name).toBe("Killed");
    expect((err as Killed).flag).toBe("withdrawals");
    await flags.stop();
  });

  it("treats an unknown flag as off, never as on", async () => {
    const clock = new VirtualClock();
    const flags = new Flags({
      source: () => ({ known: true }),
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 1_000,
    });

    expect(flags.enabled("never-heard-of-it")).toBe(false);
    await expect(flags.require("never-heard-of-it", () => "ran")).resolves.toBe("ran");
    await flags.stop();
  });

  it("answers from the cache until the TTL expires, then refreshes before deciding", async () => {
    const clock = new VirtualClock();
    const back = store({ "submit-run": false });
    const flags = new Flags({
      source: back.source,
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 0,
      ttlMs: 1_000,
      autoStart: false,
    });

    await expect(flags.require("submit-run", () => "first")).resolves.toBe("first");
    expect(back.source).toHaveBeenCalledTimes(1);

    back.flip({ "submit-run": true });
    await expect(flags.require("submit-run", () => "cached")).resolves.toBe("cached");
    expect(back.source).toHaveBeenCalledTimes(1);

    clock.current = 1_000;
    await expect(flags.require("submit-run", () => "third")).rejects.toBeInstanceOf(Killed);
    expect(back.source).toHaveBeenCalledTimes(2);
    expect(flags.stale).toBe(false);
    expect(flags.lastSeenAt()).toBe(1_000);
  });

  it("coalesces concurrent refreshes into one source call", async () => {
    const clock = new VirtualClock();
    const gate = deferred<FlagMap>();
    const source = vi.fn(() => gate.promise);
    const flags = new Flags({ source, now: clock.now, pollMs: 0, autoStart: false });

    const round = Promise.all([
      flags.refresh(),
      flags.refresh(),
      flags.refresh(),
      flags.refresh(),
    ]);
    expect(source).toHaveBeenCalledTimes(1);

    gate.resolve({ dark: true });
    await round;

    expect(flags.enabled("dark")).toBe(true);
    expect(flags.lastError).toBe(null);
  });

  it("keeps the last snapshot when the source fails, reports it, and recovers", async () => {
    const clock = new VirtualClock();
    const errors: unknown[] = [];
    let broken = false;
    const flags = new Flags({
      source: async () => {
        if (broken) throw new Error("flag service down");
        return { "submit-run": true };
      },
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 1_000,
      onError: (err) => errors.push(err),
    });
    await flush();

    expect(flags.enabled("submit-run")).toBe(true);
    broken = true;
    await clock.advance(1_000);

    // Losing contact with the flag service is no licence to blank the switch: a killed path
    // that silently un-kills itself when the service blinks is worse than no kill switch.
    expect(errors).toHaveLength(1);
    expect((flags.lastError as Error).message).toBe("flag service down");
    expect(flags.enabled("submit-run")).toBe(true);
    await expect(flags.require("submit-run", () => "moved")).rejects.toBeInstanceOf(Killed);
    expect(flags.lastSeenAt()).toBe(0);

    broken = false;
    await clock.advance(1_000);
    expect(flags.lastSeenAt()).toBe(2_000);
    expect(errors).toHaveLength(1);

    await flags.stop();
  });

  it("stops polling on stop(), and a stale read still refreshes on demand", async () => {
    const clock = new VirtualClock();
    const back = store({});
    const flags = new Flags({
      source: back.source,
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 1_000,
      ttlMs: 500,
    });
    await flags.stop();
    const afterStop = back.source.mock.calls.length;

    await clock.advance(20_000);
    expect(back.source).toHaveBeenCalledTimes(afterStop);

    await expect(flags.require("anything", () => "ran")).resolves.toBe("ran");
    expect(back.source).toHaveBeenCalledTimes(afterStop + 1);
  });

  it("a stop() racing a start() leaves one poller, not two", async () => {
    const clock = new VirtualClock();
    const back = store({});
    const flags = new Flags({
      source: back.source,
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 1_000,
    });
    await flush();
    expect(back.source).toHaveBeenCalledTimes(1);

    const stopping = flags.stop();
    flags.start();
    await stopping;

    // Stop wins: a start() issued while the old loop was draining must not resurrect polling.
    await clock.advance(5_000);
    expect(back.source).toHaveBeenCalledTimes(1);

    flags.start();
    await clock.advance(1_000);
    // Boot refresh plus one poll: two pollers would have fetched twice per interval.
    expect(back.source).toHaveBeenCalledTimes(3);
    await flags.stop();
  });

  it("does not poll when autoStart is off", async () => {
    const clock = new VirtualClock();
    const source = vi.fn(async (): Promise<FlagMap> => ({}));
    const flags = new Flags({
      source,
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 1_000,
      autoStart: false,
    });

    await clock.advance(10_000);
    expect(source).not.toHaveBeenCalled();

    flags.start();
    expect(source).toHaveBeenCalledTimes(1);
    await clock.advance(1_000);
    expect(source).toHaveBeenCalledTimes(2);
    await flags.stop();
  });

  it("refuses a config that cannot hold the guarantee", () => {
    const clock = new VirtualClock();
    expect(() => new Flags({ source: () => ({}), ttlMs: 0, now: clock.now })).toThrow(/ttlMs/);
    expect(() => new Flags({ source: () => ({}), pollMs: -1, now: clock.now })).toThrow(/pollMs/);
    expect(() =>
      new Flags({ source: () => ({}), pollMs: Number.POSITIVE_INFINITY, now: clock.now }),
    ).toThrow(/pollMs/);
    expect(() => new Flags({ source: undefined as never, now: clock.now })).toThrow(/source/);
  });

  it("reads synchronously, which is what keeps it on the hot path", async () => {
    const clock = new VirtualClock();
    const flags = new Flags({
      source: () => ({ a: true, b: false }),
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 1_000,
    });
    await flush();

    expect(flags.enabled("a")).toBe(true);
    expect(flags.enabled("b")).toBe(false);
    expect(flags.stale).toBe(false);
    await flags.stop();
  });
});
