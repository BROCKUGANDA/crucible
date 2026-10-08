/**
 * The resilience patterns every network-bound service in this monorepo needs, settled once
 * here instead of re-invented per caller. `resilience.ts` owns retry policy (`withBackoff`)
 * and admission control (`Throttler`); this file owns the rest of the checklist: circuit
 * breaking, deadlines, cancellation, coalescing, bounded maps, self-scheduling jobs and kill
 * switches.
 *
 * The reason these are library code and not local idioms: each one is trivially writable from
 * memory and each one is wrong when written from memory. A breaker that never half-opens, a
 * `Promise.race` that cancels nothing, a single-flight map that caches its own failures — all
 * three look correct in review and all three fail in production under load. One reviewed
 * implementation is cheaper than twelve unreviewed ones.
 */

export type BreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** appears in error copy and in `/health`, so it has to be stable across deploys */
  name: string;
  /** failures inside `windowMs` that open the breaker */
  threshold?: number;
  /** how long the breaker stays fully open before letting a probe through */
  cooldownMs?: number;
  /** sliding window failures are counted in */
  windowMs?: number;
  /** attempts allowed while half-open — the anti-thundering-herd knob */
  halfOpenMax?: number;
  now?: () => number;
}

/** Why the last call was refused, kept separate from the message so copy can branch on it. */
export type BreakerOpenReason = "cooldown" | "probe-budget";

export class BreakerOpen extends Error {
  readonly breaker: string;
  readonly retryAfterMs: number;
  readonly openedAt: number;
  readonly reason: BreakerOpenReason;

  constructor(breaker: string, retryAfterMs: number, openedAt: number, reason: BreakerOpenReason) {
    super(
      reason === "cooldown"
        ? `Dependency "${breaker}" is tripped. Try again in ${Math.ceil(retryAfterMs)}ms.`
        : `Dependency "${breaker}" is being probed before it reopens fully. Try again in ${Math.ceil(retryAfterMs)}ms.`,
    );
    this.name = "BreakerOpen";
    this.breaker = breaker;
    this.retryAfterMs = retryAfterMs;
    this.openedAt = openedAt;
    this.reason = reason;
  }
}

export interface BreakerSnapshot {
  readonly name: string;
  readonly state: BreakerState;
  readonly openedAt: number | null;
  readonly lastFailure: number | null;
  readonly failureTimes: readonly number[];
  readonly consecutiveSuccesses: number;
}

export interface BreakerStatus {
  readonly state: BreakerState;
  readonly failures: number;
  readonly openedAt: number | null;
  readonly lastFailure: number | null;
  readonly consecutiveSuccesses: number;
  readonly probesUsed: number;
  /** ms until the cooldown lifts; null unless the breaker is time-gated */
  readonly retryAfterMs: number | null;
}

/**
 * Trips on `threshold` failures inside `windowMs`, blocks for `cooldownMs`, then admits
 * `halfOpenMax` probe(s) to find out whether the dependency came back.
 */
export class CircuitBreaker {
  readonly name: string;
  readonly threshold: number;
  readonly cooldownMs: number;
  readonly windowMs: number;
  readonly halfOpenMax: number;

  private readonly clock: () => number;
  private state: BreakerState = "closed";
  private failureTimes: number[] = [];
  private openedAt: number | null = null;
  private lastFailure: number | null = null;
  private consecutiveSuccesses = 0;
  private probesUsed = 0;

