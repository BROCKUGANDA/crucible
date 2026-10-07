import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { replay, type EventLike } from "@crucible/indexer";
import { createApp } from "../src/app.js";

/**
 * Transport-layer controls: who may read this API in a browser, what the response says
 * about itself, how big and how long a request may be, and whether plaintext is tolerated.
 *
 * The threat model is narrow and it is worth stating before the tests, because most of
 * these routes return data that is already on a public chain. CORS is enforced by the
 * browser and by nothing else; `curl` is not a browser and is not stopped by it. So the
 * honest target here is (a) no future authenticated route inherits an accidental
 * wildcard, (b) no proxy or browser caches or sniffs a live read model, (c) a request
 * cannot pin a worker open forever, (d) a deployment behind TLS can refuse to speak
 * plaintext and can say so.
 *
 * Every test in this file is written against the shape of the fix, and every one of them
 * fails against the blanket `cors()` / headerless / unbounded server that exists today.
 */

const TRIALS = "0x44444444444444444444444444444444";
const SPONSOR = "0x1111111111111111111111111111111111111111";
const OPERATOR = "0x22222222222222222222222222222222";

function ev(eventName: string, args: Record<string, unknown>, blockNumber = 1n): EventLike {
  return { blockNumber, transactionHash: "0x" + "11".repeat(32), logIndex: 0, address: TRIALS, eventName, args };
}

const model = replay([
  ev("TrialCreated", {
    id: 1n, sponsor: SPONSOR, specCID: "0xaa", testsCID: "0xbb",
    reward: 10n ** 18n, bond: 2n * 10n ** 17n,
    deadline: 1_700_000_000n, breakWindow: 43_200n,
  }),
  ev("AgentRegistered", {
    agentId: 1n, operator: OPERATOR, runner: OPERATOR,
    metadataURI: "ipfs://m", stake: 10n ** 18n,
  }),
]);

/** Security options for a test app: rate limiting off, everything else as given. */
function appWith(security: Record<string, unknown> = {}) {
  return createApp({ getModel: () => model }, { rateLimit: false, security });
}

/** The header names this file cares about, in one place so a typo cannot pass a test. */
const ACAO = "access-control-allow-origin";
const ACAC = "access-control-allow-credentials";
const ACAM = "access-control-allow-methods";

