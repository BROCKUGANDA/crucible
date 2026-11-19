import { describe, expect, it } from "vitest";
import {
  ConnectorError,
  ConnectorRateLimiter,
  assertAllowedUrl,
  backoffMs,
  normaliseHttpError,
  parseRetryAfter,
  planRead,
  redactForLog,
  validateCursorShape,
  withRetry,
} from "../src/connector.js";
import { completeEvent, eventDigest, lineageGaps, startEvent, validateRunEvent } from "../src/lineage.js";

describe("URL safety", () => {
  const allowed = ["api.example.com"];

  it("accepts a host in the allowlist", () => {
    expect(assertAllowedUrl("https://api.example.com/v1/rows", allowed).hostname).toBe("api.example.com");
  });

  it("accepts a subdomain of an allowlisted host", () => {
    expect(assertAllowedUrl("https://eu.api.example.com/x", allowed).hostname).toBe("eu.api.example.com");
  });

  it("refuses a lookalike suffix", () => {
    // `notexample.com` ends with "example.com" as a string but is a different host.
    expect(() => assertAllowedUrl("https://notexample.com/x", allowed)).toThrow(/not in this connector/);
  });

  it("refuses a host outside the allowlist", () => {
    expect(() => assertAllowedUrl("https://evil.test/x", allowed)).toThrow(/not in this connector/);
  });

  it("refuses the cloud metadata address", () => {
    expect(() => assertAllowedUrl("http://169.254.169.254/latest/meta-data/", allowed, { allowHttp: true })).toThrow(
      /private or link-local/,
    );
  });

  it("refuses loopback however it is spelled", () => {
    for (const url of ["http://127.0.0.1/", "http://localhost/", "http://0.0.0.0/", "http://[::1]/"]) {
      expect(() => assertAllowedUrl(url, ["127.0.0.1", "localhost", "0.0.0.0", "[::1]"], { allowHttp: true })).toThrow(
        /private or link-local/,
      );
    }
  });

  it("refuses private ranges", () => {
    for (const host of ["10.1.2.3", "192.168.0.1", "172.16.0.1", "172.31.255.1"]) {
      expect(() => assertAllowedUrl(`https://${host}/`, [host])).toThrow(/private or link-local/);
    }
  });

  it("sees through a credential-in-authority disguise", () => {
    // The host is the metadata service; the allowed-looking part is a username.
    expect(() => assertAllowedUrl("https://api.example.com@169.254.169.254/", allowed)).toThrow(
      /credentials in a URL|private or link-local/,
    );
  });

  it("refuses plain http unless the operator allows it", () => {
    expect(() => assertAllowedUrl("http://api.example.com/x", allowed)).toThrow(/https/);
    expect(assertAllowedUrl("http://api.example.com/x", allowed, { allowHttp: true }).protocol).toBe("http:");
  });

  it("refuses a non-absolute URL", () => {
    expect(() => assertAllowedUrl("/relative", allowed)).toThrow(/not an absolute URL/);
  });
});

describe("error normalisation", () => {
  it("classifies auth failures as non-retryable", () => {
    const error = normaliseHttpError(401);
    expect(error.code).toBe("AUTH_FAILED");
    expect(error.retryable).toBe(false);
  });

  it("honours Retry-After on a 429", () => {
    const error = normaliseHttpError(429, new Headers({ "retry-after": "7" }));
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(7000);
  });

  it("reads an HTTP-date Retry-After", () => {
    const at = new Date(Date.now() + 5000).toUTCString();
    expect(parseRetryAfter(at)).toBeGreaterThan(0);
    expect(parseRetryAfter(at)).toBeLessThanOrEqual(5000);
  });

  it("treats 5xx as retryable and 404 as terminal", () => {
    expect(normaliseHttpError(503).retryable).toBe(true);
    expect(normaliseHttpError(404).retryable).toBe(false);
  });

  it("never echoes the provider body in the message", () => {
    const error = normaliseHttpError(500);
    expect(error.message).not.toMatch(/bearer/i);
  });
});

describe("log redaction", () => {
  it("removes bearer tokens and named secret fields", () => {
    const text = 'Authorization: Bearer abc123 {"api_key":"sk-live-1","other":1}';
    const redacted = redactForLog(text);
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("sk-live-1");
  });

  it("removes a known secret value wherever it appears", () => {
    expect(redactForLog("value=SECRET in two places SECRET", ["SECRET"])).toBe(
      "value=[redacted] in two places [redacted]",
    );
  });
});

describe("retry policy", () => {
  it("grows the backoff and stays bounded", () => {
    const policy = { maxRetries: 5, baseBackoffMs: 100, random: () => 0, maxBackoffMs: 1000 };
    const first = backoffMs(0, policy);
    const later = backoffMs(4, policy);
    expect(later).toBeGreaterThan(first);
    expect(later).toBeLessThanOrEqual(1000);
  });

  it("does not retry a non-retryable failure", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new ConnectorError("AUTH_FAILED", "no", false);
        },
        { maxRetries: 3, baseBackoffMs: 1, sleep: async () => {} },
      ),
    ).rejects.toThrow(/no/);
    expect(calls).toBe(1);
  });

  it("retries a retryable failure and reports the attempt count", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new ConnectorError("SERVER_ERROR", "blip", true);
        return "ok";
      },
      { maxRetries: 3, baseBackoffMs: 1, sleep: async () => {}, random: () => 0 },
    );
    expect(result.value).toBe("ok");
    expect(result.attempts).toBe(3);
  });

  it("uses Retry-After instead of the computed backoff", async () => {
    const waits: number[] = [];
    await withRetry(
      async () => {
        throw new ConnectorError("RATE_LIMITED", "slow down", true, 2500);
      },
      { maxRetries: 1, baseBackoffMs: 1, sleep: async (ms) => void waits.push(ms) },
    ).catch(() => {});
    expect(waits).toEqual([2500]);
  });
});