  constructor(opts: CircuitBreakerOptions) {
    const threshold = opts.threshold ?? 5;
    const cooldownMs = opts.cooldownMs ?? 30_000;
    const windowMs = opts.windowMs ?? 30_000;
    const halfOpenMax = opts.halfOpenMax ?? 1;
    if (!opts.name) throw new Error("CircuitBreaker needs a name: errors and health output key off it");
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new Error(`threshold must be an integer >= 1 (got ${threshold})`);
    }
    if (!Number.isInteger(halfOpenMax) || halfOpenMax < 1) {
      throw new Error(`halfOpenMax must be an integer >= 1 (got ${halfOpenMax})`);
    }
    if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) {
      throw new Error(`cooldownMs must be a positive finite number (got ${cooldownMs})`);
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error(`windowMs must be a positive finite number (got ${windowMs})`);
    }
    this.name = opts.name;
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.windowMs = windowMs;
    this.halfOpenMax = halfOpenMax;
    this.clock = opts.now ?? (() => Date.now());
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const refused = this.admit();
    if (refused) throw refused;
    try {
      const out = await fn();
      this.onSuccess();
      return out;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  /** What a health endpoint reports, so it never has to reach into the state machine. */
  status(): BreakerStatus {
    const now = this.clock();
    const remaining = this.openedAt === null ? 0 : this.cooldownMs - (now - this.openedAt);
    // Reported, not stored: a window that has slid past its failures should not keep showing
    // them, and a getter that mutates the state machine would be its own kind of bug.
    const live = this.failureTimes.filter((t) => now - t < this.windowMs);
    return {
      state: this.state,
      failures: live.length,
      openedAt: this.openedAt,
      lastFailure: this.lastFailure,
      consecutiveSuccesses: this.consecutiveSuccesses,
      probesUsed: this.probesUsed,
      retryAfterMs: this.state === "open" ? Math.max(0, remaining) : null,
    };
  }

  saveState(): BreakerSnapshot {
    return {
      name: this.name,
      state: this.state,
      openedAt: this.openedAt,
      lastFailure: this.lastFailure,
      failureTimes: [...this.failureTimes],
      consecutiveSuccesses: this.consecutiveSuccesses,
    };
  }

  /**
   * Rebuilds a breaker from a snapshot taken before a restart, so an outage that outlasts a
   * deploy is still protected against.
   *
   * The trade-off, chosen deliberately: state is persisted as absolute wall-clock values and
   * the cooldown is re-derived from them, so a breaker restored after a long pause has spent
   * its cooldown and probes on the first call. Storing "remaining ms" instead would keep
   * blocking traffic from a dependency nobody has touched since the last process died — and
   * half-open is the honest state after an unobserved hour. Clock skew is the residual risk:
   * a restored clock running *behind* `openedAt` keeps the breaker open longer, which fails
   * toward protection rather than toward load.
   *
   * Writing the snapshot is the caller's job, also deliberately: keeping I/O out of the state
   * machine means a slow or failing store cannot stall the hot path, at the cost of losing at
   * most the last transition if the process dies between the trip and the write.
   */
  static restore(opts: CircuitBreakerOptions, snapshot: BreakerSnapshot | null): CircuitBreaker {
    const breaker = new CircuitBreaker(opts);
    if (!snapshot) return breaker;
    if (snapshot.name !== opts.name) {
      throw new Error(`breaker snapshot is for "${snapshot.name}", not "${opts.name}"`);
    }
    breaker.state = snapshot.state;
    breaker.openedAt = snapshot.openedAt;
    breaker.lastFailure = snapshot.lastFailure;
    breaker.consecutiveSuccesses = snapshot.consecutiveSuccesses;
    // A failure older than the window is forgiven on restore exactly as it would be in a live
    // process; otherwise a restarted service inherits a burst that already expired.
    const now = breaker.clock();
    breaker.failureTimes = snapshot.failureTimes.filter(
      (t) => Number.isFinite(t) && now - t < breaker.windowMs,
    );
    breaker.probesUsed = 0;
    return breaker;
  }

  /**
   * Reserves the caller's right to run, or returns the refusal it should reject with. Also
   * advances open -> half-open once the cooldown has elapsed.
   */
  private admit(): BreakerOpen | null {
    const now = this.clock();
    if (this.state === "open") {
      const elapsed = Math.max(0, now - (this.openedAt ?? now));
      if (elapsed < this.cooldownMs) {
        return new BreakerOpen(this.name, this.cooldownMs - elapsed, this.openedAt ?? now, "cooldown");
      }
      this.state = "half-open";
      this.probesUsed = 0;
    }
    if (this.state === "half-open") {
      if (this.probesUsed >= this.halfOpenMax) {
        // The held probe has not settled, so there is no timed transition to promise: quote a
        // whole cooldown, which is what happens if that probe fails.
        return new BreakerOpen(this.name, this.cooldownMs, this.openedAt ?? now, "probe-budget");
      }
      this.probesUsed += 1;
    }
    return null;
  }

  private onSuccess(): void {
    this.consecutiveSuccesses += 1;
    if (this.state === "half-open") this.close();
  }

  private onFailure(): void {
    const now = this.clock();
    this.lastFailure = now;
    this.consecutiveSuccesses = 0;
    this.failureTimes.push(now);
    this.prune(now);
    // A single failure while half-open trips it: the probe *is* the evidence.
    if (this.state === "half-open" || this.failureTimes.length >= this.threshold) this.trip(now);
  }

  private close(): void {
    this.state = "closed";
    this.failureTimes = [];
    this.probesUsed = 0;
  }

  private trip(now: number): void {
    this.state = "open";
    this.openedAt = now;
    this.probesUsed = 0;
  }

  private prune(now: number): void {
    this.failureTimes = this.failureTimes.filter((t) => now - t < this.windowMs);
  }
}

