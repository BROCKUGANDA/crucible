import { describe, expect, it, vi } from "vitest";
import {
  BreakerOpen,
  CircuitBreaker,
  type BreakerSnapshot,
  type CircuitBreakerOptions,
} from "../src/patterns.js";
import { deferred, VirtualClock } from "./support/vclock";

const fail = (msg = "upstream down") => Promise.reject(new Error(msg));
const ok = <T>(value: T) => Promise.resolve(value);

function make(clock: VirtualClock, over: Partial<CircuitBreakerOptions> = {}) {
  return new CircuitBreaker({
    name: "trials-rpc",
    threshold: 3,
    cooldownMs: 30_000,
    windowMs: 30_000,
    now: clock.now,
    ...over,
  });
}

/** Options mirrored for `restore`, which takes them separately from the snapshot. */
function opts(clock: VirtualClock, over: Partial<CircuitBreakerOptions> = {}): CircuitBreakerOptions {
  return { name: "trials-rpc", now: clock.now, ...over };
}

async function trip(b: CircuitBreaker, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await b.exec(() => fail()).catch(() => undefined);
  }
}

async function refusal(b: CircuitBreaker, ran = "must not run") {
  const fn = vi.fn(() => ok(ran));
  const err = await b.exec(fn).then(
    () => null,
    (e) => e as unknown,
  );
  return { err, fn };
}

describe("CircuitBreaker opening", () => {
  it("trips on the threshold count of failures, not on the first one", async () => {
    const clock = new VirtualClock();
    const b = make(clock, { threshold: 3 });

    await b.exec(() => fail()).catch(() => undefined);
    await b.exec(() => fail()).catch(() => undefined);
    expect(b.status().state).toBe("closed");

    await b.exec(() => fail()).catch(() => undefined);
    expect(b.status().state).toBe("open");
  });

  it("counts failures inside the window, not failures ever", async () => {
    const clock = new VirtualClock();
    const b = make(clock, { threshold: 3, windowMs: 1_000 });

    // Spaced wider than the window holds, so no three of them are ever inside one window.
    for (let i = 0; i < 4; i += 1) {
      if (i > 0) await clock.advance(500);
      await b.exec(() => fail()).catch(() => undefined);
    }

    expect(b.status().state).toBe("closed");
    expect(b.status().failures).toBe(2);
  });

  it("refuses with a typed BreakerOpen and never touches the dependency", async () => {
    const clock = new VirtualClock();
    const b = make(clock);
    await trip(b, 3);
    await clock.advance(5_000);

    const { err, fn } = await refusal(b);

    expect(err).toBeInstanceOf(BreakerOpen);
    expect((err as BreakerOpen).name).toBe("BreakerOpen");
    expect((err as BreakerOpen).breaker).toBe("trials-rpc");
    expect((err as BreakerOpen).retryAfterMs).toBe(25_000);
    expect((err as BreakerOpen).reason).toBe("cooldown");
    expect((err as BreakerOpen).message).toContain("Try again in 25000ms");
    expect(fn).not.toHaveBeenCalled();
  });

  it("passes a real failure through untouched rather than masking it", async () => {
    const clock = new VirtualClock();
    const b = make(clock, { threshold: 5 });
    const boom = new Error("404 not found");

    await expect(b.exec(() => Promise.reject(boom))).rejects.toBe(boom);
    expect(b.status().lastFailure).toBe(0);
    expect(b.status().state).toBe("closed");
  });

  it("ships the documented defaults", async () => {
    const clock = new VirtualClock();
    const b = new CircuitBreaker({ name: "trials-rpc", now: clock.now });

    expect(b.threshold).toBe(5);
    expect(b.cooldownMs).toBe(30_000);
    expect(b.windowMs).toBe(30_000);
    expect(b.halfOpenMax).toBe(1);

    await trip(b, 4);
    expect(b.status().state).toBe("closed");
    await b.exec(() => fail()).catch(() => undefined);
    expect(b.status().state).toBe("open");

    // Five failures in 30s is the trigger; five spread over 30s of silence is not.
    await clock.advance(31_000);
    const spread = new CircuitBreaker({ name: "trials-rpc", now: clock.now });
    for (let i = 0; i < 5; i += 1) {
      await spread.exec(() => fail()).catch(() => undefined);
      await clock.advance(8_000);
    }
    expect(spread.status().state).toBe("closed");
  });

  it("rejects a degenerate config instead of a breaker that cannot trip", () => {
    const clock = new VirtualClock();
    expect(() => make(clock, { threshold: 0 })).toThrow(/threshold/);
    expect(() => make(clock, { halfOpenMax: 0 })).toThrow(/halfOpenMax/);
    expect(() => make(clock, { cooldownMs: 0 })).toThrow(/cooldownMs/);
    expect(() => make(clock, { windowMs: Number.NaN })).toThrow(/windowMs/);
    expect(() => make(clock, { threshold: 2.5 })).toThrow(/threshold/);
    expect(() => new CircuitBreaker({ name: "", now: clock.now })).toThrow(/name/);
  });
});

