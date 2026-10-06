/**
 * Resilience primitives for the network-bound parts of the monorepo.
 *
 * Why these live in `smith-sdk`: every component that talks to a chain — the `Crucible`
 * client, the Scribe indexer, the web app's read path, the agent's provider clients —
 * needs the *same* backoff and throttling policy. If each invented its own, a 429 from
 * one provider becomes a retry storm while another silently gives up. Shared policy is
 * the only way that stays true.
 *
 * Two failure modes to avoid, and the shape that avoids them:
 *
 * 1. **Thundering herd on a participant failure.** A flaky RPC makes every client in the
 *    process hammer retries. Fixed with backoff *plus jitter*, so clients do not line up
 *    in lockstep.
 * 2. **A doomed retry being repeated.** A 400/validation error is deterministic, so
 *    retrying it wastes the whole backoff budget for a response that will not change.
 *    Fixed by only retrying errors that can plausibly heal.
 */

export interface BackoffOptions {
  /** max retry attempts after the first try */
  retries?: number;
  /** base delay in ms — the first retry waits roughly this */
  baseMs?: number;
  /** exponential multiplier per attempt */
  factor?: number;
  /** ceiling on any one delay */
  maxMs?: number;
  /** what a fuzzer or a human might call this operation, for error messages */
  operation?: string;
  /** injectable clock so tests do not wait */
  now?: () => number;
  /** injectable sleep so tests do not wait */
  sleep?: (ms: number) => Promise<void>;
}

/** Errors that can plausibly succeed on a retry. Everything else is deterministic and must not be retried. */
export function isRetryable(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("timeout") || msg.includes("timed out")) {
    return true;
  }
  if (msg.includes("econnreset") || msg.includes("etimedout") || msg.includes("econnrefused")) {
    return true;
  }
  if (msg.includes("fetch failed") || msg.includes("network") || msg.includes("502") || msg.includes("503") || msg.includes("504")) {
    return true;
  }
  if (msg.includes("-32005")) return true; // JSON-RPC "rate limit exceeded"
  if (msg.includes("500")) return true;
  return false;
}

/**
 * Run `fn`, retrying only failures worth retrying, with exponential backoff
 * and full jitter.
 *
 * Full jitter — each wait is drawn uniformly from `[0, delay]` — is the form Hattie and
 * Stewart recommend for this: a client that just lost a connection should not "sleep
 * exactly 800ms", it should sample. Sampling desynchronizes the herd.
 */
export async function withBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions = {}): Promise<T> {
  const retries = opts.retries ?? 4;
  const baseMs = opts.baseMs ?? 250;
  const factor = opts.factor ?? 2;
  const maxMs = opts.maxMs ?? 8_000;
  const operation = opts.operation ?? "operation";
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let attempt = 0;
  // Non-finite budget guards: a NaN delay means an infinite wait, which is the opposite
  // of resilience.
  if (baseMs <= 0 || factor <= 0 || maxMs <= 0) {
    throw new Error("backoff parameters must be positive");
  }

  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) {
        // Out of budget, or no point trying again. Rethrow so the caller can show the
        // same error it would have seen without the wrapper.
        throw err;
      }

      const ceiling = Math.min(maxMs, baseMs * factor ** attempt);
      // full jitter: uniform in [0, ceiling]
      const delay = Math.floor(Math.random() * ceiling);
      if (delay > 0) await sleep(delay);
      attempt += 1;
    }
  }
}

/**
 * A concurrency + rate throttler for calls that are all going to the same place.
 *
 * Two distinct constraints, both honored:
 *   1. `maxConcurrent` — at most N in flight at once. A chain RPC that honours nothing
 *      else will at least not be asked fifty things at once.
 *   2. `maxPerSecond` — at most one token per interval. This is what stops a tight
 *      backfill loop from bursting over the server's quota.
 *
 * The limiter is a promise queue, not a semaphore reset by timers, so a burst is
 * serialized in arrival order rather than racing itself.
 */
export class Throttler {
  private inFlight = 0;
  private queue: (() => void)[] = [];
  private lastStart = 0;

  constructor(
    private readonly maxConcurrent: number,
    /** minimum gap between starts, ms */
    private readonly minIntervalMs: number,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise<void>((r) => setTimeout(r, ms)),
  ) {
    if (maxConcurrent < 1) throw new Error("maxConcurrent must be >= 1");
    if (minIntervalMs < 0) throw new Error("minIntervalMs must be >= 0");
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queue.push(release);
    // Pump the queue *before* suspending. Calling it after the await means the waiting
    // caller never reaches the pump, and the queue never drains — a quiet deadlock that
    // the "ran for 15s and got nothing" test loudly rejects.
    this.pump();
    await acquired;
  }

  private release(): void {
    this.inFlight -= 1;
    this.pump();
  }

  private pump(): void {
    // Start as many queued callers as concurrency + rate allow.
    while (this.inFlight < this.maxConcurrent && this.queue.length > 0) {
      const now = Date.now();
      const wait = Math.max(0, this.minIntervalMs - (now - this.lastStart));
      if (wait > 0) {
        // Not fair to a waiting task to spin: sleep the remainder, then retry.
        void this.sleep(wait).then(() => this.pump());
        return;
      }
      const next = this.queue.shift();
      if (next) {
        this.inFlight += 1;
        this.lastStart = Date.now();
        next();
      }
    }
  }
}

export interface ThrottleConfig {
  maxConcurrent?: number;
  maxPerSecond?: number;
}

/** Sensible default for a local Anvil: fast, no rate ceiling. */
export const NO_THROTTLE: Required<ThrottleConfig> = {
  maxConcurrent: 16,
  maxPerSecond: 1_000,
};

export function throttle(config: ThrottleConfig = {}): Throttler {
  const maxConcurrent = Math.max(1, config.maxConcurrent ?? NO_THROTTLE.maxConcurrent);
  const maxPerSecond = config.maxPerSecond ?? NO_THROTTLE.maxPerSecond;
  return new Throttler(maxConcurrent, maxPerSecond <= 0 ? Number.POSITIVE_INFINITY : 1000 / maxPerSecond);
}

/**
 * A simple concurrency tag for a public RPC: at most `maxConcurrent` requests running
 * against the same endpoint at once. The client libraries are not throttled by the
 * transport, so wrapping the *caller* — which is how `Crucible` does it — is the right
 * place. Keeping it in one object means one ceiling for the whole client.
 */
export class RpcThrottler {
  private readonly inner: Throttler;

  constructor(maxConcurrent = 8) {
    this.inner = new Throttler(maxConcurrent, 0);
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    return this.inner.run(fn);
  }
}