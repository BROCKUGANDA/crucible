/**
 * @file security-controls.ts — Security middleware (Phase 7).
 *
 * Implements missing security controls identified in the audit:
 * - CSRF protection for state-mutating requests
 * - Input size limits to prevent large payload attacks
 * - Webhook signature verification for outbound webhooks
 *
 * These controls address findings from CRUCIBLE_AUDIT.md:
 * - Missing CSRF protection (finding #14)
 * - No input size limits (finding #13)
 * - No webhook signature verification (finding #12)
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/* ------------------------------------------------------------------ */
/* CSRF Protection                                                    */
/* ------------------------------------------------------------------ */

/**
 * Generate a CSRF token. The token is bound to the session and expires
 * after a configurable duration.
 */
export function generateCsrfToken(sessionId: string, expiresMs: number = 3600_000): string {
  const payload = `${sessionId}:${Date.now()}:${expiresMs}`;
  const token = randomBytes(32).toString("hex");
  return `${token}.${payload}`;
}

/**
 * Validate a CSRF token. Uses timing-safe comparison to prevent
 * timing attacks.
 */
export function validateCsrfToken(
  token: string,
  sessionId: string,
  secret: string,
): boolean {
  if (!token || !sessionId || !secret) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const [hash, payload] = parts;
  if (!payload) return false;
  const [tokenSessionId, timestamp, expiresMs] = payload.split(":");

  // Check session binding
  if (tokenSessionId !== sessionId) return false;

  // Check expiration
  const issuedAt = Number(timestamp);
  const expiry = Number(expiresMs);
  if (isNaN(issuedAt) || isNaN(expiry)) return false;
  if (Date.now() - issuedAt > expiry) return false;

  // Timing-safe comparison
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(hash ?? "");

  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Check if a request method requires CSRF protection.
 * Safe methods (GET, HEAD, OPTIONS, TRACE) do not require CSRF tokens.
 */
export function requiresCsrfProtection(method: string): boolean {
  const safeMethods = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);
  return !safeMethods.has(method.toUpperCase());
}

/* ------------------------------------------------------------------ */
/* Input Size Limits                                                  */
/* ------------------------------------------------------------------ */

export interface InputSizeConfig {
  /** Maximum body size in bytes. Default: 1MB */
  maxBodySize?: number;
  /** Maximum URL length in characters. Default: 2048 */
  maxUrlLength?: number;
  /** Maximum header size in bytes. Default: 16KB */
  maxHeaderSize?: number;
  /** Maximum JSON depth. Default: 32 */
  maxJsonDepth?: number;
  /** Maximum array length. Default: 10000 */
  maxArrayLength?: number;
  /** Maximum object key length. Default: 256 */
  maxKeyLength?: number;
}

const DEFAULT_INPUT_SIZE: Required<InputSizeConfig> = {
  maxBodySize: 1_048_576, // 1MB
  maxUrlLength: 2048,
  maxHeaderSize: 16_384, // 16KB
  maxJsonDepth: 32,
  maxArrayLength: 10_000,
  maxKeyLength: 256,
};

/**
 * Validate input size constraints. Returns an array of violations.
 */
export function validateInputSize(
  input: {
    bodySize?: number;
    urlLength?: number;
    headerSize?: number;
    jsonDepth?: number;
    arrayLength?: number;
    keyLength?: number;
  },
  config: InputSizeConfig = {},
): string[] {
  const cfg = { ...DEFAULT_INPUT_SIZE, ...config };
  const violations: string[] = [];

  if (input.bodySize !== undefined && input.bodySize > cfg.maxBodySize) {
    violations.push(`Body size ${input.bodySize} exceeds limit ${cfg.maxBodySize}`);
  }

  if (input.urlLength !== undefined && input.urlLength > cfg.maxUrlLength) {
    violations.push(`URL length ${input.urlLength} exceeds limit ${cfg.maxUrlLength}`);
  }

  if (input.headerSize !== undefined && input.headerSize > cfg.maxHeaderSize) {
    violations.push(`Header size ${input.headerSize} exceeds limit ${cfg.maxHeaderSize}`);
  }

  if (input.jsonDepth !== undefined && input.jsonDepth > cfg.maxJsonDepth) {
    violations.push(`JSON depth ${input.jsonDepth} exceeds limit ${cfg.maxJsonDepth}`);
  }

  if (input.arrayLength !== undefined && input.arrayLength > cfg.maxArrayLength) {
    violations.push(`Array length ${input.arrayLength} exceeds limit ${cfg.maxArrayLength}`);
  }

  if (input.keyLength !== undefined && input.keyLength > cfg.maxKeyLength) {
    violations.push(`Key length ${input.keyLength} exceeds limit ${cfg.maxKeyLength}`);
  }

  return violations;
}