export type TimeoutReason = "deadline" | "cancelled";

export class TimeoutError extends Error {
  readonly tag: string;
  readonly afterMs: number;
  readonly reason: TimeoutReason;

  constructor(tag: string, afterMs: number, reason: TimeoutReason) {
    super(
      reason === "deadline"
        ? `"${tag}" did not return within ${afterMs}ms`
        : `"${tag}" was cancelled with ${afterMs}ms of budget still unspent`,
    );
    this.name = "TimeoutError";
    this.tag = tag;
    this.afterMs = afterMs;
    this.reason = reason;
  }
}

export interface TimeoutOptions {
  /** the caller's own cancellation: the wait ends now instead of idling to the deadline */
  signal?: AbortSignal;
  /**
   * Fires when the deadline is hit, immediately before the rejection. Wire this to
   * `controller.abort()` — this wrapper has no lever on work it was only handed a promise for.
   */
  onTimeout?: (err: TimeoutError) => void;
}

/**
 * Rejects with a typed `TimeoutError` if `work` outlives `ms`.
 *
 * `Promise.race([work, delay(ms)])` does not cancel `work`. A promise is not a process: racing
 * it only stops you from *looking* at the result, so the underlying call keeps running, keeps
 * its socket, its memory and its side effects — and the delay timer stays armed for its full
 * length even when `work` wins, which on a 30s deadline is 30s of held handles per call. A
 * deadline is only honest when it reaches through to the thing doing the work, which is what
 * `onTimeout` is for; and the incoming promise is always handled here, even after we have given
 * up on it, so a late rejection cannot surface as an unhandledRejection.
 */
export function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  tag: string,
  opts: TimeoutOptions = {},
): Promise<T> {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(`withTimeout("${tag}"): ms must be a finite, non-negative number (got ${ms})`);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const signal = opts.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stopWatching = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const onDeadline = () => {
      if (settled) return;
      settled = true;
      stopWatching();
      const err = new TimeoutError(tag, ms, "deadline");
      try {
        opts.onTimeout?.(err);
      } catch (hookErr) {
        // The deadline is the signal the caller asked for; a broken hook rides along as cause.
        err.cause = hookErr;
      }
      reject(err);
    };

    function onAbort() {
      if (settled) return;
      settled = true;
      stopWatching();
      reject(new TimeoutError(tag, ms, "cancelled"));
    }

    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort);
    if (!settled) timer = setTimeout(onDeadline, ms);

    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        stopWatching();
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        stopWatching();
        reject(err);
      },
    );
  });
}

export interface DeadlineOptions {
  now?: () => number;
  label?: string;
}

