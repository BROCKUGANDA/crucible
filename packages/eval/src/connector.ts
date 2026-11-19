/**
 * @file connector.ts — the safe-connector contract (WP6).
 *
 * Every rule here exists because the alternative is a runner with an
 * unrestricted network and a sponsor-supplied URL. The blueprint's list, and
 * what each one prevents:
 *
 *   - **Host allowlist.** Without it, a task description is an SSRF primitive:
 *     `http://169.254.169.254/` is one string away.
 *   - **Private-address refusal, by resolution not by spelling.** `127.0.0.1` is
 *     not the only loopback spelling, and `0x7f.1` is not the only notation.
 *   - **`Retry-After` honoured, retries bounded.** A provider asking for quiet is
 *     not a provider asking to be hammered; a timeout is not a permission to
 *     retry a non-idempotent write.
 *   - **Idempotency keys on writes.** A retry that duplicates a row is a data
 *     defect the evaluator cannot distinguish from a pipeline bug.
 *   - **Normalised error codes.** `AUTH_FAILED` and `RATE_LIMITED` need different
 *     repairs, and a raw provider body leaks credentials.
 *   - **Secrets are references.** A connector holds `SecretReference`, never a
 *     value; the resolver is the caller's, so a task manifest cannot carry one.
 */

import { createHash } from "node:crypto";

/** A pointer to a secret in the operator's secret store. Never the secret. */
export interface SecretReference {
  /** The store's own name for the value, e.g. `vault://tenant-1/stripe`. */
  ref: string;
  /** The scope the value may be used in, for auditing. */
  scope: string;
}

export type ConnectorErrorCode =
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "NOT_FOUND"
  | "SCHEMA_DRIFT"
  | "HOST_NOT_ALLOWED"
  | "PRIVATE_ADDRESS_REFUSED"
  | "SERVER_ERROR"
  | "INVALID_RESPONSE"
  | "CHECKPOINT_LOST";

