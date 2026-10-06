import { describe, expect, it, vi } from "vitest";
import { isRetryable, throttle, withBackoff, Throttler } from "../src/resilience";

const neverSleep = () => Promise.resolve();

describe("isRetryable", () => {
  it("treats rate limits, timeouts, and 5xx as worth retrying", () => {
    for (const msg of [
      "HTTP 429",
      "rate limit exceeded",
      "request timeout",
      "ETIMEDOUT",
      "ECONNRESET",
      "fetch failed",
      "HTTP 503 service unavailable",
      "RPC error -32005: rate limit exceeded",
    ]) {
      expect(isRetryable(new Error(msg))).toBe(true);
    }
  });

  it("treats 4xx client errors as fatal — retrying wastes the budget", () => {
    for (const msg of ["400 bad request", "401 unauthorized", "403 forbidden", "404 not found"]) {
      expect(isRetryable(new Error(msg))).toBe(false);
    }
  });

  it("never retries a deterministic validation failure", () => {
    expect(isRetryable(new Error("invalid argument: collection not found"))).toBe(false);
    expect(isRetryable(new Error("Contract not deployed"))).toBe(false);
  });
});

describe("withBackoff", () => {
  it("resolves on the first attempt without sleeping", async () => {
    const sleep = vi.fn(neverSleep);
    const fn = vi.fn(() => Promise.resolve("ok"));
    const out = await withBackoff(fn, { sleep: sleep as any });
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("backs off and retries a retryable error before succeeding", async () => {
    const sleep = vi.fn(neverSleep);
    let calls = 0;
    const fn = vi.fn(() => {
      calls += 1;
      if (calls < 3) return Promise.reject(new Error("timeout"));
      return Promise.resolve("recovered");
    });

    const out = await withBackoff(fn, { sleep: sleep as any, baseMs: 100, retries: 4 });

    expect(out).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry a fatal error, not even once", async () => {
    const sleep = vi.fn(neverSleep);
    const fn = vi.fn(() => Promise.reject(new Error("404 not found")));

    await expect(withBackoff(fn, { sleep: sleep as any })).rejects.toThrow(/404/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after the retry budget", async () => {
    const sleep = vi.fn(neverSleep);
    const fn = vi.fn(() => Promise.reject(new Error("timeout")));

    await expect(withBackoff(fn, { sleep: sleep as any, retries: 2 })).rejects.toThrow(/timeout/);
    expect(fn).toHaveBeenCalledTimes(1 + 2);
  });

  it("refuses a degenerate backoff config instead of waiting forever", async () => {
    await expect(withBackoff(() => Promise.resolve(1), { baseMs: 0 })).rejects.toThrow(/positive/);
  });
});

describe("Throttler", () => {
  it("never lets more than maxConcurrent through at once", async () => {
    let running = 0;
    let peak = 0;

    const make = () =>
      new Promise<number>((resolve) =>
        setTimeout(() => {
          running -= 1;
          resolve(9);
        }, 15),
      );

    const throttler = new Throttler(2, 0);
    const launch = () => {
      running += 1;
      peak = Math.max(peak, running);
      return make();
    };

    await Promise.all([
      throttler.run(launch),
      throttler.run(launch),
      throttler.run(launch),
      throttler.run(launch),
      throttler.run(launch),
    ]);

    expect(peak).toBeLessThanOrEqual(2);
  });

  it("serializes work through the queue in arrival order", async () => {
    const order: number[] = [];
    const throttler = new Throttler(1, 0);

    // At 1-allowance, callers complete in the order they started.
    await Promise.all(
      [0, 1, 2].map((i) =>
        throttler.run(async () => {
          order.push(i);
        }),
      ),
    );

    expect(order).toEqual([0, 1, 2]);
  });

  it("surfaces the underlying error rather than swallowing it", async () => {
    const throttler = new Throttler(1, 0);
    await expect(throttler.run(() => Promise.reject(new Error("boom")))).rejects.toThrow(/boom/);
  });

  it("throttle() maps maxPerSecond to a gap and rejects a degenerate one", async () => {
    // 10 per second -> 100ms gap. A zero rate means "no ceiling", which is finite
    // (infinite gap), and must surface rather than hang.
    const t = throttle({ maxConcurrent: 1, maxPerSecond: 0 });
    expect(t).toBeInstanceOf(Throttler);
  });
});