describe("CircuitBreaker half-open", () => {
  it("admits exactly one probe and refuses everyone else", async () => {
    const clock = new VirtualClock();
    const b = make(clock, { halfOpenMax: 1 });
    await trip(b, 3);
    await clock.advance(30_000);

    const held = deferred<string>();
    const probe = b.exec(() => held.promise);
    const { err, fn } = await refusal(b, "second");

    expect(err).toBeInstanceOf(BreakerOpen);
    expect((err as BreakerOpen).reason).toBe("probe-budget");
    expect(fn).not.toHaveBeenCalled();

    held.resolve("fine");
    expect(await probe).toBe("fine");
    expect(b.status().state).toBe("closed");
  });

  it("admits halfOpenMax probes when that is what was configured", async () => {
    const clock = new VirtualClock();
    const b = make(clock, { threshold: 2, halfOpenMax: 2 });
    await trip(b, 2);
    await clock.advance(30_000);

    const a = deferred<number>();
    const c = deferred<number>();
    const running = [b.exec(() => a.promise), b.exec(() => c.promise)];
    const refused = await b.exec(() => ok(3)).then(
      () => "ran",
      () => "refused",
    );
    a.resolve(1);
    c.resolve(2);

    expect(refused).toBe("refused");
    expect(await Promise.all(running)).toEqual([1, 2]);
  });

  it("a successful probe closes the breaker and resets the failure budget", async () => {
    const clock = new VirtualClock();
    const b = make(clock, { threshold: 3 });
    await trip(b, 3);
    await clock.advance(30_000);

    expect(await b.exec(() => ok("recovered"))).toBe("recovered");
    expect(b.status().state).toBe("closed");
    expect(b.status().failures).toBe(0);

    await trip(b, 2);
    expect(b.status().state).toBe("closed");
    await b.exec(() => fail()).catch(() => undefined);
    expect(b.status().state).toBe("open");
  });

  it("a failed probe re-opens on its own, without needing the threshold again", async () => {
    const clock = new VirtualClock();
    // windowMs well inside cooldownMs, so the failures that opened it have aged out by the
    // time the probe runs: only a breaker that re-opens on a probe failure can refuse again.
    const b = make(clock, { threshold: 5, windowMs: 1_000, cooldownMs: 10_000 });
    await trip(b, 5);
    expect(b.status().state).toBe("open");

    await clock.advance(10_000);
    expect(b.status().failures).toBe(0);
    await expect(b.exec(() => fail("probe failed"))).rejects.toThrow(/probe failed/);
    expect(b.status().state).toBe("open");

    const { err, fn } = await refusal(b);
    expect(err).toBeInstanceOf(BreakerOpen);
    expect((err as BreakerOpen).retryAfterMs).toBe(10_000);
    expect(fn).not.toHaveBeenCalled();

    await clock.advance(10_000);
    expect(await b.exec(() => ok("yes"))).toBe("yes");
    expect(b.status().state).toBe("closed");
  });

  it("names the reason the caller was refused", async () => {
    const clock = new VirtualClock();
    const b = make(clock, { threshold: 1, halfOpenMax: 1, cooldownMs: 10_000 });
    await b.exec(() => fail()).catch(() => undefined);

    const cooldownErr = (await refusal(b)).err as BreakerOpen;
    expect(cooldownErr.reason).toBe("cooldown");
    expect(cooldownErr.retryAfterMs).toBe(10_000);

    await clock.advance(10_000);
    const held = deferred<string>();
    const probe = b.exec(() => held.promise);
    const budgetErr = (await refusal(b)).err as BreakerOpen;
    expect(budgetErr.reason).toBe("probe-budget");
    expect(budgetErr.breaker).toBe("trials-rpc");

    held.resolve("done");
    expect(await probe).toBe("done");
  });

  it("refuses while a probe is in flight even though the cooldown already elapsed", async () => {
    const clock = new VirtualClock();
    const b = make(clock, { threshold: 1, cooldownMs: 1_000 });
    await b.exec(() => fail()).catch(() => undefined);

    await clock.advance(60_000);
    const held = deferred<string>();
    const probe = b.exec(() => held.promise);
    const { err, fn } = await refusal(b);
    expect(err).toBeInstanceOf(BreakerOpen);
    expect(fn).not.toHaveBeenCalled();
    held.resolve("x");
    expect(await probe).toBe("x");
  });
});

