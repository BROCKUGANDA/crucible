import { describe, expect, it, vi } from "vitest";
import { defaultFlight, mapLimit, SingleFlight, singleFlight } from "../src/patterns.js";
import { deferred, VirtualClock } from "./support/vclock";

describe("SingleFlight", () => {
  it("coalesces eight concurrent identical calls into one upstream invocation", async () => {
    const flight = new SingleFlight();
    const gate = deferred<string>();
    const upstream = vi.fn(() => gate.promise);

    const calls = Array.from({ length: 8 }, () => flight.run("trial/42", upstream));
    expect(upstream).toHaveBeenCalledTimes(1);

    gate.resolve("one fetch");
    expect(await Promise.all(calls)).toEqual(Array.from({ length: 8 }, () => "one fetch"));
  });

  it("serves every waiter the same settled value", async () => {
    const flight = new SingleFlight();
    const gate = deferred<{ cid: string }>();
    let invoked = 0;
    const producer = () => {
      invoked += 1;
      return gate.promise;
    };

    const a = flight.run("cid", producer);
    const b = flight.run("cid", producer);
    const payload = { cid: "bafy" };
    gate.resolve(payload);

    expect(await a).toBe(payload);
    expect(await b).toBe(payload);
    expect(invoked).toBe(1);
  });

  it("releases the key on success, so a later call goes upstream again", async () => {
    const flight = new SingleFlight();
    const upstream = vi.fn(() => Promise.resolve("fresh"));

    await flight.run("block/1", upstream);
    expect(flight.size).toBe(0);
    await flight.run("block/1", upstream);

    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure: waiters see the error and the next call retries", async () => {
    const flight = new SingleFlight();
    const boom = new Error("ipfs unavailable");
    const gate = deferred<string>();
    const upstream = vi.fn(() => gate.promise);

    const pending = [flight.run("block/2", upstream), flight.run("block/2", upstream)];
    expect(upstream).toHaveBeenCalledTimes(1);

    gate.reject(boom);
    await expect(pending[0]).rejects.toBe(boom);
    await expect(pending[1]).rejects.toBe(boom);
    expect(flight.size).toBe(0);

    // The very next call must be a real attempt, not a replay of the old rejection.
    const recovered = vi.fn(() => Promise.resolve("back up"));
    await expect(flight.run("block/2", recovered)).resolves.toBe("back up");
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it("keeps distinct keys independent", async () => {
    const flight = new SingleFlight();
    const upstream = vi.fn((key: string) => Promise.resolve(key));

    const out = await Promise.all([
      flight.run("a", () => upstream("a")),
      flight.run("b", () => upstream("b")),
    ]);

    expect(out).toEqual(["a", "b"]);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("tracks only in-flight keys", async () => {
    const flight = new SingleFlight();
    const gate = deferred<string>();

    const inFlight = flight.run("x", () => gate.promise);
    expect(flight.size).toBe(1);

    gate.resolve("done");
    await vi.waitFor(() => expect(flight.size).toBe(0));
  });

  it("turns a producer that throws synchronously into a rejection, and frees the key", async () => {
    const flight = new SingleFlight();

    await expect(
      flight.run("bad", () => {
        throw new Error("producer exploded before returning");
      }),
    ).rejects.toThrow(/producer exploded/);

    expect(flight.size).toBe(0);
    await expect(flight.run("bad", () => Promise.resolve("fine"))).resolves.toBe("fine");
  });

  it("the process-wide helper shares one registry, which is the point of it", async () => {
    const key = `singleFlight-test/${Math.random()}`;
    const gate = deferred<number>();
    const upstream = vi.fn(() => gate.promise);

    const a = singleFlight(key, upstream);
    const b = singleFlight(key, upstream);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(defaultFlight.size).toBe(1);

    gate.resolve(7);
    expect(await Promise.all([a, b])).toEqual([7, 7]);
    expect(defaultFlight.size).toBe(0);
  });
});

describe("mapLimit", () => {
  it("never exceeds the limit in flight, measured rather than assumed", async () => {
    const clock = new VirtualClock();
    const items = Array.from({ length: 12 }, (_, i) => i);
    let running = 0;
    let peak = 0;

    const run = mapLimit(items, 3, async (i) => {
      running += 1;
      peak = Math.max(peak, running);
      await clock.sleep(10 + i * 3);
      running -= 1;
      return i * 2;
    });
    await clock.advance(10_000);

    expect(peak).toBe(3);
    expect(await run).toEqual(items.map((i) => i * 2));
    expect(clock.pending).toBe(0);
  });

  it("holds at one worker when asked to", async () => {
    const clock = new VirtualClock();
    const started: number[] = [];
    let running = 0;
    let peak = 0;

    const run = mapLimit([0, 1, 2, 3], 1, async (i) => {
      started.push(i);
      running += 1;
      peak = Math.max(peak, running);
      await clock.sleep(5);
      running -= 1;
      return i;
    });
    await clock.advance(10_000);

    expect(await run).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(1);
    expect(started).toEqual([0, 1, 2, 3]);
  });

  it("keeps output order when completion order is the reverse", async () => {
    const clock = new VirtualClock();
    const items = ["a", "b", "c", "d", "e"];

    const run = mapLimit(items, 5, async (item, index) => {
      // Earlier items take longer, so they finish last.
      await clock.sleep((items.length - index) * 10);
      return item.toUpperCase();
    });
    await clock.advance(10_000);

    expect(await run).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("rejects with the failure and stops handing out new work, without hanging", async () => {
    const clock = new VirtualClock();
    const items = [0, 1, 2, 3, 4, 5];
    const started: number[] = [];
    const finished: number[] = [];
    const boom = new Error("item 1 is broken");

    const failure = mapLimit(items, 2, async (i) => {
      started.push(i);
      await clock.sleep(i === 1 ? 10 : 50);
      if (i === 1) throw boom;
      finished.push(i);
      return i;
    }).then(
      () => null,
      (err) => err as unknown,
    );
    await clock.advance(10_000);

    expect(await failure).toBe(boom);
    // Two workers took items 0 and 1 and got no further: the pool stopped pulling.
    expect(started).toEqual([0, 1]);
    expect(finished).toEqual([0]);
    expect(clock.pending).toBe(0);
  });

  it("surfaces the error that happened first in time", async () => {
    const clock = new VirtualClock();
    const late = new Error("failed at 30ms");
    const early = new Error("failed at 10ms");

    const failure = mapLimit([0, 1, 2], 3, async (i) => {
      await clock.sleep([30, 10, 5][i] as number);
      if (i === 0) throw late;
      if (i === 1) throw early;
      return "ok";
    }).then(
      () => null,
      (err) => err as unknown,
    );
    await clock.advance(10_000);

    expect(await failure).toBe(early);
    expect(clock.pending).toBe(0);
  });

  it("settles every in-flight call before rejecting, so nothing is orphaned", async () => {
    const clock = new VirtualClock();
    const settled: string[] = [];
    const boom = new Error("nope");

    const run = mapLimit([0, 1, 2], 1, async (i) => {
        await clock.sleep(5);
        if (i === 0) {
          settled.push("0 resolved");
          return i;
        }
        settled.push("1 rejected");
        throw boom;
      }).then(
        (value) => ({ value, err: null }),
        (err) => ({ value: null, err: err as unknown }),
      );
    await clock.advance(10_000);

    expect(await run).toEqual({ value: null, err: boom });
    expect(settled).toEqual(["0 resolved", "1 rejected"]);
    expect(clock.pending).toBe(0);
  });

  it("handles a limit larger than the work", async () => {
    const clock = new VirtualClock();
    let running = 0;
    let peak = 0;

    const run = mapLimit(["x", "y", "z"], 10, async (s) => {
      running += 1;
      peak = Math.max(peak, running);
      await clock.sleep(1);
      running -= 1;
      return s + s;
    });
    await clock.advance(10_000);

    expect(peak).toBe(3);
    expect(await run).toEqual(["xx", "yy", "zz"]);
  });

  it("maps nothing without calling anything", async () => {
    const fn = vi.fn();
    expect(await mapLimit([], 4, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("accepts a synchronous fn", async () => {
    const out = await mapLimit([1, 2, 3], 2, (n) => n * 10);
    expect(out).toEqual([10, 20, 30]);
  });

  it("passes the index through, so callers do not have to zip it themselves", async () => {
    const seen: Array<[string, number]> = [];
    await mapLimit(["a", "b"], 2, (item, index) => {
      seen.push([item, index]);
      return item;
    });
    expect(seen).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
  });

  it("keeps a result slot per input even when a producer hands back undefined", async () => {
    const clock = new VirtualClock();
    const run = mapLimit([1, 2, 3], 2, async (n) => {
      await clock.sleep(n);
      return n % 2 === 0 ? undefined : `odd-${n}`;
    });
    await clock.advance(10_000);

    expect(await run).toEqual(["odd-1", undefined, "odd-3"]);
  });

  it("refuses a limit that would mean no progress or no bound", async () => {
    await expect(mapLimit([1], 0, (n) => n)).rejects.toThrow(/limit/);
    await expect(mapLimit([1], 1.5, (n) => n)).rejects.toThrow(/limit/);
    await expect(mapLimit([1], Number.NaN, (n) => n)).rejects.toThrow(/limit/);
  });
});
