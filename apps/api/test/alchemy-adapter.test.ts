import { describe, expect, it } from "vitest";
import {
  isSupportedChain,
  classifyProviderError,
  backoffMs,
  newCircuitBreaker,
  recordFailure,
  recordSuccess,
  maybeHalfOpen,
  canAttempt,
} from "../src/alchemy-adapter.js";

describe("alchemy adapter", () => {
  it("validates supported chain ids", () => {
    expect(isSupportedChain(1)).toBe(true);
    expect(isSupportedChain(11155111)).toBe(true);
    expect(isSupportedChain(999999)).toBe(false);
  });

  it("classifies provider errors", () => {
    expect(classifyProviderError(new Error("request timeout"))).toBe("timeout");
    expect(classifyProviderError(new Error("429 too many requests"))).toBe("rate_limit");
    expect(classifyProviderError(new Error("502 bad gateway"))).toBe("server");
    expect(classifyProviderError(new Error("400 bad request"))).toBe("client");
    expect(classifyProviderError(new Error("something else"))).toBe("unknown");
  });

  it("backoff is bounded and uses jitter", () => {
    const a = backoffMs({ baseMs: 100, maxMs: 1000, attempt: 0, random: () => 0.5 });
    expect(a).toBeGreaterThanOrEqual(100);
    expect(a).toBeLessThanOrEqual(1000);
    const b = backoffMs({ baseMs: 100, maxMs: 1000, attempt: 10, random: () => 0 });
    expect(b).toBe(1000);
  });

  it("circuit breaker opens after threshold", () => {
    let cb = newCircuitBreaker(2, 1000);
    cb = recordFailure(cb, 0);
    expect(cb.state).toBe("closed");
    cb = recordFailure(cb, 0);
    expect(cb.state).toBe("open");
    expect(canAttempt(cb, 0)).toBe(false);
    // after reset window, half-open
    const cb2 = maybeHalfOpen(cb, 2000);
    expect(cb2.state).toBe("half_open");
    expect(canAttempt(cb2, 2000)).toBe(true);
  });

  it("recordSuccess resets", () => {
    let cb = newCircuitBreaker(2, 1000);
    cb = recordFailure(cb, 0);
    cb = recordSuccess(cb);
    expect(cb.state).toBe("closed");
    expect(cb.failures).toBe(0);
  });
});
