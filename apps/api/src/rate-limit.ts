import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, Next } from "hono";

/**
 * In-memory, per-client token-bucket rate limiter.
 *
 * Why this exists: the API holds no keys and every route is a read, but "reads" are not
 * free — every `/snapshot` re-runs `buildSnapshot` over the whole read model and the
 * event loop is shared with the indexer tailing the chain. One client looping on
 * `/snapshot` would starve every other request and the chain sync behind them. The
 * rate limiter is the thing that keeps that from being one line away.
 *
 * The store is process-local. That is the right scope for a single-process server; it is
 * explicitly *not* correct behind a load balancer, where each instance would have its
 * own bucket. If that ever becomes the deployment, swap the Map for Redis and keep the
 * interface. Anything pretending to be a shared counter without doing that is a lie.
 *
 * All bounds are per second, as whole tokens, so a limit cannot go below zero or half a
 * token. Buckets refill continuously rather than in discrete bursts, so a client
 * pounding at a steady rate gets a steady answer instead of a wall.
 */

export interface RateLimitConfig {
  /** sustained requests allowed per window */
  limit: number;
  /** window length in milliseconds */
  windowMs: number;
  /** extra burst capacity, tokens, on top of the steady rate */
  burst?: number;
}

interface Bucket {
  tokens: number;
  /** last refill, unix ms */
  updated: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly refillRate: number;
  private readonly capacity: number;

  constructor(private readonly cfg: RateLimitConfig) {
    if (!Number.isFinite(cfg.limit) || cfg.limit < 1) throw new Error("limit must be >= 1");
    if (!Number.isFinite(cfg.windowMs) || cfg.windowMs <= 0) throw new Error("windowMs must be > 0");
    // The burst is the capacity ABOVE the sustained rate, so a negative one would make
    // the bucket smaller than the rate it refills at: a client allowed 60/min would
    // hold a bucket of 40 and be refused for 20 seconds every minute. It is not
    // reachable from the environment today, and it is refused here so that the day it
    // is reachable is not the day it starts eating traffic.
    if (cfg.burst !== undefined && (!Number.isFinite(cfg.burst) || cfg.burst < 0)) {
      throw new Error("burst must be >= 0");
    }

    this.refillRate = cfg.limit / (cfg.windowMs / 1000); // tokens per second
    this.capacity = cfg.limit + (cfg.burst ?? 0);
  }

  /** Test a request without consuming. */
  peek(key: string): { allowed: boolean; retryAfterMs: number } {
    const bucket = this.refill(key);
    if (bucket.tokens >= 1) return { allowed: true, retryAfterMs: 0 };
    const missing = 1 - bucket.tokens;
    return { allowed: false, retryAfterMs: Math.ceil((missing / this.refillRate) * 1000) };
  }

  /** Consume one token, or return how long to wait. */
  consume(key: string): { allowed: boolean; retryAfterMs: number; remaining: number } {
    const bucket = this.refill(key);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterMs: 0, remaining: Math.floor(bucket.tokens) };
    }
    const missing = 1 - bucket.tokens;
    return { allowed: false, retryAfterMs: Math.ceil((missing / this.refillRate) * 1000), remaining: 0 };
  }

  /** Reap buckets that have fully refilled, so the map does not grow forever. */
  sweep(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updated >= this.cfg.windowMs * 2 && bucket.tokens >= this.capacity) {
        this.buckets.delete(key);
      }
    }
  }

  /** Fair to a first-time client and to a client returning after silence: both start full. */
  private refill(key: string): Bucket {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this.capacity, updated: now };
      this.buckets.set(key, bucket);
      return bucket;
    }

    const elapsed = now - bucket.updated;
    if (elapsed > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + (elapsed / 1000) * this.refillRate);
      bucket.updated = now;
    }
    return bucket;
  }
}

/**
 * Hono middleware.
 *
 * Identity is the hard part, and the naive version was wrong: reading `X-Forwarded-For`
 * unconditionally means the client chooses which bucket it lands in, so 200 requests with 200
 * distinct spoofed values is 200 fresh buckets and zero 429s. A header the caller writes is
 * only evidence of anything once you have agreed who is allowed to write it.
 *
 * So forwarded headers are honoured only when `trustProxy` is set explicitly, which means the
 * process is known to sit behind something that SETS `X-Forwarded-For` — Caddy and nginx both
 * do, and Caddy replaces it with the peer it saw rather than appending to whatever the caller
 * sent. Without it the key is the socket peer — the one address this process can actually
 * observe. The trade is spelled out in `proxiedIdentity`: with the proxy off, every visitor
 * behind it shares one bucket, and with it on, the key is the address the proxy recorded.
 *
 * `Retry-After` is the part that makes this a feature rather than a wall of 429s: a
 * well-behaved client waits and comes back, and an honest GUI backs off instead of hammering.
 */