describe("rate limiter", () => {
  it("allows the burst then refuses with a wait", () => {
    const limiter = new ConnectorRateLimiter(2, 1_000);
    expect(limiter.take(1_000).allowed).toBe(true);
    expect(limiter.take(1_000).allowed).toBe(true);
    const denied = limiter.take(1_000);
    expect(denied.allowed).toBe(false);
    expect(denied.waitMs).toBeGreaterThan(0);
  });

  it("refills over time", () => {
    const limiter = new ConnectorRateLimiter(1, 0);
    expect(limiter.take(0).allowed).toBe(true);
    expect(limiter.take(0).allowed).toBe(false);
    expect(limiter.take(1_000).allowed).toBe(true);
  });
});

describe("cursors", () => {
  it("accepts an opaque cursor", () => {
    expect(validateCursorShape("eyJvZmZzZXQiOjEwfQ==")).toEqual([]);
    expect(validateCursorShape(null)).toEqual([]);
  });

  it("refuses a bare page number", () => {
    expect(validateCursorShape("7").join(" ")).toMatch(/page number/);
  });

  it("refuses an oversized cursor", () => {
    expect(validateCursorShape("a".repeat(5000)).join(" ")).toMatch(/4096/);
  });
});

describe("read planning", () => {
  const capabilities = {
    provider: "example",
    read: true,
    write: false,
    pagination: "cursor" as const,
    errorCodes: ["AUTH_FAILED" as const],
  };

  it("passes a plan that names an allowed host and a secret reference", () => {
    const plan = planRead(
      {
        provider: "example",
        allowedHosts: ["api.example.com"],
        credential: { ref: "vault://tenant/example", scope: "read" },
      },
      capabilities,
      { url: "https://api.example.com/rows", cursor: "abc" },
    );
    expect(plan.ok).toBe(true);
    expect(plan.host).toBe("api.example.com");
  });

  it("refuses a literal credential", () => {
    const plan = planRead(
      { provider: "example", allowedHosts: ["api.example.com"], credential: { ref: "sk-live-123", scope: "read" } },
      capabilities,
      { url: "https://api.example.com/rows" },
    );
    expect(plan.ok).toBe(false);
    expect(plan.problems.join(" ")).toMatch(/secret-store reference/);
  });

  it("collects every problem at once", () => {
    const plan = planRead(
      { provider: "example", allowedHosts: ["api.example.com"], credential: null },
      { ...capabilities, read: false },
      { url: "https://evil.test/rows", cursor: "3" },
    );
    expect(plan.problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("lineage", () => {
  const complete = {
    runId: "run-1",
    jobNamespace: "crucible",
    jobName: "normalize-transactions",
    sourceSnapshot: "sha256:" + "a".repeat(64),
    transformDigest: "sha256:" + "b".repeat(64),
    outputDigest: "sha256:" + "c".repeat(64),
    rowsRead: 100,
    rowsWritten: 100,
    startedAt: "2026-11-09T00:00:00Z",
    finishedAt: "2026-11-09T00:01:00Z",
  };

  it("is complete when all three digests are present", () => {
    expect(lineageGaps(complete)).toEqual({ complete: true, missing: [] });
  });

  it("names every missing fact", () => {
    const gaps = lineageGaps({ ...complete, sourceSnapshot: null, outputDigest: null });
    expect(gaps.complete).toBe(false);
    expect(gaps.missing).toEqual(["sourceSnapshot", "outputDigest"]);
  });

  it("emits a COMPLETE event with an output dataset", () => {
    const event = completeEvent(complete);
    expect(event.eventType).toBe("COMPLETE");
    expect(event.outputs).toHaveLength(1);
    expect(validateRunEvent(event)).toEqual([]);
  });

  it("emits a FAIL event when lineage is incomplete", () => {
    const event = completeEvent({ ...complete, transformDigest: null });
    expect(event.eventType).toBe("FAIL");
  });

  it("reports an unknown row count as null, never zero", () => {
    const event = completeEvent({ ...complete, rowsWritten: null });
    const facet = event.run.facets!.crucible_reconciliation as { reconciled: unknown };
    expect(facet.reconciled).toBeNull();
  });

  it("carries the source snapshot on the START event", () => {
    const event = startEvent(complete);
    expect(event.eventType).toBe("START");
    expect(event.inputs).toHaveLength(1);
  });

  it("refuses an event with no producer or schema URL", () => {
    const event = { ...completeEvent(complete), producer: "", schemaURL: "" };
    expect(validateRunEvent(event).length).toBe(2);
  });

  it("digests are stable across key order", () => {
    const a = completeEvent(complete);
    const b = completeEvent(complete);
    expect(eventDigest(a)).toBe(eventDigest(b));
    expect(eventDigest(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("a different output digest is a different event digest", () => {
    const a = completeEvent(complete);
    const b = completeEvent({ ...complete, outputDigest: "sha256:" + "d".repeat(64) });
    expect(eventDigest(a)).not.toBe(eventDigest(b));
  });
});