/**
 * Measure the depth of a JSON value recursively.
 */
function measureJsonDepth(value: unknown, currentDepth: number = 0): number {
  if (value === null || typeof value !== "object") return currentDepth;

  if (Array.isArray(value)) {
    let maxDepth = currentDepth;
    for (const item of value) {
      const depth = measureJsonDepth(item, currentDepth + 1);
      if (depth > maxDepth) maxDepth = depth;
    }
    return maxDepth;
  }

  let maxDepth = currentDepth;
  for (const key of Object.keys(value)) {
    const depth = measureJsonDepth((value as Record<string, unknown>)[key], currentDepth + 1);
    if (depth > maxDepth) maxDepth = depth;
  }
  return maxDepth;
}

/**
 * Validate a JSON payload for depth and size constraints.
 */
export function validateJsonPayload(
  payload: unknown,
  config: InputSizeConfig = {},
): string[] {
  const cfg = { ...DEFAULT_INPUT_SIZE, ...config };
  const violations: string[] = [];

  // Check depth
  const depth = measureJsonDepth(payload);
  if (depth > cfg.maxJsonDepth) {
    violations.push(`JSON depth ${depth} exceeds limit ${cfg.maxJsonDepth}`);
  }

  // Check array lengths
  const checkArrays = (value: unknown, path: string = "") => {
    if (Array.isArray(value)) {
      if (value.length > cfg.maxArrayLength) {
        violations.push(`Array at ${path || "root"} has length ${value.length}, exceeds limit ${cfg.maxArrayLength}`);
      }
      value.forEach((item, i) => checkArrays(item, `${path}[${i}]`));
    } else if (value !== null && typeof value === "object") {
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        if (key.length > cfg.maxKeyLength) {
          violations.push(`Key "${key.slice(0, 50)}..." at ${path} exceeds length limit ${cfg.maxKeyLength}`);
        }
        checkArrays(val, `${path}.${key}`);
      }
    }
  };

  checkArrays(payload);
  return violations;
}

/* ------------------------------------------------------------------ */
/* Webhook Signature Verification                                     */
/* ------------------------------------------------------------------ */

/**
 * Sign a webhook payload with HMAC-SHA256. The signature should be
 * included in the `X-Webhook-Signature` header.
 */
export function signWebhook(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Verify a webhook signature. Uses timing-safe comparison to prevent
 * timing attacks.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  if (!signature || !secret) return false;

  const expected = signWebhook(payload, secret);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);

  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Generate a webhook secret. Should be stored securely and never
 * exposed in logs or responses.
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

/* ------------------------------------------------------------------ */
/* Rate Limiting                                                      */
/* ------------------------------------------------------------------ */

export interface RateLimitConfig {
  /** Maximum requests per window. */
  maxRequests: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

export interface RateLimitState {
  /** Count of requests in current window. */
  count: number;
  /** Start of current window. */
  windowStart: number;
}

/**
 * In-memory rate limiter. For production, use Redis-based rate limiting.
 */
class RateLimiter {
  private stores = new Map<string, RateLimitState>();

  check(key: string, config: RateLimitConfig): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    let state = this.stores.get(key);

    if (!state || now - state.windowStart > config.windowMs) {
      state = { count: 0, windowStart: now };
    }

    state.count += 1;
    this.stores.set(key, state);

    const remaining = Math.max(0, config.maxRequests - state.count);
    const resetAt = state.windowStart + config.windowMs;

    return {
      allowed: state.count <= config.maxRequests,
      remaining,
      resetAt,
    };
  }

  reset(key: string): void {
    this.stores.delete(key);
  }

  clear(): void {
    this.stores.clear();
  }
}

const globalRateLimiter = new RateLimiter();

/**
 * Check rate limit for a key. Returns whether the request is allowed.
 */
export function checkRateLimit(
  key: string,
  config: RateLimitConfig,
): { allowed: boolean; remaining: number; resetAt: number } {
  return globalRateLimiter.check(key, config);
}

/**
 * Reset rate limit for a key (for testing).
 */
export function resetRateLimit(key: string): void {
  globalRateLimiter.reset(key);
}

/**
 * Clear all rate limits (for testing).
 */
export function clearRateLimits(): void {
  globalRateLimiter.clear();
}