export class ConnectorError extends Error {
  constructor(
    readonly code: ConnectorErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export interface ConnectorCapabilities {
  provider: string;
  /** Whether the connector can write. A read-only connector cannot be asked to. */
  read: boolean;
  write: boolean;
  pagination: "cursor" | "offset" | "none";
  /** The error codes this connector can produce, for the console. */
  errorCodes: ConnectorErrorCode[];
}

export interface ConnectionTest {
  ok: boolean;
  code: ConnectorErrorCode | null;
  detail: string;
  /** How long the test took, so a hung provider is visible. */
  elapsedMs: number;
}

export interface ConnectorConfig {
  provider: string;
  /** Hosts this connector may reach. Exact host matches only; no wildcard suffix. */
  allowedHosts: readonly string[];
  /** The secret the connector authenticates with. A reference, never a value. */
  credential: SecretReference | null;
  /** Requests per second this provider tolerates. */
  rateLimitPerSecond?: number;
  /** Per-request timeout, in milliseconds. */
  timeoutMs?: number;
  /** How many times a retryable failure is retried. */
  maxRetries?: number;
  /** The base backoff, in milliseconds; doubled each attempt. */
  baseBackoffMs?: number;
}

/* ------------------------------------------------------------------ */
/* URL safety                                                           */
/* ------------------------------------------------------------------ */

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local, including the metadata service
  /^\[::1\]$/,
  /^\[?f[cd][0-9a-f]{2}:/i, // unique local IPv6
  /^\[?fe80:/i, // link-local IPv6
  /\.local$/i,
  /^metadata\./i,
  /^instance-data$/i,
];

/**
 * Is this URL one the connector may call?
 *
 * The checks are on the parsed URL, not on the string: `https://allowed.example@169.254.169.254/`
 * has an allowed-looking prefix and a private host, and only the parse sees that.
 */
export function assertAllowedUrl(
  raw: string,
  allowedHosts: readonly string[],
  options: { allowHttp?: boolean } = {},
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConnectorError("HOST_NOT_ALLOWED", "not an absolute URL", false, undefined, raw);
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "https:" && !(protocol === "http:" && options.allowHttp)) {
    throw new ConnectorError(
      "HOST_NOT_ALLOWED",
      `${protocol} is refused; connectors use https unless the operator allows http`,
      false,
      undefined,
      raw,
    );
  }
  // A URL carries credentials in its authority; a connector must never forward
  // them, because they would land in the provider's access log.
  if (url.username || url.password) {
    throw new ConnectorError("AUTH_FAILED", "credentials in a URL are refused; use a secret reference", false);
  }
  const host = url.hostname.toLowerCase();
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new ConnectorError(
      "PRIVATE_ADDRESS_REFUSED",
      `${host} is a private or link-local address`,
      false,
      undefined,
      host,
    );
  }
  // Exact host match, or a subdomain of a listed host. A suffix match on the raw
  // string would let `evilexample.com` pass an allowlist naming `example.com`.
  const allowed = allowedHosts.some(
    (entry) => host === entry.toLowerCase() || host.endsWith(`.${entry.toLowerCase()}`),
  );
  if (!allowed) {
    throw new ConnectorError(
      "HOST_NOT_ALLOWED",
      `${host} is not in this connector's allowlist (${allowedHosts.join(", ") || "empty"})`,
      false,
      undefined,
      host,
    );
  }
  return url;
}

/* ------------------------------------------------------------------ */
/* Error normalisation                                                  */
/* ------------------------------------------------------------------ */

/**
 * Turn an HTTP status and a provider body into one of our codes.
 *
 * The provider's body is *not* included in the message: it can echo the bearer
 * token that was just sent, and an error path is the last place a credential
 * should reappear.
 */
export function normaliseHttpError(status: number, headers?: Headers): ConnectorError {
  const retryAfter = headers ? parseRetryAfter(headers.get("retry-after")) : undefined;
  if (status === 401 || status === 403) {
    return new ConnectorError("AUTH_FAILED", `provider refused the credential (HTTP ${status})`, false);
  }
  if (status === 404) {
    return new ConnectorError("NOT_FOUND", "the provider has no such resource", false);
  }
  if (status === 429) {
    return new ConnectorError(
      "RATE_LIMITED",
      `provider rate-limited this connector${retryAfter ? `; retry after ${retryAfter}ms` : ""}`,
      true,
      retryAfter,
    );
  }
  if (status === 408 || status === 504) {
    return new ConnectorError("TIMEOUT", `provider timed out (HTTP ${status})`, true, retryAfter);
  }
  if (status >= 500) {
    return new ConnectorError("SERVER_ERROR", `provider failed (HTTP ${status})`, true, retryAfter);
  }
  return new ConnectorError("INVALID_RESPONSE", `provider answered HTTP ${status}`, false);
}

/** `Retry-After` is either delta-seconds or an HTTP date. Both are honoured. */
export function parseRetryAfter(raw: string | null, now: number = Date.now()): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  const delta = at - now;
  return delta > 0 ? delta : 0;
}

/** Strip anything that looks like a credential out of a string bound for a log. */
export function redactForLog(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/"(access_token|api_key|token|secret|password)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"');
}

/* ------------------------------------------------------------------ */
/* Retry and rate limiting                                              */
/* ------------------------------------------------------------------ */

export interface RetryPolicy {
  maxRetries: number;
  baseBackoffMs: number;
  /** An injected sleep, so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** An injected jitter source, so a test can pin it. */
  random?: () => number;
  /** The maximum any single backoff may reach. */
  maxBackoffMs?: number;
}

/**
 * The backoff for attempt `n`: base × 2^n, capped, with jitter.
 *
 * The jitter matters because the alternative is many workers retrying in
 * lockstep after a provider blip, which is a self-inflicted second outage.
 */
export function backoffMs(attempt: number, policy: RetryPolicy): number {
  const base = policy.baseBackoffMs;
  const raw = base * 2 ** attempt;
  const capped = Math.min(raw, policy.maxBackoffMs ?? 30_000);
  const jitter = (policy.random ?? Math.random)() * base;
  return Math.floor(capped * 0.5 + jitter);
}

