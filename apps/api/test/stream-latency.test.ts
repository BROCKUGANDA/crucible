import { afterEach, afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { TickPump } from "../src/tick-pump.js";
import { emptyModel } from "@crucible/indexer";

/**
 * Latency that does not depend on how many people are watching.
 *
 * The route used to give every subscriber its own one-second sleep and its own signature
 * comparison. Two consequences, both of which the previous suite could not see because it
 * only ever had one or three clients and never measured a duration:
 *
 *   - the delay before a client learned something had happened was up to a full tick,
 *     chosen by where in that tick the event landed, not by the chain;
 *   - the work per tick grew with the audience, on the same event loop that serves
 *     requests and drives the indexer, so a crowded demo slowed down for exactly the
 *     people who were watching it most closely.
 *
 * These tests assert the shape instead of the story: one read per tick whatever the
 * waiter count, and a delivery time bounded well under the old tick, measured at one
 * client and at twenty.
 */

describe("TickPump", () => {
  /**
   * The reconnect case, which is the one that bit.
   *
   * The pump is refcounted: it stops when the last viewer leaves and starts again when the
   * next one arrives. `stop()` flags the pump closed so parked waiters are released; if
   * `start()` does not undo that flag, `wait()` returns immediately for the rest of the
   * process's life and every subscriber spins the loop at full tilt instead of sleeping.
   * The sequence is the ordinary one — connect, disconnect, connect — and the symptom is
   * the exact thing this file exists to prevent: latency and CPU that collapse under a
   * reconnecting audience.
   */
  it("sleeps properly again after being stopped and restarted", async () => {
    let signature = "a";
    const pump = new TickPump({
      read: () => ({ signature, payload: "{}" }),
      intervalMs: 10,
    });
    pump.start();
    pump.stop();
    pump.start();

    let wokeEarly = false;
    const first = pump.wait(pump.current.generation).then(() => (wokeEarly = true));
    await new Promise((r) => setTimeout(r, 80));
    expect(wokeEarly).toBe(false);

    signature = "b";
    await first;
    expect(wokeEarly).toBe(true);
    pump.stop();
  });

  it("reads the shared source once per tick, whatever the number of waiters", async () => {
    let reads = 0;
    let signature = "a";
    const pending: Array<() => void> = [];
    const pump = new TickPump({
      read: () => {
        reads += 1;
        return { signature, payload: "{}" };
      },
      intervalMs: 250,
      // Driven by hand so this asserts the call graph, not the clock.
      schedule: (fn) => {
        pending.push(fn);
        return () => {};
      },
    });
    pump.start();

    const before = pump.current.generation;
    const waiters = Array.from({ length: 40 }, () => pump.wait(before));
    expect(waiters.length).toBe(40);

    signature = "b";
    pending.forEach((tick) => tick());
    await Promise.all(waiters);

    // Forty clients waiting, one read. The old loop would have done forty.
    expect(reads).toBe(2);
    pump.stop();
  });

  it("does not wake anyone when nothing visible changed", async () => {
    const pump = new TickPump({
      read: () => ({ signature: "same", payload: "{}" }),
      intervalMs: 10,
    });
    pump.start();
    const generation = pump.current.generation;
    let woke = false;
    const raced = await Promise.race([
      pump.wait(generation).then(() => (woke = true)),
      new Promise((r) => setTimeout(r, 60)),
    ]);
    expect(woke).toBe(false);
    expect(raced).toBe(undefined);
    pump.stop();
  });

  it("releases a waiter whose socket went away, so its slot is given back", async () => {
    const pump = new TickPump({ read: () => ({ signature: "x", payload: "{}" }), intervalMs: 10 });
    pump.start();
    const ac = new AbortController();
    const pending = pump.wait(pump.current.generation, ac.signal);
    expect(pump.waiterCount).toBe(1);
    ac.abort();
    await pending;
    expect(pump.waiterCount).toBe(0);
    pump.stop();
  });

  it("releases every waiter on stop, so no stream is left hanging on a dead pump", async () => {
    const pump = new TickPump({ read: () => ({ signature: "x", payload: "{}" }), intervalMs: 10 });
    pump.start();
    const generation = pump.current.generation;
    const all = Array.from({ length: 10 }, () => pump.wait(generation));
    pump.stop();
    await Promise.all(all);
    expect(pump.waiterCount).toBe(0);
  });
});

describe("/stream latency against the audience size", () => {
  /**
   * Ephemeral port, and a force-close.
   *
   * Two reasons, both learned the hard way. A fixed port makes this file collide with any
   * earlier run whose process is still alive, and an `EADDRINUSE` here looks like a product
   * defect rather than a test hygiene failure. And `server.close()` is graceful: it waits
   * for open connections, which for a route whose entire purpose is to hold a socket open
   * means it never returns and the port stays bound after the run. `closeAllConnections()`
   * is what actually releases it.
   */
  const servers: Array<{ close: () => void; closeAllConnections?: () => void }> = [];

  async function stopServer(server: { close: () => void; closeAllConnections?: () => void }) {
    server.closeAllConnections?.();
    server.close();
  }

  afterEach(async () => {
    while (servers.length) await stopServer(servers.pop()!);
  });

  afterAll(async () => {
    while (servers.length) await stopServer(servers.pop()!);
  });

  async function serve() {
    const { serve } = await import("@hono/node-server");
    const model = emptyModel();
    const app = createApp({ getModel: () => model }, { rateLimit: false, streamPollMs: 250 });
    const server = await new Promise<ReturnType<typeof serve>>((res) => {
      const s = serve({ fetch: app.fetch, port: 0 }, () => res(s));
    });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not get a TCP address");
    return { model, port: address.port };
  }

  /**
   * Measures, per client, the wall time between one change to the read model and that
   * client receiving a frame that actually carries it.
   *
   * Deliberately one bump, after a settle, and matched on the new trial's own id rather
   * than on "any snapshot". Timing the first frame after a bump would happily count a
   * frame that was already in flight, and matching on id proves the client received the
   * change rather than something older.
   */
  async function measureDelivery(port: number, clients: number, marker: string, change: () => void) {
    const opened = await Promise.all(
      Array.from({ length: clients }, async () => {
        const ac = new AbortController();
        const res = await fetch(`http://127.0.0.1:${port}/stream`, { signal: ac.signal });
        return { ac, reader: res.body!.getReader(), dec: new TextDecoder(), text: "" };
      }),
    );

    try {
      // Drain the opening snapshot each client is promised.
      for (const c of opened) {
        const first = await c.reader.read();
        expect(new TextDecoder().decode(first.value)).toContain("event: snapshot");
      }

      // Let anything already in flight land before the timed change.
      await new Promise((r) => setTimeout(r, 400));

      const started = performance.now();
      change();

      const readUntil = async (c: (typeof opened)[number]): Promise<number> => {
        const deadline = performance.now() + 10_000;
        for (;;) {
          const { value, done } = await c.reader.read();
          if (done) throw new Error("stream ended before the change arrived");
          c.text += c.dec.decode(value, { stream: true });
          if (c.text.includes(marker)) return performance.now() - started;
          if (performance.now() > deadline) throw new Error(`no frame carried ${marker} within 10s`);
        }
      };

      return await Promise.all(opened.map((c) => readUntil(c)));
    } finally {
      opened.forEach((c) => c.ac.abort());
    }
  }

  /** A trial the signature can see, so the change is a real one and not a version poke. */
  function addVisibleTrial(model: ReturnType<typeof emptyModel>, id: number) {
    model.trials.set(id, {
      id,
      sponsor: "0x" + "01".repeat(20),
      specCID: null,
      testsCID: null,
      specDigest: "0x" + "02".repeat(32),
      testsDigest: "0x" + "03".repeat(32),
      rewardWei: 10n ** 18n,
      bondWei: 2n * 10n ** 17n,
      payoutWei: null,
      createdAt: 1_700_000_000,
      deadline: 2_000_000_000,
      breakWindow: 43_200,
      agentId: null,
      runHash: null,
      runAt: null,
      breakSkeptic: null,
      breakStakeWei: null,
      breakProofCID: null,
      status: "open",
      verdict: "none",
      disputeOpenedAt: null,
    });
    model.version += 1;
  }

  it("delivers a change to every one of twenty clients in well under the old one-second tick", async () => {
    const { model, port } = await serve();
    addVisibleTrial(model, 1);
    const times = await measureDelivery(port, 20, '"id":2', () => addVisibleTrial(model, 2));

    const worst = Math.max(...times);
    const median = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];
    // Printed because a passing timing assertion that never shows its numbers cannot be
    // reviewed — and because the gap between "worst 240ms" and "worst 740ms" is the whole
    // claim, and it is invisible in a green tick.
    console.log(
      `20 clients: median ${median.toFixed(0)}ms, worst ${worst.toFixed(0)}ms, ` +
        `spread ${(worst - Math.min(...times)).toFixed(0)}ms`,
    );
    // The old per-client sleep meant up to ~1000ms before a client even looked, so this
    // bound fails on that shape and passes on the pump's, whose ceiling is its interval.
    // It is absolute rather than relative on purpose: "no worse than the median" is
    // satisfiable by a system that is slow for everyone.
    expect(worst).toBeLessThan(750);
    expect(median).toBeLessThan(400);
  }, 60_000);

  it("does not get slower for the last client than for the first", async () => {
    const { model, port } = await serve();
    let next = 1;
    addVisibleTrial(model, next);

    const spread = async (clients: number) => {
      next += 1;
      const marker = `"id":${next}`;
      const times = await measureDelivery(port, clients, marker, () => addVisibleTrial(model, next));
      return Math.max(...times) - Math.min(...times);
    };

    const alone = await spread(1);
    const crowd = await spread(15);
    // Per-client timers contend on one event loop, so a crowd widens the spread between
    // the fastest and slowest observer. One pump resolves every waiter in one pass.
    expect(crowd).toBeLessThanOrEqual(Math.max(alone + 250, 400));
  }, 60_000);
});