/**
 * A request-scoped time budget. A child call gets *this deadline's remainder*, never a fresh
 * timeout, or an N-deep call chain quietly gets N times the budget you promised the user.
 * `child()` is the only way to derive a budget, which makes the mistake structural instead of
 * a code-review finding.
 */
export class Deadline {
  /** absolute epoch ms at which the whole budget is spent */
  readonly at: number;
  readonly label: string;

  private readonly clock: () => number;
  private spentAt: number | null = null;

  /**
   * `ms` starts a fresh budget; `{ at }` adopts a deadline propagated from a caller we are
   * serving (an HTTP header, a queue message), which is the only way the whole chain ends up
   * sharing one number.
   */
  constructor(budget: number | { at: number }, opts: DeadlineOptions = {}) {
    const clock = opts.now ?? (() => Date.now());
    const label = opts.label ?? "deadline";
    if (typeof budget === "number") {
      if (!Number.isFinite(budget) || budget <= 0) {
        throw new Error(`Deadline("${label}"): ms must be a positive finite number (got ${budget})`);
      }
      this.at = clock() + budget;
    } else {
      if (!Number.isFinite(budget.at)) {
        throw new Error(`Deadline("${label}"): at must be a finite epoch ms (got ${budget.at})`);
      }
      this.at = budget.at;
    }
    this.label = label;
    this.clock = clock;
  }

  get expired(): boolean {
    return this.remainingMs() <= 0;
  }

  remainingMs(): number {
    if (this.spentAt !== null) return 0;
    return Math.max(0, this.at - this.clock());
  }

  /**
   * The budget a child call may take. `fraction` reserves headroom for the parent: with 400ms
   * left, `child(0.6)` hands the child 240ms and keeps 160ms for the caller to turn an answer
   * into a response.
   */
  child(fraction = 1): number {
    if (!(fraction > 0) || fraction > 1) {
      throw new Error(`Deadline("${this.label}").child(): fraction must be in (0, 1] (got ${fraction})`);
    }
    return Math.floor(this.remainingMs() * fraction);
  }

  /** Spends the budget early, when the caller already knows the request is dead. */
  expire(): void {
    this.spentAt = this.clock();
  }
}

/**
 * Concurrent calls under the same key share one in-flight promise, so a cache miss behind a
 * slow dependency costs one upstream call instead of N. This is the cache-stampede fix.
 *
 * The map entry is dropped when the promise settles, *including* on rejection: coalescing a
 * failure is fine, replaying one forever is how a single bad lookup becomes permanent outage.
 * A producer that never settles holds its key until it does — give such a call `withTimeout`.
 */
export class SingleFlight {
  private readonly inflight = new Map<string, Promise<unknown>>();

  get size(): number {
    return this.inflight.size;
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;

    // The async wrapper turns a synchronous throw out of `fn` into a rejection, so `run` is a
    // promise-returning function for every input — otherwise a badly-behaved producer escapes
    // as an exception and the caller never learns to retry.
    const flight = (async () => fn())().finally(() => {
      // Only drop our own generation: if a later call already replaced the entry, deleting
      // here would un-coalesce the flight that is actually in progress.
      if (this.inflight.get(key) === flight) this.inflight.delete(key);
    });
    this.inflight.set(key, flight);
    return flight;
  }
}

/**
 * Process-wide flight registry, because the point is that two unrelated call sites doing the
 * same lookup coalesce without coordinating. A long-lived daemon or a test should build its
 * own `SingleFlight` so a key's lifetime is bounded by an object it owns.
 */
export const defaultFlight = new SingleFlight();

export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return defaultFlight.run(key, fn);
}