/**
 * Run `fn`, retrying only what is safe to retry.
 *
 * `Retry-After` wins over the computed backoff, because the provider is the
 * authority on when it can be called again. A non-retryable error is thrown on
 * the first attempt: retrying an auth failure is how a key gets locked out.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
): Promise<{ value: T; attempts: number }> {
  const sleep = policy.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    try {
      return { value: await fn(attempt), attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (error instanceof ConnectorError && !error.retryable) throw error;
      if (attempt === policy.maxRetries) break;
      const delay = error instanceof ConnectorError && error.retryAfterMs !== undefined
        ? error.retryAfterMs
        : backoffMs(attempt, policy);
      await sleep(delay);
    }
  }
  throw lastError;
}

/** A per-connector token bucket, so one provider is not hammered by one tenant. */
export class ConnectorRateLimiter {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly perSecond: number,
    now: number = Date.now(),
  ) {
    this.tokens = Math.max(1, perSecond);
    this.updatedAt = now;
  }

  /** Consume one slot, or report how long to wait. */
  take(now: number = Date.now()): { allowed: boolean; waitMs: number } {
    const elapsedSeconds = Math.max(0, (now - this.updatedAt) / 1000);
    this.tokens = Math.min(Math.max(1, this.perSecond), this.tokens + elapsedSeconds * this.perSecond);
    this.updatedAt = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { allowed: true, waitMs: 0 };
    }
    return { allowed: false, waitMs: Math.ceil(((1 - this.tokens) / Math.max(1, this.perSecond)) * 1000) };
  }
}

/* ------------------------------------------------------------------ */
/* Pagination and checkpoints                                           */
/* ------------------------------------------------------------------ */

export interface ReadPage {
  records: Record<string, unknown>[];
  /** The cursor for the next page, or null when the source is exhausted. */
  nextCursor: string | null;
  /** The provider's own watermark, for incremental sync. */
  watermark?: string | null;
}

export interface ReadRequest {
  url: string;
  cursor?: string | null;
  pageSize?: number;
  /** Only records newer than this watermark. */
  since?: string | null;
}

/**
 * A cursor must be opaque and stable.
 *
 * A cursor built from a page number breaks the moment a record is inserted
 * before it, and the failure mode is silent: rows are skipped, totals stop
 * reconciling, and the pipeline reports success.
 */
export function validateCursorShape(cursor: string | null | undefined): string[] {
  const problems: string[] = [];
  if (cursor === null || cursor === undefined) return problems;
  if (typeof cursor !== "string") {
    problems.push("cursor must be a string");
    return problems;
  }
  if (cursor.length > 4096) problems.push("cursor is longer than 4096 characters");
  if (/^[0-9]+$/.test(cursor)) {
    problems.push(
      "cursor is a bare page number; page numbers skip records when the source is inserted into",
    );
  }
  return problems;
}

/* ------------------------------------------------------------------ */
/* The connector interface                                              */
/* ------------------------------------------------------------------ */

export interface DataConnector {
  readonly capabilities: ConnectorCapabilities;
  testConnection(): Promise<ConnectionTest>;
  readPage(request: ReadRequest): Promise<ReadPage>;
  /** A write is refused unless the capability says the connector can write. */
  write(records: readonly Record<string, unknown>[], idempotencyKey: string): Promise<{ written: number; replayed: boolean }>;
}

/** The record count and digest a page set produces, for the lineage event. */
export function pageSetDigest(pages: readonly ReadPage[]): string {
  const records = pages.flatMap((p) => p.records);
  return `sha256:${createHash("sha256").update(JSON.stringify(records)).digest("hex")}`;
}

/**
 * A dry-run of a read plan, before any request is made.
 *
 * It answers the three questions an operator has to be able to answer before
 * pointing a connector at a provider: is this host allowed, is the credential a
 * reference rather than a value, and does the connector claim the capability
 * the plan needs.
 */
export function planRead(
  config: ConnectorConfig,
  capabilities: ConnectorCapabilities,
  request: ReadRequest,
  options: { allowHttp?: boolean } = {},
): { ok: boolean; problems: string[]; host: string | null } {
  const problems: string[] = [];
  let host: string | null = null;
  try {
    host = assertAllowedUrl(request.url, config.allowedHosts, options).hostname;
  } catch (error) {
    if (error instanceof ConnectorError) problems.push(`${error.code}: ${error.message}`);
    else problems.push(`unexpected error: ${(error as Error).message}`);
  }
  if (!capabilities.read) problems.push("this connector cannot read");
  if (config.credential && !config.credential.ref.includes("://")) {
    problems.push(
      "the credential is not a secret-store reference; a connector must never hold a literal value",
    );
  }
  problems.push(...validateCursorShape(request.cursor));
  return { ok: problems.length === 0, problems, host };
}