describe("CircuitBreaker status", () => {
  it("hands a health endpoint everything it needs without internals", async () => {
    const clock = new VirtualClock();
    const b = make(clock, { threshold: 2, cooldownMs: 10_000 });

    expect(b.status()).toEqual({
      state: "closed",
      failures: 0,
      openedAt: null,
      lastFailure: null,
      consecutiveSuccesses: 0,
      probesUsed: 0,
      retryAfterMs: null,
    });

    await b.exec(() => ok("a"));
    await b.exec(() => ok("b"));
    expect(b.status().consecutiveSuccesses).toBe(2);

    await b.exec(() => fail()).catch(() => undefined);
    await clock.advance(4_000);
    await b.exec(() => fail()).catch(() => undefined);

    await clock.advance(8_000);
    const status = b.status();
    expect(status.state).toBe("open");
    expect(status.failures).toBe(2);
    expect(status.openedAt).toBe(4_000);
    expect(status.lastFailure).toBe(4_000);
    expect(status.consecutiveSuccesses).toBe(0);
    expect(status.retryAfterMs).toBe(2_000);
  });

  it("reports half-open as not time-gated, since its transition is a probe settling", async () => {
    const clock = new VirtualClock();
    const b = make(clock, { threshold: 1, cooldownMs: 1_000 });
    await b.exec(() => fail()).catch(() => undefined);
    await clock.advance(1_000);

    const held = deferred<string>();
    const probe = b.exec(() => held.promise);
    expect(b.status()).toMatchObject({ state: "half-open", probesUsed: 1, retryAfterMs: null });
    held.resolve("y");
    await probe;
  });
});

