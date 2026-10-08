import { afterEach, describe, expect, it, vi } from "vitest";
import { BreakerOpen, CircuitBreaker, Flags, Killed } from "@crucible/smith";
import { createSweepLoop, envKillSwitches, SWEEP_FLAG } from "../src/sweep-loop.js";

const HASH = `0x${"ab".repeat(32)}`;

function breaker(cooldownMs = 60_000): CircuitBreaker {
  return new CircuitBreaker({ name: "keeper.rpc", threshold: 3, windowMs: 60_000, cooldownMs });
}

/**
 * Polling disabled: the switch is flipped through `refresh()` in the test rather than through a
 * timer, so nothing here depends on how fast the machine running it happens to be.
 */
function flags(back: Record<string, boolean>): Flags {
  return new Flags({ source: async () => ({ ...back }), pollMs: 0 });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("envKillSwitches", () => {
  it("reads KILL_SWITCHES as a list of the flags that are on", async () => {
    await expect(envKillSwitches({ KILL_SWITCHES: "keeper.sweep, other.thing ," })()).resolves.toEqual({
      "keeper.sweep": true,
      "other.thing": true,
    });
  });

  it("kills nothing when the variable is unset or empty", async () => {
    await expect(envKillSwitches({})()).resolves.toEqual({});
    await expect(envKillSwitches({ KILL_SWITCHES: "" })()).resolves.toEqual({});
  });
});

describe("the sweep loop, against a node that answers slowly", () => {
  /**
   * The reason this is a self-scheduling loop and not the `setInterval` it replaced: a pass
   * that outruns its period must not get a second one started on top of it. Two sweeps in
   * flight over one read model send the same `finalize` twice and read the same nonces twice,
   * which is only harmless because the contract reverts — the cost is paid by the node.
   *
   * The pass takes 2500ms on a 1000ms period, deliberately not a multiple of it: a wall-clock
   * schedule realigns to itself after every skip, so the start times below are the proof that
   * the wait is measured from the previous pass *finishing*.
   */
  it("never overlaps itself, and starts each pass off the last one finishing", async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const starts: number[] = [];
    let live = 0;
    let peak = 0;

    const loop = createSweepLoop({
      intervalMs: 1_000,
      breaker: breaker(),
      flags: flags({}),
      chainNow: async () => 1_700_000_000,
      act: async () => {
        starts.push(Date.now() - t0);
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 2_500));
        live -= 1;
        return { acted: [HASH] };
      },
      onLog: () => {},
    });

    loop.handle.start();
    await vi.advanceTimersByTimeAsync(20_000);
    loop.handle.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(peak).toBe(1);
    expect(starts).toEqual([1_000, 4_500, 8_000, 11_500, 15_000, 18_500]);
    // `stop()` during the pass that started at 18500 scheduled nothing after it.
    expect(starts).toHaveLength(6);
    expect(loop.handle.isRunning()).toBe(false);
  });

  it("reports what the pass acted, and when the last one landed", async () => {
    const loop = createSweepLoop({
      intervalMs: 1_000,
      breaker: breaker(),
      flags: flags({}),
      chainNow: async () => 1_700_000_000,
      act: async () => ({ acted: [HASH, HASH, HASH] }),
      onLog: () => {},
    });

    expect(loop.status().lastSweepAt).toBeNull();
    await loop.sweep();
    const status = loop.status();
    expect(status.lastSweepActed).toBe(3);
    expect(status.lastSweepAt).not.toBeNull();
    expect(status.killed).toBe(false);
    expect(status.breaker.state).toBe("closed");
  });

  it("decides against the chain's clock, handed to the acting hop in seconds", async () => {
    const act = vi.fn(async () => ({ acted: [] }));
    const loop = createSweepLoop({
      intervalMs: 1_000,
      breaker: breaker(),
      flags: flags({}),
      chainNow: async () => 1_700_000_000,
      act,
      onLog: () => {},
    });

    await loop.sweep();
    expect(act).toHaveBeenCalledWith(1_700_000_000);
  });
});

