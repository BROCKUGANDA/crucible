/**
 * One clock for every live stream.
 *
 * Each subscriber used to run its own `setTimeout(TICK_MS)` loop and compare signatures
 * for itself. Two things are wrong with that at any real connection count:
 *
 * 1. Latency is a full tick by construction. A chain event that lands 1ms after a client
 *    woke has to wait out the whole interval before that client looks again. The ceiling
 *    was the tick, not the chain.
 * 2. The cost scales with the audience. N clients meant N timers waking N times a second
 *    to re-run the same comparison against the same shared object, on the one event loop
 *    that also has to answer requests and drive the indexer. Nothing about the answer
 *    depended on how many were asking.
 *
 * So the reading happens once, here, and a subscriber waits to be told. The interval is
 * one per process whatever the audience, and a waiter resolves the moment the generated
 * payload changes rather than at the end of a sleep it happened to be in.
 *
 * The fallback sleep is still here, and it is not laziness: a payload whose visible fields
 * did not change produces no new frame for anyone, which is the correct outcome, and the
 * sleep is what gives the heartbeat its cadence.
 */

export interface PumpFrame {
  /** Monotonic. A waiter is looking for a value other than the one it last saw. */
  generation: number;
  signature: string;
  payload: string;
}

export interface TickPumpOptions {
  /** Builds or returns the cached frame for this instant. Must be cheap to call. */
  read: () => { signature: string; payload: string };
  /** How often the shared read model is consulted. One timer, whatever the audience. */
  intervalMs: number;
  /** Lets a test drive the pump by hand instead of waiting on wall time. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export class TickPump {
  private frame: PumpFrame = { generation: 0, signature: "", payload: "" };
  private timer: (() => void) | null = null;
  private readonly waiters = new Set<{
    generation: number;
    resolve: (frame: PumpFrame) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }>();
  private closed = false;

  constructor(private readonly opts: TickPumpOptions) {}

  get current(): PumpFrame {
    return this.frame;
  }

  /**
   * Starts the single interval. Called once per process by whoever owns the app, not per
   * request: a pump started lazily per stream is the N-timer problem wearing a different
   * hat.
   */
  start(): void {
    if (this.timer) return;
    // Cleared here, not only in the constructor. `stop()` sets `closed` so a waiter whose
    // pump has gone away is released instead of hanging; if `start()` did not undo it, the
    // refcount dropping to zero between two viewers would leave the pump permanently
    // "closed", `wait()` would resolve instantly forever, and every later subscriber would
    // spin the event loop at full speed instead of sleeping. That is a self-inflicted
    // denial of service on the busiest route, reached by the ordinary sequence
    // connect → disconnect → reconnect.
    this.closed = false;
    const schedule =
      this.opts.schedule ??
      ((fn: () => void, ms: number) => {
        const id = setInterval(fn, ms);
        return () => clearInterval(id);
      });
    // Take one reading immediately, so the first subscriber is not waiting on a timer for
    // a frame that was available at start-up.
    this.advance();
    this.timer = schedule(() => this.advance(), this.opts.intervalMs);
  }

  stop(): void {
    this.timer?.();
    this.timer = null;
    this.closed = true;
    // Release everyone still waiting. A stream whose pump stopped and whose waiter never
    // resolves is a socket held open forever, and the stream counter never comes down.
    this.wakeAll();
  }

  /** Re-reads the shared frame and bumps the generation only if something visible moved. */
  advance(): void {
    const next = this.opts.read();
    // Signature only, deliberately. The payload carries `now`, which differs on every
    // rebuild, so comparing payloads would wake every client on every tick for a frame
    // whose content is identical — moving the waste from CPU to the wire. `now` is not a
    // visible change: the client re-anchors and counts locally between snapshots.
    if (next.signature === this.frame.signature) return;
    this.frame = { generation: this.frame.generation + 1, ...next };
    this.wakeAll();
  }

  /**
   * Resolves at the next frame whose generation differs from `since`.
   *
   * An `AbortSignal` resolves it early with the current frame, because the caller's socket
   * is going away and the loop must reach its `finally` to give the stream slot back.
   */
  wait(since: number, signal?: AbortSignal): Promise<PumpFrame> {
    if (this.frame.generation !== since || this.closed) return Promise.resolve(this.frame);
    return new Promise((resolve) => {
      const entry = { generation: this.frame.generation, resolve, signal } as {
        generation: number;
        resolve: (frame: PumpFrame) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      };
      const onAbort = (): void => {
        this.waiters.delete(entry);
        resolve(this.frame);
      };
      entry.onAbort = onAbort;
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.add(entry);
    });
  }

  /** Live waiters. A metric worth exposing: it is the real audience size. */
  get waiterCount(): number {
    return this.waiters.size;
  }

  private wakeAll(): void {
    for (const entry of this.waiters) {
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
      this.waiters.delete(entry);
      entry.resolve(this.frame);
    }
  }
}