describe("CircuitBreaker across a restart", () => {
  async function opened(clock: VirtualClock) {
    const b = make(clock, { threshold: 2, cooldownMs: 10_000 });
    await trip(b, 2);
    return b;
  }

  it("comes back open, still inside its cooldown", async () => {
    const clock = new VirtualClock();
    const live = await opened(clock);
    const snapshot = live.saveState();

    await clock.advance(3_000);
    const restored = CircuitBreaker.restore(opts(clock, { threshold: 2, cooldownMs: 10_000 }), snapshot);

    const { err, fn } = await refusal(restored);
    expect(err).toBeInstanceOf(BreakerOpen);
    expect((err as BreakerOpen).retryAfterMs).toBe(7_000);
    expect(fn).not.toHaveBeenCalled();
    expect(restored.status().state).toBe("open");
  });

  it("carries the failure window, so a partial burst does not start over", async () => {
    const clock = new VirtualClock();
    const live = make(clock, { threshold: 3, windowMs: 60_000, cooldownMs: 10_000 });
    await trip(live, 2);
    expect(live.status().state).toBe("closed");

    const restored = CircuitBreaker.restore(
      opts(clock, { threshold: 3, windowMs: 60_000, cooldownMs: 10_000 }),
      live.saveState(),
    );
    expect(restored.status().failures).toBe(2);

    await restored.exec(() => fail()).catch(() => undefined);
    expect(restored.status().state).toBe("open");
  });

  it("forgives failures that aged out of the window while the process was dead", async () => {
    const clock = new VirtualClock();
    const live = make(clock, { threshold: 3, windowMs: 60_000 });
    await trip(live, 2);
    const snapshot = live.saveState();

    await clock.advance(120_000);
    const restored = CircuitBreaker.restore(opts(clock, { threshold: 3, windowMs: 60_000 }), snapshot);

    expect(restored.status().failures).toBe(0);
    await restored.exec(() => fail()).catch(() => undefined);
    expect(restored.status().state).toBe("closed");
  });

  it("probes instead of blocking when the cooldown elapsed during the outage", async () => {
    const clock = new VirtualClock();
    const live = await opened(clock);

    await clock.advance(500_000);
    const restored = CircuitBreaker.restore(
      opts(clock, { threshold: 2, cooldownMs: 10_000 }),
      live.saveState(),
    );

    expect(await restored.exec(() => ok("probed"))).toBe("probed");
    expect(restored.status().state).toBe("closed");
  });

  it("restores a half-open breaker ready to probe, since the crash lost its probe", async () => {
    const clock = new VirtualClock();
    const live = await opened(clock);
    await clock.advance(10_000);
    const held = deferred<string>();
    const probe = live.exec(() => held.promise);
    expect(live.status().state).toBe("half-open");

    const snapshot: BreakerSnapshot = live.saveState();
    held.resolve("old process died");
    await probe;

    const restored = CircuitBreaker.restore(
      opts(clock, { threshold: 2, cooldownMs: 10_000 }),
      snapshot,
    );
    expect(snapshot.state).toBe("half-open");
    expect(await restored.exec(() => ok("fresh probe"))).toBe("fresh probe");
  });

  it("refuses another breaker's snapshot instead of inheriting its outage", async () => {
    const clock = new VirtualClock();
    const live = await opened(clock);

    expect(() => CircuitBreaker.restore(opts(clock, { name: "ipfs-pin" }), live.saveState())).toThrow(
      /ipfs-pin/,
    );
  });

  it("treats a missing snapshot as a clean start", () => {
    const clock = new VirtualClock();
    const restored = CircuitBreaker.restore(opts(clock), null);
    expect(restored.status().state).toBe("closed");
  });

  it("hands back a JSON-safe snapshot the caller can write anywhere", async () => {
    const clock = new VirtualClock();
    const live = await opened(clock);
    const snapshot = live.saveState();

    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);

    (snapshot.failureTimes as number[]).push(999);
    expect(live.status().failures).toBe(2);
  });

  it("survives a save/restore round trip of the whole open->probe->closed cycle", async () => {
    const clock = new VirtualClock();
    const b = make(clock, { threshold: 2, cooldownMs: 10_000 });
    let state = "closed";
    let breaker = b;

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await trip(breaker, 2);
      state = breaker.status().state;
      expect(state).toBe("open");
      let snapshot = breaker.saveState();

      await clock.advance(5_000);
      breaker = CircuitBreaker.restore(
        opts(clock, { threshold: 2, cooldownMs: 10_000 }),
        snapshot,
      );
      expect(breaker.status().state).toBe("open");

      snapshot = breaker.saveState();
      await clock.advance(5_000);
      breaker = CircuitBreaker.restore(
        opts(clock, { threshold: 2, cooldownMs: 10_000 }),
        snapshot,
      );
      expect(await breaker.exec(() => ok(cycle))).toBe(cycle);
      expect(breaker.status().state).toBe("closed");
    }
    expect(state).toBe("open");
  });
});