/**
 * `items.map(fn)` with at most `limit` calls in flight and order-preserving results.
 *
 * On the first failure the pool stops *pulling* new work but does not abandon work it already
 * handed out: every in-flight call still settles, so the caller gets exactly one rejection and
 * no orphaned promises. Stopping a call that is already running is not something a map can do
 * — that is what `withTimeout`'s abort hook is for.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R> | R,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`mapLimit: limit must be an integer >= 1 (got ${limit})`);
  }
  const out = new Array<R>(items.length);
  if (items.length === 0) return out;

  let cursor = 0;
  let failed = false;
  let firstError: unknown;

  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        out[index] = await fn(items[index] as T, index);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
        return;
      }
    }
  };

  const pool: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) pool.push(worker());
  await Promise.all(pool);

  if (failed) throw firstError;
  return out;
}

export interface LoopOptions {
  intervalMs: number;
  /**
   * Receives anything `fn` threw, and anything *this* callback threw. A loop that dies
   * silently is worse than one that dies loudly, so failures are reported rather than dropped
   * on the floor as an unhandled rejection.
   */
  onError?: (err: unknown, info: { tick: number; lastError: unknown }) => void;
  sleep?: (ms: number) => Promise<void>;
  /** default true: a loop that waits a whole interval before its first run leaves a cold window after every boot */
  runImmediately?: boolean;
}

export interface LoopHandle {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  /** iterations launched, not iterations that succeeded — a stuck tick is what an operator needs to see */
  readonly ticks: number;
  readonly lastError: unknown;
  /** resolves when the loop has exited; an iteration already in flight finishes first */
  settled(): Promise<void>;
}

/**
 * A loop that schedules its next run only after the previous one has settled, which is the
 * only reason it exists instead of `setInterval`. `setInterval` fires on a wall-clock schedule
 * whether or not the last callback returned, so a job that occasionally outruns its period
 * piles up overlapping runs until the process is a queue of half-finished work. Here each
 * iteration is awaited, and the await yields the event loop on the way through.
 */
