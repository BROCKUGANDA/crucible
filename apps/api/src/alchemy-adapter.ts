/**
 * Alchemy adapter — provider-neutral RPC + submission helpers.
 *
 * Infrastructure only: Alchemy is RPC/indexing/bundler plumbing, not a chain.
 * This module never holds or exposes administrative tokens; credentials are
 * read from environment by the caller. It provides pure, testable helpers:
 *   - chain ID validation (never trust the browser)
 *   - provider error classification
 *   - bounded exponential backoff with jitter
 *   - circuit-breaker state machine
 *
 * Network submission and signing are intentionally NOT implemented here — they
 * require credentials and a deployment manifest that are owner-provided.
 */

export const SUPPORTED_CHAIN_IDS = new Set<number>([1, 11155111, 8453, 84532, 137, 80002]);

export function isSupportedChain(chainId: number): boolean {
  return SUPPORTED_CHAIN_IDS.has(chainId);
}

export type ProviderErrorKind = "timeout" | "rate_limit" | "server" | "client" | "unknown";

export function classifyProviderError(err: unknown): ProviderErrorKind {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("etimedout")) return "timeout";
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests")) return "rate_limit";
  if (/\b5\d\d\b/.test(msg) || msg.includes("502") || msg.includes("503") || msg.includes("504")) return "server";
  if (/\b4\d\d\b/.test(msg) || msg.includes("invalid") || msg.includes("bad request")) return "client";
  return "unknown";
}

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  attempt: number;
  /** injectable for tests; defaults to Math.random */
  random?: () => number;
}

export function backoffMs(opts: BackoffOptions): number {
  const random = opts.random ?? Math.random;
  const exp = Math.min(opts.maxMs, opts.baseMs * Math.pow(2, opts.attempt));
  const jitter = random() * opts.baseMs;
  return Math.min(opts.maxMs, exp + jitter);
}

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreaker {
  state: CircuitState;
  failures: number;
  openedAt: number | null;
  threshold: number;
  resetAfterMs: number;
}

export function newCircuitBreaker(threshold = 5, resetAfterMs = 30_000): CircuitBreaker {
  return { state: "closed", failures: 0, openedAt: null, threshold, resetAfterMs };
}

export function recordFailure(cb: CircuitBreaker, now = Date.now()): CircuitBreaker {
  const failures = cb.failures + 1;
  if (failures >= cb.threshold) {
    return { ...cb, state: "open", failures, openedAt: now };
  }
  return { ...cb, failures };
}

export function recordSuccess(cb: CircuitBreaker): CircuitBreaker {
  return { ...cb, state: "closed", failures: 0, openedAt: null };
}

export function maybeHalfOpen(cb: CircuitBreaker, now = Date.now()): CircuitBreaker {
  if (cb.state === "open" && cb.openedAt !== null && now - cb.openedAt >= cb.resetAfterMs) {
    return { ...cb, state: "half_open" };
  }
  return cb;
}

export function canAttempt(cb: CircuitBreaker, now = Date.now()): boolean {
  const cb2 = maybeHalfOpen(cb, now);
  return cb2.state === "closed" || cb2.state === "half_open";
}