describe("the keeper's sweep behind a circuit breaker", () => {
  /**
   * The keeper's hop is a block read and then a write, both against the same node, so the
   * breaker sits in front of both. A refusal has to reach the clock read too — a keeper that
   * still calls `getBlock` while tripped is hammering the outage it is supposed to be sitting
   * out.
   */
  it("refuses the fourth pass without touching the node, after three failures", async () => {
    const chainNow = vi.fn(async (): Promise<number> => {
      throw new Error("connection refused");
    });
    const act = vi.fn(async () => ({ acted: [] }));
    const guard = breaker();

    const loop = createSweepLoop({
      intervalMs: 1_000,
      breaker: guard,
      flags: flags({}),
      chainNow,
      act,
      onLog: () => {},
    });

    for (let i = 0; i < 3; i += 1) {
      await expect(loop.sweep()).rejects.toThrow("connection refused");
    }
    expect(chainNow).toHaveBeenCalledTimes(3);
    expect(act).not.toHaveBeenCalled();
    expect(loop.status().breaker.state).toBe("open");

    await expect(loop.sweep()).rejects.toBeInstanceOf(BreakerOpen);
    // The whole point: a refused pass attempted nothing, so the outage stops stacking retries.
    expect(chainNow).toHaveBeenCalledTimes(3);
    expect(act).not.toHaveBeenCalled();
    expect(loop.status().breaker.retryAfterMs).toBeGreaterThan(0);
  });

  it("closes again once the node answers the probe", async () => {
    let down = true;
    const guard = new CircuitBreaker({ name: "keeper.rpc", threshold: 3, windowMs: 60_000, cooldownMs: 5 });
    const act = vi.fn(async () => {
      if (down) throw new Error("connection refused");
      return { acted: [HASH] };
    });
    const chainNow = vi.fn(async () => {
      if (down) throw new Error("connection refused");
      return 1_700_000_000;
    });

    const loop = createSweepLoop({
      intervalMs: 1_000,
      breaker: guard,
      flags: flags({}),
      chainNow,
      act,
      onLog: () => {},
    });

    for (let i = 0; i < 3; i += 1) await expect(loop.sweep()).rejects.toThrow("connection refused");
    expect(loop.status().breaker.state).toBe("open");

    // The node comes back. Past the cooldown the breaker admits exactly one probe, and a pass
    // that answers closes it — so an outage that heals needs no restart to stop being one.
    down = false;
    await new Promise((r) => setTimeout(r, 10));
    await loop.sweep();
    expect(loop.status().breaker.state).toBe("closed");
    expect(loop.status().lastSweepActed).toBe(1);
  });
});

describe("the keeper's kill switch", () => {
  /**
   * The hop this guards is the one that matters: `finalize` is permissionless, so the keeper is
   * the only party in the demo deciding to send it. A switch that refuses here stops all
   * outbound transactions with no deploy, and does it *before* the node is called.
   */
  it("refuses to act while the flag is on, and calls nothing on the way", async () => {
    const back: Record<string, boolean> = {};
    const act = vi.fn(async () => ({ acted: [HASH] }));
    const chainNow = vi.fn(async () => 1_700_000_000);
    const guard = breaker();
    const flagsUnderTest = flags(back);

    const loop = createSweepLoop({
      intervalMs: 1_000,
      breaker: guard,
      flags: flagsUnderTest,
      chainNow,
      act,
      onLog: () => {},
    });

    await loop.sweep();
    expect(act).toHaveBeenCalledTimes(1);

    back[SWEEP_FLAG] = true;
    await flagsUnderTest.refresh();
    await loop.sweep();

    expect(act).toHaveBeenCalledTimes(1);
    expect(chainNow).toHaveBeenCalledTimes(1);
    const status = loop.status();
    expect(status.killed).toBe(true);
    expect(status.lastSweepActed).toBe(0);
    // A deliberate halt is not an outage: it must not spend the breaker's failure budget,
    // or pulling the switch would trip the guard that reports the node as broken.
    expect(status.breaker.state).toBe("closed");
    expect(status.breaker.failures).toBe(0);
    // And it must not read as an unhealthy process — the compose probe would restart the
    // keeper out from under the switch and turn a halt into a reboot loop.
    expect(status.lastSweepAt).not.toBeNull();
  });

  it("resumes acting the moment the flag is released", async () => {
    const back: Record<string, boolean> = { [SWEEP_FLAG]: true };
    const act = vi.fn(async () => ({ acted: [HASH] }));
    const flagsUnderTest = flags(back);
    const loop = createSweepLoop({
      intervalMs: 1_000,
      breaker: breaker(),
      flags: flagsUnderTest,
      chainNow: async () => 1_700_000_000,
      act,
      onLog: () => {},
    });

    await loop.sweep();
    expect(act).not.toHaveBeenCalled();

    delete back[SWEEP_FLAG];
    await flagsUnderTest.refresh();
    await loop.sweep();
    expect(act).toHaveBeenCalledTimes(1);
    expect(loop.status().killed).toBe(false);
  });

  it("names the switch on the error the guarded path rejects with", async () => {
    const flagsUnderTest = flags({ [SWEEP_FLAG]: true });
    await expect(flagsUnderTest.require(SWEEP_FLAG, () => "sent")).rejects.toBeInstanceOf(Killed);
  });
});