describe("CORS: explicit origin policy", () => {
  it("does not let an unlisted origin read a response", async () => {
    const app = appWith({ allowedOrigins: ["http://127.0.0.1:3001"] });
    const res = await app.request("/snapshot", { headers: { origin: "https://evil.example" } });

    expect(res.status).toBe(200); // the read itself is not what CORS is for; see the docs
    expect(res.headers.get(ACAO)).toBeNull();
    // Without an `Access-Control-Allow-Origin` the browser refuses the script the read,
    // which is the entire mechanism. `*` (what the blanket cors() emitted) does the
    // opposite: it hands the response to any page on the internet.
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("echoes the exact allowed origin, not a wildcard", async () => {
    const app = appWith({ allowedOrigins: ["http://127.0.0.1:3001"] });
    const res = await app.request("/snapshot", { headers: { origin: "http://127.0.0.1:3001" } });
    expect(res.headers.get(ACAO)).toBe("http://127.0.0.1:3001");
    expect(res.headers.get(ACAO)).not.toBe("*");
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("refuses a preflight from an unlisted origin with a status, not silence", async () => {
    const app = appWith({ allowedOrigins: ["http://127.0.0.1:3001"] });
    const res = await app.request("/snapshot", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get(ACAO)).toBeNull();
  });

  /**
   * The part of the old default that was not decoration: Hono's `cors()` advertises
   * `GET, HEAD, PUT, POST, DELETE, PATCH, QUERY` to whichever origin asked. Today no
   * route writes, so the advertisement is harmless — and it is exactly the thing that
   * would stop being harmless the day someone adds a POST.
   */
  it("advertises only reads on a preflight it accepts", async () => {
    const app = appWith({ allowedOrigins: ["http://127.0.0.1:3001"] });
    const res = await app.request("/snapshot", {
      method: "OPTIONS",
      headers: { origin: "http://127.0.0.1:3001", "access-control-request-method": "GET" },
    });
    expect(res.status).toBe(204);
    const methods = res.headers.get(ACAM) ?? "";
    expect(methods).toContain("GET");
    for (const write of ["POST", "PUT", "DELETE", "PATCH"]) expect(methods).not.toContain(write);
  });

  it("never grants credentialed cross-origin access unless it is asked to", async () => {
    const app = appWith({ allowedOrigins: ["http://127.0.0.1:3001"] });
    const res = await app.request("/snapshot", { headers: { origin: "http://127.0.0.1:3001" } });
    expect(res.headers.get(ACAC)).toBeNull();

    const granted = appWith({ allowedOrigins: ["http://127.0.0.1:3001"], allowCredentials: true });
    const second = await granted.request("/snapshot", { headers: { origin: "http://127.0.0.1:3001" } });
    expect(second.headers.get(ACAC)).toBe("true");
  });

  /**
   * `*` is a real answer for a read-only public API, and it has to mean something
   * specific: anyone may read anonymously, nobody may read with credentials. A wildcard
   * combined with `Allow-Credentials` is the illegal pair the browser rejects, so the
   * policy refuses to emit it even when the operator asks for both.
   */
  it("treats `*` as public anonymous reads and never pairs it with credentials", async () => {
    const app = appWith({ allowedOrigins: ["*"], allowCredentials: true });
    const res = await app.request("/snapshot", { headers: { origin: "https://evil.example" } });
    expect(res.headers.get(ACAO)).toBe("*");
    expect(res.headers.get(ACAC)).toBeNull();
  });

  it("leaves a request with no Origin alone", async () => {
    // Same-origin fetches, curl, server-to-server and the health probe all arrive without
    // an Origin header. They are not CORS requests; refusing them would break the demo.
    const app = appWith({ allowedOrigins: ["http://127.0.0.1:3001"] });
    const res = await app.request("/snapshot");
    expect(res.status).toBe(200);
    expect(res.headers.get(ACAO)).toBeNull();
  });

  it("keeps the documented local demo working with no configuration at all", async () => {
    // README and docs/setup.md: web on 3000/3001, API on 8787/8788. A control that needs
    // an env var before the shipped demo works is a control that gets turned off.
    const app = createApp({ getModel: () => model }, { rateLimit: false });
    for (const origin of [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:3001",
      "http://127.0.0.1:3001",
    ]) {
      const res = await app.request("/snapshot", { headers: { origin } });
      expect(res.headers.get(ACAO)).toBe(origin);
    }
    const hostile = await app.request("/snapshot", { headers: { origin: "https://evil.example" } });
    expect(hostile.headers.get(ACAO)).toBeNull();
  });
});

describe("security response headers", () => {
  it("stops a browser sniffing a JSON body as something executable", async () => {
    const res = await appWith().request("/snapshot");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("names a referrer policy so a chain address does not leak to a third party", async () => {
    const res = await appWith().request("/trials/1");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("switches every browser feature off for an API that has no use for any of them", async () => {
    const res = await appWith().request("/agents");
    const policy = res.headers.get("permissions-policy") ?? "";
    expect(policy).toContain("camera=()");
    expect(policy).toContain("microphone=()");
    expect(policy).toContain("geolocation=()");
    expect(policy).toContain("payment=()");
  });

  /**
   * A live read model behind a shared cache is a page that shows a settled trial as still
   * open. `no-store` is the truthful instruction for a payload that is only correct at the
   * instant it was built — and `/snapshot` and `/stream` are the two routes a judge is
   * most likely to leave running behind a proxy for an evening.
   */
  it("keeps a fresh read out of every cache between here and the browser", async () => {
    for (const path of ["/snapshot", "/trials", "/hall", "/health"]) {
      const res = await appWith().request(path);
      expect(res.headers.get("cache-control"), path).toContain("no-store");
    }
  });

  it("keeps the SSE stream uncacheable without breaking the buffering it depends on", async () => {
    const ac = new AbortController();
    const res = await appWith().request("http://localhost/stream", { signal: ac.signal });
    const reader = res.body?.getReader();
    await reader?.read();

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-store");
    // `no-transform` is the one a caching proxy honours; without it nginx can hold the
    // whole stream until it fills a buffer, which looks identical to a dead index.
    expect(res.headers.get("cache-control")).toContain("no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    ac.abort();
  });

  /**
   * HSTS over plaintext is the classic self-inflicted wound: one http request to a host
   * that answers with `Strict-Transport-Security` pins that hostname in the browser and
   * the local demo never loads again. So it is emitted only when the request actually
   * arrived over TLS.
   */
  it("does not mint HSTS over plaintext", async () => {
    const res = await appWith().request("http://127.0.0.1:8787/snapshot");
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("mints HSTS when the request really did arrive over TLS", async () => {
    const res = await appWith().request("https://crucible.example/snapshot");
    expect(res.headers.get("strict-transport-security")).toMatch(/max-age=\d{6,}/);
  });

  /**
   * `X-Forwarded-Proto` is a header the caller writes. Believing it unconditionally would
   * let one plaintext request mint a HSTS pinning header for the host — the footgun again,
   * one line away. Same rule as the rate limiter's forwarded-for handling.
   */
  it("only believes a forwarded protocol when told the proxy writes it", async () => {
    const untrusted = await appWith().request("http://127.0.0.1:8787/snapshot", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(untrusted.headers.get("strict-transport-security")).toBeNull();

    const trusted = appWith({ trustProxy: true });
    const behind = await trusted.request("http://127.0.0.1:8787/snapshot", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(behind.headers.get("strict-transport-security")).toMatch(/max-age=\d{6,}/);
  });

  /**
   * The API returns JSON and SSE. It has no HTML route, so a CSP on the API would be
   * decoration — but the middleware has to be right if one is ever added, so the rule is
   * tested directly against a route that does return HTML.
   */
  it("gives a document a CSP and leaves a JSON response alone", async () => {
    const { securityHeaders } = await import("../src/security.js");
    const probe = new Hono();
    probe.use("*", securityHeaders());
    probe.get("/page", (c) => c.html("<h1>forge</h1>"));
    probe.get("/data", (c) => c.json({ ok: true }));

    const html = await probe.request("/page");
    expect(html.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(html.headers.get("x-frame-options")).toBe("DENY");

    const json = await probe.request("/data");
    expect(json.headers.get("content-security-policy")).toBeNull();
  });

  it("serves no HTML today, so no route needs a CSP", async () => {
    const app = appWith();
    for (const path of ["/health", "/snapshot", "/trials", "/trials/1", "/agents", "/agents/1", "/hall", "/errors"]) {
      const res = await app.request(path);
      expect(res.headers.get("content-type"), path).toContain("application/json");
      expect(res.headers.get("content-security-policy"), path).toBeNull();
    }
  });

  it("puts the headers on an error response too", async () => {
    // A 404 and a 429 are the responses a scanner reports on, and the ones a browser is
    // most likely to sniff. Headers are set post-handler, so they cover these as well.
    const res = await appWith().request("/nowhere");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("puts the headers on a 500, which never reaches the post-handler pass", async () => {
    // The error handler runs outside the middleware chain, so a header set only after
    // `next()` would be missing on exactly the response nobody remembered to check. A
    // throwing read model stands in for the indexer call that fails in production.
    const throwing = createApp(
      {
        getModel: () => {
          throw new Error("the read model exploded");
        },
      },
      { rateLimit: false },
    );
    const res = await throwing.request("/snapshot");
    expect(res.status).toBe(500);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("permissions-policy")).toContain("camera=()");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("lets a cross-origin client see the headers it has to obey", async () => {
    // The web app is a different origin from the API, and a browser hides every response
    // header from page script unless it is exposed. `Retry-After` on a 429 is the one that
    // decides whether a client backs off or hammers.
    const app = appWith({ allowedOrigins: ["http://127.0.0.1:3001"] });
    const res = await app.request("/snapshot", { headers: { origin: "http://127.0.0.1:3001" } });
    const exposed = res.headers.get("access-control-expose-headers") ?? "";
    expect(exposed).toContain("Retry-After");
    expect(exposed).toContain("X-Request-Id");
    expect(exposed).toContain("RateLimit-Remaining");
  });
});

describe("request body ceiling", () => {
  it("refuses a body larger than the ceiling before any handler runs", async () => {
    const app = appWith({ maxBodyBytes: 64 });
    const res = await app.request("/snapshot", {
      method: "POST",
      headers: { "content-length": "100000" },
      body: "x",
    });
    expect(res.status).toBe(413);
    expect(String((await res.json()).error)).toMatch(/too large|size/i);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  /**
   * Every route is a read. A `Content-Length` on a GET is not a thing a real client does,
   * so permitting zero and refusing anything above it costs nothing and closes the one
   * path where an unbounded body could reach a handler that might one day read it.
   */
  it("refuses a body on a read", async () => {
    // Two sizes here on purpose: over the ceiling, and small enough to pass the general
    // limit. A read has a ceiling of zero, so both are refused.
    const app = appWith({ maxBodyBytes: 64 });
    const oversized = await app.request("/snapshot", { method: "GET", headers: { "content-length": "999999" } });
    expect(oversized.status).toBe(413);

    const small = await app.request("/snapshot", { method: "GET", headers: { "content-length": "5" } });
    expect(small.status).toBe(413);
    expect(String((await small.json()).error)).toMatch(/body|size/i);
  });

  it("accepts an ordinary read, and a zero-length body on one", async () => {
    const app = appWith({ maxBodyBytes: 64 });
    expect((await app.request("/snapshot")).status).toBe(200);
    expect((await app.request("/snapshot", { headers: { "content-length": "0" } })).status).toBe(200);
  });

  it("is a ceiling rather than a ban on other methods", async () => {
    const app = appWith({ maxBodyBytes: 1024 });
    const res = await app.request("/snapshot", { method: "POST", headers: { "content-length": "8" }, body: "12345678" });
    // 404/405 from the router is the correct outcome: the limiter passed, the route does not exist.
    expect(res.status).not.toBe(413);
  });
});

describe("request timeout", () => {
  /**
   * Honest scope: the read routes here are synchronous over an in-memory Map, so today
   * nothing can hang. The timeout is for the route that awaits a node — and for the case
   * where a client is slow to send and the response is already owed. A middleware cannot
   * interrupt CPU work already running on the event loop; it can only refuse to wait.
   */
  it("stops waiting on a handler that never answers", async () => {
    const { requestTimeout } = await import("../src/security.js");
    const slow = new Hono();
    slow.use("*", requestTimeout({ timeoutMs: 20 }));
    slow.get("/stall", async (c) => {
      await new Promise((r) => setTimeout(r, 4_000));
      return c.json({ ok: true });
    });

    const started = Date.now();
    const res = await slow.request("/stall");
    expect(res.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("leaves a fast route alone", async () => {
    const res = await appWith({ timeoutMs: 5_000 }).request("/snapshot");
    expect(res.status).toBe(200);
  });

  /**
   * `/stream` is one request that stays open for minutes on purpose. A blanket timeout
   * across the whole app would look like a working security control and would quietly
   * kill the live view — the exact "silently breaks the feature" outcome the last few
   * hours were spent on. The stream bounds itself instead.
   */
  it("does not cut the live stream short", async () => {
    const ac = new AbortController();
    const app = appWith({ timeoutMs: 30 });
    const res = await app.request("http://localhost/stream", { signal: ac.signal });
    const first = await res.body?.getReader().read();
    const text = new TextDecoder().decode(first?.value ?? new Uint8Array());
    expect(text).toContain("event: snapshot");
    expect(res.status).toBe(200);
    ac.abort();
  });
});

describe("plaintext rejection, off by default", () => {
  it("serves plaintext when nothing asked it not to", async () => {
    const res = await appWith().request("http://127.0.0.1:8787/snapshot");
    expect(res.status).toBe(200);
  });

  it("refuses plaintext once it is told the deployment is behind TLS", async () => {
    const res = await appWith({ enforceHttps: true }).request("http://127.0.0.1:8787/snapshot");
    expect(res.status).toBe(403);
    expect(String((await res.json()).error)).toMatch(/https|plaintext/i);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves a TLS request under the same setting", async () => {
    const res = await appWith({ enforceHttps: true }).request("https://crucible.example/snapshot");
    expect(res.status).toBe(200);
  });

  it("believes a forwarded protocol only from a proxy it trusts", async () => {
    const spoofed = await appWith({ enforceHttps: true }).request("http://127.0.0.1:8787/snapshot", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(spoofed.status).toBe(403);

    const trusted = appWith({ enforceHttps: true, trustProxy: true });
    const real = await trusted.request("http://127.0.0.1:8787/snapshot", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(real.status).toBe(200);
  });

  it("never redirects a plaintext API call to a host it did not verify", async () => {
    // A 301 from an API is a footgun with a JSON client; a refusal is honest, and the
    // redirect belongs at the proxy that terminated TLS in the first place.
    const res = await appWith({ enforceHttps: true }).request("http://127.0.0.1:8787/health");
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("readiness, and the difference from health", () => {
  /**
   * `/health` answers "is this process up and is the index moving". `/ready` answers the
   * only question a load balancer can act on: "will a request to this instance return a
   * complete read model right now". It fails closed — a host that never reported an index
   * status is not proof that an index exists.
   */
  it("is not ready when nobody told it what the index did", async () => {
    const res = await appWith().request("/ready");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(String(body.reason)).toMatch(/no index status|not supplied|index/i);
  });

  it("is ready when the index has caught the chain head", async () => {
    const app = createApp(
      { getModel: () => model, indexStatus: () => ({ head: 42n, indexedTo: 42n, syncError: null }) },
      { rateLimit: false },
    );
    const res = await app.request("/ready");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(true);
    expect(body.lag).toBe(0);
    expect(body.indexedTo).toBe(42);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("is not ready while the index is still climbing", async () => {
    const app = createApp(
      { getModel: () => model, indexStatus: () => ({ head: 400n, indexedTo: 12n, syncError: null }) },
      { rateLimit: false },
    );
    const res = await app.request("/ready");
    expect(res.status).toBe(503);
    expect((await res.json()).lag).toBe(388);
  });

  it("is not ready when the last tick failed, even if it is caught up", async () => {
    const app = createApp(
      { getModel: () => model, indexStatus: () => ({ head: 42n, indexedTo: 42n, syncError: "rpc timeout" }) },
      { rateLimit: false },
    );
    const res = await app.request("/ready");
    expect(res.status).toBe(503);
    expect(String((await res.json()).syncError)).toContain("rpc timeout");
  });

  it("tolerates a block or two of lag without flapping, and not a thousand", async () => {
    const status = (indexedTo: bigint) =>
      createApp(
        { getModel: () => model, indexStatus: () => ({ head: 100n, indexedTo, syncError: null }) },
        { rateLimit: false },
      );
    expect((await status(97n).request("/ready")).status).toBe(200);
    expect((await status(50n).request("/ready")).status).toBe(503);
  });

  it("does not move /health, which is still liveness plus index reach", async () => {
    const app = createApp(
      { getModel: () => model, indexStatus: () => ({ head: 42n, indexedTo: 42n, syncError: null }) },
      { rateLimit: false },
    );
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.indexedTo).toBe(42);
    expect(body.head).toBe(42);
    expect(body.syncError).toBeNull();
  });
});

describe("the environment is where the policy comes from", () => {
  it("reads the allowlist from ALLOWED_ORIGINS", async () => {
    const { securityFromEnv } = await import("../src/security.js");
    const cfg = securityFromEnv({ ALLOWED_ORIGINS: "https://crucible.example, https://www.crucible.example" });
    expect(cfg.allowedOrigins).toEqual(["https://crucible.example", "https://www.crucible.example"]);
  });

  it("falls back to the demo origins when the variable is empty or absent", async () => {
    const { securityFromEnv, DEFAULT_SECURITY } = await import("../src/security.js");
    expect(securityFromEnv({}).allowedOrigins).toEqual(DEFAULT_SECURITY.allowedOrigins);
    expect(securityFromEnv({ ALLOWED_ORIGINS: "  " }).allowedOrigins).toEqual(DEFAULT_SECURITY.allowedOrigins);
  });

  it("passes the `*` sentinel through rather than splitting it into one item", async () => {
    const { securityFromEnv } = await import("../src/security.js");
    expect(securityFromEnv({ ALLOWED_ORIGINS: "*" }).allowedOrigins).toEqual(["*"]);
  });

  it("parses the numeric switches and refuses to trust a malformed one", async () => {
    const { securityFromEnv, DEFAULT_SECURITY } = await import("../src/security.js");
    const cfg = securityFromEnv({
      MAX_BODY_BYTES: "8192",
      REQUEST_TIMEOUT_MS: "2500",
      HSTS_MAX_AGE: "600",
      READY_MAX_LAG: "9",
    });
    expect(cfg.maxBodyBytes).toBe(8192);
    expect(cfg.timeoutMs).toBe(2500);
    expect(cfg.hstsMaxAge).toBe(600);
    expect(cfg.readyMaxLag).toBe(9);

    // A typo in an env var must not become `NaN` propagated into a comparison that is
    // always false, which is how "no limit at all" usually ships.
    const junk = securityFromEnv({ MAX_BODY_BYTES: "unbounded", REQUEST_TIMEOUT_MS: "-5" });
    expect(junk.maxBodyBytes).toBe(DEFAULT_SECURITY.maxBodyBytes);
    expect(junk.timeoutMs).toBe(DEFAULT_SECURITY.timeoutMs);
  });

  it("treats exactly `1` as on for the boolean switches", async () => {
    const { securityFromEnv } = await import("../src/security.js");
    expect(securityFromEnv({ ENFORCE_HTTPS: "1" }).enforceHttps).toBe(true);
    expect(securityFromEnv({ ENFORCE_HTTPS: "true" }).enforceHttps).toBe(false);
    expect(securityFromEnv({}).enforceHttps).toBe(false);
    expect(securityFromEnv({ ALLOW_CREDENTIALS: "1" }).allowCredentials).toBe(true);
  });

  it("reuses TRUST_PROXY for the forwarded protocol, same as the rate limiter", async () => {
    const { securityFromEnv } = await import("../src/security.js");
    expect(securityFromEnv({ TRUST_PROXY: "1" }).trustProxy).toBe(true);
    expect(securityFromEnv({}).trustProxy).toBe(false);
  });

  it("has defaults that are safe without any configuration", async () => {
    const { DEFAULT_SECURITY } = await import("../src/security.js");
    expect(DEFAULT_SECURITY.allowCredentials).toBe(false);
    expect(DEFAULT_SECURITY.enforceHttps).toBe(false);
    expect(DEFAULT_SECURITY.allowedOrigins).not.toContain("*");
    expect(DEFAULT_SECURITY.maxBodyBytes).toBeGreaterThan(0);
    expect(DEFAULT_SECURITY.timeoutMs).toBeGreaterThan(0);
  });

  it("applies an env-driven allowlist through createApp", async () => {
    const previous = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = "https://env.example";
    try {
      const app = createApp({ getModel: () => model }, { rateLimit: false });
      const allowed = await app.request("/snapshot", { headers: { origin: "https://env.example" } });
      expect(allowed.headers.get(ACAO)).toBe("https://env.example");
      const denied = await app.request("/snapshot", { headers: { origin: "http://127.0.0.1:3001" } });
      expect(denied.headers.get(ACAO)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.ALLOWED_ORIGINS;
      else process.env.ALLOWED_ORIGINS = previous;
    }
  });
});