export function selfSchedulingLoop(fn: () => unknown, opts: LoopOptions): LoopHandle {
  if (!Number.isFinite(opts.intervalMs) || opts.intervalMs < 0) {
    throw new Error(
      `selfSchedulingLoop: intervalMs must be a finite, non-negative number (got ${opts.intervalMs})`,
    );
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const runFirst = opts.runImmediately !== false;

  let running = false;
  let ticks = 0;
  let lastError: unknown = null;
  let exit: Promise<void> = Promise.resolve();
  let finish: () => void = () => {};
  let wake: (() => void) | null = null;

  const waitInterval = async (): Promise<void> => {
    let release!: () => void;
    // `stop()` has to be able to cut a wait short, so the wait is gated on a latch it can
    // fire. Whatever timer the injected sleep started is left to expire on its own — a sleep
    // we do not own is a sleep we cannot cancel, and its deadline belongs to the caller.
    const gate = new Promise<void>((r) => {
      release = r;
    });
    wake = release;
    try {
      await Promise.race([sleep(opts.intervalMs), gate]);
    } finally {
      if (wake === release) wake = null;
    }
  };

  const cycle = async (): Promise<void> => {
    let first = runFirst;
    try {
      while (running) {
        if (!first) {
          await waitInterval();
          if (!running) return;
        }
        first = false;
        ticks += 1;
        try {
          await fn();
        } catch (err) {
          lastError = err;
          try {
            opts.onError?.(err, { tick: ticks, lastError });
          } catch (reportErr) {
            // A caller whose reporter throws still gets a loop that keeps running.
            lastError = reportErr;
          }
        }
      }
    } finally {
      running = false;
      finish();
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      exit = new Promise<void>((r) => {
        finish = r;
      });
      void cycle();
    },
    stop() {
      running = false;
      const release = wake;
      wake = null;
      release?.();
    },
    isRunning: () => running,
    get ticks() {
      return ticks;
    },
    get lastError() {
      return lastError;
    },
    settled: () => exit,
  };
}

export class Killed extends Error {
  readonly flag: string;
  constructor(flag: string) {
    super(`"${flag}" is killed. This path stays off until the flag is released.`);
    this.name = "Killed";
    this.flag = flag;
  }
}

export type FlagMap = Record<string, boolean>;

export interface FlagsOptions {
  /** each poll fetches the whole map: a switch you have to ask about one flag at a time is slower to flip */
  source: () => Promise<FlagMap> | FlagMap;
  /** a cache older than this refreshes before it answers */
  ttlMs?: number;
  /** background poll interval; 0 disables polling and leaves every stale read to do the work */
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onError?: (err: unknown) => void;
  autoStart?: boolean;
}

/**
 * Kill switches and flags, read synchronously off a cached snapshot that a background poll
 * keeps fresh.
 *
 * The contract this shape exists for: flipping a switch takes effect in under a minute with no
 * deploy. `pollMs` is what that costs, so the default is 10_000 — a flip lands in one poll, an
 * eighth of the budget. `ttlMs` defaults to 15_000 and is the backstop for the poller not
 * running: `require()` refreshes a cache older than the TTL before it answers, so the
 * guarantee survives a dead loop. Reads stay synchronous because a flag check sits on the hot
 * path, and a flag check that has to be awaited is a flag check that gets skipped.
 */
export class Flags {
  readonly ttlMs: number;
  readonly pollMs: number;

  private readonly clock: () => number;
  private values: FlagMap = {};
  private fetchedAt: number | null = null;
  private lastKnownError: unknown = null;
  private readonly flight = new SingleFlight();
  private loop: LoopHandle | null = null;

  constructor(private readonly opts: FlagsOptions) {
    const ttlMs = opts.ttlMs ?? 15_000;
    const pollMs = opts.pollMs ?? 10_000;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(`Flags: ttlMs must be a positive finite number (got ${ttlMs})`);
    }
    if (!Number.isFinite(pollMs) || pollMs < 0) {
      throw new Error(`Flags: pollMs must be a non-negative finite number (got ${pollMs})`);
    }
    if (typeof opts.source !== "function") {
      throw new Error("Flags: a source is required — an unbacked flag is just a constant");
    }
    this.ttlMs = ttlMs;
    this.pollMs = pollMs;
    this.clock = opts.now ?? (() => Date.now());
    if (opts.autoStart !== false) this.start();
  }

  /** The last known answer, never a guess: an unknown flag is off. */
  enabled(name: string): boolean {
    return this.values[name] === true;
  }

  async require<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    if (this.stale) await this.refresh();
    if (this.enabled(name)) throw new Killed(name);
    return fn();
  }

  /** Concurrent refreshes coalesce: a slow flag service must not fan out into a request per caller. */
  refresh(): Promise<void> {
    return this.flight.run("flags", async () => {
      try {
        this.values = await this.opts.source();
        this.fetchedAt = this.clock();
      } catch (err) {
        // Serve the last snapshot. Losing contact with the flag service is no licence to
        // switch half the product off, and no licence to crash the process either.
        this.report(err);
      }
    });
  }

  get stale(): boolean {
    return this.fetchedAt === null || this.clock() - this.fetchedAt >= this.ttlMs;
  }

  get lastError(): unknown {
    return this.lastKnownError;
  }

  lastSeenAt(): number | null {
    return this.fetchedAt;
  }

  start(): void {
    if (this.loop || this.pollMs === 0) return;
    this.loop = selfSchedulingLoop(() => this.refresh(), {
      intervalMs: this.pollMs,
      sleep: this.opts.sleep,
      onError: (err) => this.report(err),
    });
    this.loop.start();
  }

  /** Stops the poller and waits out the in-flight refresh, so shutdown cannot leave one writing. */
  async stop(): Promise<void> {
    const loop = this.loop;
    if (!loop) return;
    loop.stop();
    await loop.settled();
    // Cleared only once the old loop is gone: a stop/start pair must never leave two pollers
    // writing the same snapshot.
    if (this.loop === loop) this.loop = null;
  }

  private report(err: unknown): void {
    this.lastKnownError = err;
    try {
      this.opts.onError?.(err);
    } catch (reportErr) {
      this.lastKnownError = reportErr;
    }
  }
}
