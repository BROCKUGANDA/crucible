import { afterEach, describe, expect, it, vi } from "vitest";
import { BreakerOpen, CircuitBreaker, Flags } from "@crucible/smith";
import type { PassReport } from "../src/operator.js";
import { createPatrolLoop, VOTE_FLAG } from "../src/patrol.js";

/**
 * The two guards that sit between an operator and the chain.
 *
 * A seat signs verdicts, so both guards are stronger here than they look: the kill switch is the
 * only way to stop a committee mid-dispute without a redeploy, and the breaker is the only thing
 * that keeps a node outage from turning into a queue of transactions that cannot land.
 */

function breaker(cooldownMs = 60_000): CircuitBreaker {
  return new CircuitBreaker({ name: "juror.rpc", threshold: 3, windowMs: 60_000, cooldownMs });
}

/** Polling off: the switch is flipped through `refresh()`, so nothing depends on machine speed. */
function flags(back: Record<string, boolean>): Flags {
  return new Flags({ source: async () => ({ ...back }), pollMs: 0 });
}

const EMPTY = (over: Partial<PassReport> = {}): PassReport => ({
  now: 1_800_000_000,
  considered: 0,
  actions: [],
  counts: { commit: 0, reveal: 0, abstain: 0, forfeit: 0, drop: 0, hold: 0, error: 0 },
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the seat's kill switch", () => {
  it("refuses the pass entirely while juror.vote is on, calling nothing", async () => {
    const back: Record<string, boolean> = { [VOTE_FLAG]: true };
    const pass = vi.fn(async () => EMPTY());

    const loop = createPatrolLoop({
      intervalMs: 1_000,
      flags: flags(back),
      breaker: breaker(),
      pass,
      onLog: () => {},
    });

    await loop.pass();
    expect(pass).not.toHaveBeenCalled();
    expect(loop.status().killed).toBe(true);
  });

  /**
   * The property that turns a halt into a halt rather than a crash loop.
   *
   * `compose.yaml` probes this process and restarts it when `/health` stops saying "fresh". If a
   * killed pass left `lastPassAt` where it was, the probe would fail, Docker would restart the
   * seat, the flag would still be on, and the operator's "stop voting" would have produced a
   * container that restarts forever.
   */
  it("keeps the appointment when it is killed, so the probe does not restart it", async () => {
    const back: Record<string, boolean> = { [VOTE_FLAG]: true };
    const guard = flags(back);
    const loop = createPatrolLoop({
      intervalMs: 1_000,
      flags: guard,
      breaker: breaker(),
      pass: async () => EMPTY(),
      onLog: () => {},
    });

    await loop.pass();
    const first = loop.status().lastPassAt;
    expect(first).not.toBeNull();

    await new Promise((r) => setTimeout(r, 5));
    await loop.pass();
    expect(loop.status().lastPassAt).not.toBe(first);
    expect(loop.status().lastPassActed).toBe(0);
  });

  it("resumes the moment the switch is released, with no restart", async () => {
    const back: Record<string, boolean> = { [VOTE_FLAG]: true };
    const guard = flags(back);
    const pass = vi.fn(async () => EMPTY({ counts: { ...EMPTY().counts, commit: 2 } }));

    const loop = createPatrolLoop({
      intervalMs: 1_000,
      flags: guard,
      breaker: breaker(),
      pass,
      onLog: () => {},
    });

    await loop.pass();
    expect(pass).not.toHaveBeenCalled();

    delete back[VOTE_FLAG];
    await guard.refresh();
    await loop.pass();

    expect(pass).toHaveBeenCalledTimes(1);
    expect(loop.status().killed).toBe(false);
    expect(loop.status().lastPassActed).toBe(2);
  });
});

describe("the seat behind a circuit breaker", () => {
  it("refuses the fourth pass after three failures, without running the operator", async () => {
    const pass = vi.fn(async (): Promise<PassReport> => {
      throw new Error("connection refused");
    });
    const guard = breaker();

    const loop = createPatrolLoop({ intervalMs: 1_000, flags: flags({}), breaker: guard, pass, onLog: () => {} });

    for (let i = 0; i < 3; i += 1) await expect(loop.pass()).rejects.toThrow("connection refused");
    expect(pass).toHaveBeenCalledTimes(3);
    expect(loop.status().breaker.state).toBe("open");

    await expect(loop.pass()).rejects.toBeInstanceOf(BreakerOpen);
    // A tripped breaker must not reach the node at all: the whole pass — block read, index read,
    // and the reveal it was going to send — is what gets refused.
    expect(pass).toHaveBeenCalledTimes(3);
  });

  it("closes again when a pass answers, so an outage that heals needs no restart", async () => {
    let down = true;
    const guard = new CircuitBreaker({ name: "juror.rpc", threshold: 3, windowMs: 60_000, cooldownMs: 5 });
    const loop = createPatrolLoop({
      intervalMs: 1_000,
      flags: flags({}),
      breaker: guard,
      pass: async () => {
        if (down) throw new Error("connection refused");
        return EMPTY({ counts: { ...EMPTY().counts, reveal: 1 } });
      },
      onLog: () => {},
    });

    for (let i = 0; i < 3; i += 1) await expect(loop.pass()).rejects.toThrow("connection refused");
    expect(loop.status().breaker.state).toBe("open");

    down = false;
    await new Promise((r) => setTimeout(r, 10));
    await loop.pass();
    expect(loop.status().breaker.state).toBe("closed");
    expect(loop.status().lastPassActed).toBe(1);
  });
});

describe("the patrol loop's cadence", () => {
  /**
   * The reason this is `selfSchedulingLoop` and not `setInterval`.
   *
   * A seat's pass can outrun its interval by a wide margin: the verification is a container run
   * with a 900-second budget. Two passes in flight over one read model would post the same
   * commitment twice and read the same nonces twice — and unlike the keeper's `finalize`, a
   * duplicate commit is not harmless, it is `AlreadyCommitted` in the second transaction and a
   * seat that looks broken in the logs while it is not.
   */
  it("never overlaps itself, and starts each pass off the last one finishing", async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const starts: number[] = [];
    let live = 0;
    let peak = 0;

    const loop = createPatrolLoop({
      intervalMs: 1_000,
      flags: flags({}),
      breaker: breaker(),
      pass: async () => {
        starts.push(Date.now() - t0);
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 2_500));
        live -= 1;
        return EMPTY();
      },
      onLog: () => {},
    });

    loop.handle.start();
    await vi.advanceTimersByTimeAsync(12_000);
    loop.handle.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(peak).toBe(1);
    expect(starts).toEqual([1_000, 4_500, 8_000, 11_500]);
    expect(loop.handle.isRunning()).toBe(false);
  });
});