export function rateLimit(config: RateLimitConfig & { trustProxy?: boolean }) {
  const limiter = new RateLimiter(config);
  const trustProxy = config.trustProxy ?? false;

  // The sweep only matters if clients keep coming; an otherwise idle process leaks no
  // memory because there is no timer.
  let sweepTimer: ReturnType<typeof setInterval> | undefined;

  const ensureSweeper = () => {
    if (!sweepTimer) sweepTimer = setInterval(() => limiter.sweep(), config.windowMs);
    sweepTimer.unref?.();
  };

  return async function middleware(c: Context, next: Next) {
    ensureSweeper();

    const identity = trustProxy ? proxiedIdentity(c) : socketAddress(c);

    const verdict = limiter.consume(identity ?? "shared");
    if (verdict.allowed) {
      c.header("RateLimit-Limit", String(config.limit));
      c.header("RateLimit-Remaining", String(verdict.remaining));
      await next();
      return;
    }

    // The budget headers belong on the refusal too: a client that is being
    // throttled is exactly the client that needs to know what its budget is.
    c.header("RateLimit-Limit", String(config.limit));
    c.header("RateLimit-Remaining", "0");
    c.header("Retry-After", String(Math.ceil(verdict.retryAfterMs / 1000)));
    return c.json(
      { error: "Slow down — too many requests.", retryAfterMs: verdict.retryAfterMs },
      429,
    );
  };
}

/**
 * The client address, as seen through a proxy that is trusted to set the forwarded headers.
 *
 * **One header, and it is `X-Forwarded-For`.**
 *
 * The right-most entry is the one. Every proxy in this deployment's shape puts the address it
 * actually saw at the end of the chain: nginx's `$proxy_add_x_forwarded_for` appends
 * `$remote_addr`, and Caddy *replaces* the header with the peer it saw ("by default, the
 * proxy will ignore their values from incoming requests, to prevent spoofing"). The left-most
 * entry is whatever the caller sent, so reading it lets a client mint a fresh bucket per
 * request — the exact bypass this limiter exists to prevent.
 *
 * **`X-Real-IP` is deliberately NOT read, and the reason is not stylistic.** It used to be read
 * FIRST, on the belief that "a proxy that sets it overwrites it, and Caddy does exactly that
 * (`header_up X-Real-IP {remote_host}`)". That belief was wrong twice over:
 *
 *   * Caddy does not set `X-Real-IP` by default. Its documented defaults are
 *     `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`; anything else has to be
 *     configured with an explicit `header_up`.
 *   * Caddy passes every OTHER incoming header through to the backend untouched — "By default,
 *     Caddy passes through incoming headers—including Host—to the backend without
 *     modifications". So a client that sends `X-Real-IP: 203.0.113.9` reaches this process with
 *     that value intact.
 *
 * Reading it first therefore handed the bucket key to the caller: one header on the request was
 * enough to get a fresh 60/min allowance, forever. A limiter whose key is chosen by the party it
 * is meant to limit is not a limiter, so the header is gone rather than demoted.
 *
 * `CF-Connecting-IP` is not trusted either. It is only meaningful when the peer is Cloudflare,
 * and this process has no way to know that. A header any caller can write cannot be evidence of
 * anything.
 *
 * With no `X-Forwarded-For` at all, the socket peer is used. That is the proxy's own address
 * when a proxy is in front and forgot the header, and the client's address when there is no
 * proxy — either way it is an address this process observed rather than one it was told.
 */
function proxiedIdentity(c: Context): string | null {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    // The hop closest to this process is the one the last proxy saw.
    const closest = hops[hops.length - 1];
    if (closest) return closest;
  }

  return socketAddress(c);
}

/**
 * The peer address of the underlying socket, when there is one.
 *
 * `getConnInfo` only exists for a request that arrived through `@hono/node-server`; a test
 * calling `app.request()` has no socket at all. Returning null rather than throwing lets the
 * caller fall back to one shared bucket — the conservative answer, because an identity that
 * cannot be established must not become an exemption.
 */
function socketAddress(c: Context): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}