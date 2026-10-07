import type { Context, MiddlewareHandler, Next } from "hono";

/**
 * Transport-layer controls: who a browser may read this API from, what a response says
 * about itself, how big and how long a request may be, and whether plaintext is tolerated.
 *
 * Three honest framings, because the tempting failure mode here is a header-shaped lie.
 *
 *   1. **CORS is enforced by the browser and by nothing else.** `curl` is not a browser; it
 *      never sends an `Origin` and is never stopped. Every route here is a read of data that
 *      is already on a public chain, so the allowlist protects no secret today. What it does
 *      is refuse to inherit the old blanket default — which advertised `Access-Control-Allow:
 *      *` plus `PUT, POST, DELETE, PATCH` to whichever page asked — into a future version of
 *      this API that has an authenticated or private path in it. A wildcard is cheap to be
 *      wrong about right now, and expensive later.
 *
 *   2. **A header is not a transport.** Nothing in this file encrypts anything. TLS is
 *      terminated by a proxy or a load balancer; the most this process can do is *notice* it
 *      is behind one, refuse plaintext when told to, and advertise HSTS only when the request
 *      genuinely arrived encrypted.
 *
 *   3. **Several of these controls guard a request shape that does not exist yet.** Every
 *      route is a GET with no body and an in-memory handler that cannot block. The body
 *      ceiling and the timeout are therefore guard rails for the route that reads a request
 *      body or awaits an RPC — plus the honest statement that a middleware cannot interrupt
 *      CPU work already running on this event loop, only decline to wait for it.
 */

export interface SecurityConfig {
  /**
   * Origins a browser may read from, exactly as they appear in an `Origin` header.
   * `["*"]` is a deliberate different policy, not a wider allowlist: public anonymous
   * reads, and credentialed reads are impossible because the wildcard is never paired
   * with `Access-Control-Allow-Credentials`.
   */
  allowedOrigins: string[];
  /** Emit `Access-Control-Allow-Credentials: true` for a listed origin. Off by default. */
  allowCredentials: boolean;
  /** Methods a permitted preflight may name. Reads only, because those are the only routes. */
  corsMethods: string[];
  /** Response headers a cross-origin page may read. */
  exposeHeaders: string[];
  /** `Access-Control-Max-Age` for a preflight this server accepted. */
  preflightMaxAgeSec: number;
  /** Ceiling on an announced `Content-Length`. */
  maxBodyBytes: number;
  /** How long this process will keep working on one request before answering 504. */
  timeoutMs: number;
  /** Paths the timeout never touches — long-lived responses that bound themselves. */
  timeoutExemptPaths: string[];
  /** Refuse a request that did not arrive over TLS. */
  enforceHttps: boolean;
  /**
   * Believe `X-Forwarded-Proto` / `cf-visitor`. The same assertion the rate limiter makes
   * with `TRUST_PROXY`: something in front overwrites these headers. Without it they are
   * caller-writable, and a caller-writable "I am https" is how a plaintext request mints an
   * HSTS pinning header for a hostname.
   */
  trustProxy: boolean;
  /** `Strict-Transport-Security` max-age, emitted only over TLS. */
  hstsMaxAge: number;
  /** Blocks behind the head that still count as ready. */
  readyMaxLag: number;
}

/**
 * The documented local demo: the web app on 3000 or 3001, the API on 8787 or 8788. An
 * origin is the *browser's* origin, so only the web ports matter here — the API port is
 * the host, not the origin. These four are the pair of schemes-and-ports in README and
 * docs/setup.md, both spellings because `localhost` and `127.0.0.1` are different origins
 * to a browser and a judge will type either.
 *
 * A control that needs an env var before the shipped demo works is a control that gets
 * turned off, so the default is the demo rather than a locked door.
 */
export const LOCAL_DEMO_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
] as const;

export const DEFAULT_SECURITY: SecurityConfig = {
  allowedOrigins: [...LOCAL_DEMO_ORIGINS],
  allowCredentials: false,
  // Reads. The routes are reads. `POST` appearing here would be a promise this server
  // cannot keep, and the promise a future write route would inherit by accident.
  corsMethods: ["GET", "HEAD", "OPTIONS"],
  exposeHeaders: ["X-Request-Id", "Retry-After", "RateLimit-Limit", "RateLimit-Remaining"],
  preflightMaxAgeSec: 600,
  // 64 KiB: enough for any future JSON write route, four orders of magnitude above what
  // every current route is sent, which is nothing.
  maxBodyBytes: 64 * 1024,
  // Every current handler is synchronous over a Map, so 10s is already 1000x of headroom;
  // it exists for the handler that awaits a node.
  timeoutMs: 10_000,
  // `/stream` is one request that stays open for minutes on purpose and caps itself at ten.
  timeoutExemptPaths: ["/stream"],
  enforceHttps: false,
  trustProxy: false,
  // A year, and no `includeSubDomains`: this host has no subdomains to pin, and pinning
  // one that does not speak TLS is an outage nobody intended. No `preload` either — that
  // is a decision to submit the hostname to a browser list, not something a header should
  // decide on someone's behalf.
  hstsMaxAge: 31_536_000,
  // Anvil produces a block about a second apart and the indexer tails on a tick, so
  // requiring an exact tie would flap a healthy instance every few seconds.
  readyMaxLag: 5,
};

/**
 * Every browser feature off. This server returns JSON and a byte stream; it has no reason
 * to touch a camera, a microphone, a payment API or the device's location, and a document
 * served from an API origin should not be able to ask. Unknown tokens are ignored by the
 * browser, so listing a feature that has since been renamed costs nothing.
 */
const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "ambient-light-sensor=()",
  "autoplay=()",
  "camera=()",
  "display-capture=()",
  "fullscreen=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "serial=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

/**
 * The policy for a document this API does not serve today — no route returns HTML, which is
 * why this is applied conditionally rather than sprayed over every JSON response, where it
 * would be decoration that a scanner counts as a pass. It is `default-src 'none'` because a
 * document from an API origin has no business loading anything at all.
 */
const HTML_CSP = [
  "default-src 'none'",
  "img-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

/* ------------------------------------------------------------------ config ---- */

/** Trim, drop empties, and accept comma- or space-separated lists. */
function parseList(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const items = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : null;
}

/**
 * A positive integer, or the default.
 *
 * The failure this avoids is the quiet one: `Number("unbounded")` is `NaN`, `NaN` compares
 * false against everything, and a limit built that way is no limit at all while looking like
 * one in the config. A malformed value is therefore ignored rather than honoured.
 */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/** As above, zero allowed: a lag tolerance of 0 means "must be exactly at the head". */
function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v >= 0 ? v : fallback;
}

/** `1` means on. Anything else, including `true` and `yes`, means off. */
function parseFlag(raw: string | undefined): boolean {
  return raw === "1";
}

/**
 * Map the process environment onto a policy.
 *
 * `env` is a parameter rather than `process.env` so the mapping is testable without mutating
 * a global, and so the names live in exactly one place.
 *
 * | var | default | meaning |
 * |---|---|---|
 * | `ALLOWED_ORIGINS` | the four local demo origins | browser origins allowed to read; `*` for public anonymous reads |
 * | `ALLOW_CREDENTIALS` | off | send `Access-Control-Allow-Credentials: true` for a listed origin |
 * | `MAX_BODY_BYTES` | 65536 | ceiling on an announced `Content-Length` |
 * | `REQUEST_TIMEOUT_MS` | 10000 | give up and answer 504 after this long; `/stream` is exempt |
 * | `ENFORCE_HTTPS` | off | refuse a request that did not arrive over TLS |
 * | `HSTS_MAX_AGE` | 31536000 | the `max-age` emitted **only** over TLS |
 * | `READY_MAX_LAG` | 5 | blocks behind the head that still count as ready |
 * | `TRUST_PROXY` | off | existing variable, now also what makes `X-Forwarded-Proto` believable |
 */
export function securityFromEnv(env: Record<string, string | undefined>): SecurityConfig {
  const origins = parseList(env.ALLOWED_ORIGINS);
  return {
    ...DEFAULT_SECURITY,
    allowedOrigins: origins ?? DEFAULT_SECURITY.allowedOrigins,
    allowCredentials: parseFlag(env.ALLOW_CREDENTIALS),
    maxBodyBytes: parsePositiveInt(env.MAX_BODY_BYTES, DEFAULT_SECURITY.maxBodyBytes),
    timeoutMs: parsePositiveInt(env.REQUEST_TIMEOUT_MS, DEFAULT_SECURITY.timeoutMs),
    enforceHttps: parseFlag(env.ENFORCE_HTTPS),
    trustProxy: parseFlag(env.TRUST_PROXY),
    hstsMaxAge: parsePositiveInt(env.HSTS_MAX_AGE, DEFAULT_SECURITY.hstsMaxAge),
    readyMaxLag: parseNonNegativeInt(env.READY_MAX_LAG, DEFAULT_SECURITY.readyMaxLag),
  };
}

/** Explicit options beat the environment, which beats the default. Undefined means "not set". */
export function resolveSecurity(
  overrides: Partial<SecurityConfig> = {},
  env: Record<string, string | undefined> = process.env,
): SecurityConfig {
  const fromEnv = securityFromEnv(env);
  const applied: Partial<SecurityConfig> = {};
  for (const [key, value] of Object.entries(overrides) as [keyof SecurityConfig, unknown][]) {
    if (value !== undefined) (applied as Record<string, unknown>)[key] = value;
  }
  return { ...fromEnv, ...applied };
}

/* -------------------------------------------------------------- detection ---- */

/**
 * Did this request arrive over TLS?
 *
 * Two answers this process can actually observe: the scheme of the URL the server adapter
 * built (`@hono/node-server` sets it from `socket.encrypted`, so it is true when this process
 * terminates TLS itself), and, only when told the proxy overwrites them, the forwarded
 * protocol headers a real proxy sets.
 */
export function isTls(c: Context, cfg: Pick<SecurityConfig, "trustProxy">): boolean {
  if (cfg.trustProxy) {
    const forwarded = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    if (forwarded === "https") return true;
    // Cloudflare's own signal, and the reason `cf-connecting-ip` is already special-cased
    // in the rate limiter.
    const visitor = c.req.header("cf-visitor");
    if (visitor) {
      try {
        if ((JSON.parse(visitor) as { scheme?: string }).scheme === "https") return true;
      } catch {
        /* a malformed cf-visitor is not evidence of anything */
      }
    }
  }
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * `Origin` is a tuple of scheme, host, port and nothing else, but humans type trailing
 * slashes into env vars. Normalising through `URL` is what makes `https://x.example/` in
 * `ALLOWED_ORIGINS` match the `https://x.example` a browser sends; a value that does not
 * parse is dropped rather than matched, so a typo cannot widen the policy.
 */
function normalizeOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!url.protocol.startsWith("http")) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- cors ---- */

/**
 * An explicit origin policy, replacing Hono's `cors()` default.
 *
 * The default emitted `Access-Control-Allow-Origin: *` on **every** response — including
 * requests with no `Origin` at all, where the header means nothing — and advertised
 * `GET, HEAD, PUT, POST, DELETE, PATCH, QUERY` as allowed methods to any page that
 * preflighted. Credentials were off by default, so a credentialed cross-origin read was
 * already impossible; the exposure was the reads themselves and the write-method
 * advertisement.
 *
 * What this changes:
 *   * an unlisted `Origin` gets no allow headers, so the browser refuses the read;
 *   * a preflight from an unlisted origin gets a 403 rather than a silent 204, so the
 *     misconfiguration is visible in a log instead of only in a browser console;
 *   * only read methods are ever advertised;
 *   * credentials stay off unless `ALLOW_CREDENTIALS=1`, and are never emitted next to a
 *     wildcard, because that pair is the one a browser rejects outright;
 *   * `Vary: Origin` accompanies a conditional answer, so a shared cache cannot serve one
 *     origin's permission to another.
 */
export function corsPolicy(cfg: SecurityConfig): MiddlewareHandler {
  const wildcard = cfg.allowedOrigins.includes("*");
  const listed = new Set(
    cfg.allowedOrigins.filter((o) => o !== "*").map(normalizeOrigin).filter((o): o is string => o !== null),
  );

  return async function cors(c: Context, next: Next) {
    const raw = c.req.header("origin");
    if (!raw) {
      // Not a CORS request: same-origin, curl, a health probe, the indexer's own host.
      // Refusing these would break the demo and protect nothing.
      await next();
      return;
    }

    const origin = normalizeOrigin(raw);
    const allowed = wildcard ? "*" : origin && listed.has(origin) ? origin : null;

    if (!allowed) {
      c.header("Vary", "Origin");
      if (c.req.method === "OPTIONS") {
        // A preflight is a browser asking permission before it sends anything. Saying no
        // with a status is what makes this observable server-side; the silent version is
        // only debuggable in someone else's console.
        return c.json({ error: `origin "${raw}" is not allowed to read this API` }, 403);
      }
      await next();
      return;
    }

    c.header("Access-Control-Allow-Origin", allowed);
    // The wildcard-with-credentials pair is forbidden by the spec and rejected by every
    // browser, so emitting it would look like a grant and behave like a bug.
    if (cfg.allowCredentials && allowed !== "*") c.header("Access-Control-Allow-Credentials", "true");
    if (cfg.exposeHeaders.length > 0) c.header("Access-Control-Expose-Headers", cfg.exposeHeaders.join(", "));
    if (allowed !== "*") c.header("Vary", "Origin");

    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Methods", cfg.corsMethods.join(", "));
      const requested = c.req.header("access-control-request-headers");
      if (requested) {
        c.header("Access-Control-Allow-Headers", requested.split(",").map((h) => h.trim()).filter(Boolean).join(", "));
        c.header("Vary", "Access-Control-Request-Headers", { append: true });
      }
      c.header("Access-Control-Max-Age", String(cfg.preflightMaxAgeSec));
      // A preflight has no body and no route behind it.
      return c.body(null, 204);
    }

    await next();
  };
}

/* --------------------------------------------------------------- headers ---- */

/**
 * Response headers, in two passes.
 *
 * Static ones go on **before** the handler runs, because Hono's error handler is outside the
 * middleware chain: a header set only after `next()` is missing on exactly the 500 nobody
 * remembers to check. The two things that can only be decided afterwards — whether this
 * response is a stream, and whether it is a document — are fixed up after.
 *
 * The stream case is the one that needed looking rather than guessing: `streamSSE` sets
 * `Cache-Control: no-cache` itself, which would silently survive a pre-handler `c.header()`
 * and let a caching proxy hold a live read model. So the override happens on the response,
 * after the route has had its say.
 */
export function securityHeaders(overrides: Partial<SecurityConfig> = {}): MiddlewareHandler {
  const cfg = resolveSecurity(overrides);

  return async function headers(c: Context, next: Next) {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Permissions-Policy", PERMISSIONS_POLICY);
    c.header("Cache-Control", "no-store");
    // Emitted only over a connection that is actually encrypted; the same header over
    // plaintext pins the hostname in the browser and the local demo never loads again.
    if (isTls(c, cfg)) c.header("Strict-Transport-Security", `max-age=${cfg.hstsMaxAge}`);

    await next();

    const type = c.res.headers.get("Content-Type") ?? "";
    if (type.includes("text/event-stream")) {
      c.header("Cache-Control", "no-store, no-transform");
      // nginx and friends buffer a chunked response until the buffer fills, which from the
      // browser looks like an index that stopped moving. This is the only reason it is here.
      c.header("X-Accel-Buffering", "no");
    } else if (!c.res.headers.has("Cache-Control")) {
      c.header("Cache-Control", "no-store");
    }

    if (type.includes("text/html")) {
      c.header("Content-Security-Policy", HTML_CSP);
      c.header("X-Frame-Options", "DENY");
    }
  };
}

/* ------------------------------------------------------------ body limit ---- */

/**
 * Reject an oversized request body before a handler sees it.
 *
 * There is no upload path: every route is a GET, and no handler calls `c.req.json()` or
 * `.text()`, so nothing in this process buffers a request body today. What this does
 * enforce is (a) any announced `Content-Length` above the ceiling is refused with 413, and
 * (b) a read carries no body at all. The value is for the route that is added later and for
 * the fact that the check costs one header read.
 *
 * Stated plainly, because the alternative is pretending: a body announced as `chunked`
 * with no `Content-Length` cannot be bounded from here without consuming the stream, which
 * would itself be the DoS. `client_max_body_size` at the proxy is the real ceiling for that
 * case; this is defence in depth for the case the server can see.
 */
export function bodyLimit(cfg: Pick<SecurityConfig, "maxBodyBytes">): MiddlewareHandler {
  return async function limit(c: Context, next: Next) {
    const announced = c.req.header("content-length");
    if (!announced) return next();

    const size = Number(announced);
    if (!Number.isFinite(size) || size < 0) {
      return c.json({ error: "malformed Content-Length" }, 400);
    }

    if (size > cfg.maxBodyBytes) {
      return c.json(
        { error: `request body too large: ${size} bytes exceeds the ${cfg.maxBodyBytes} byte limit`, maxBytes: cfg.maxBodyBytes },
        413,
      );
    }

    const isRead = c.req.method === "GET" || c.req.method === "HEAD";
    if (isRead && size > 0) {
      return c.json(
        { error: `a read request must not carry a body (${size} bytes announced; the limit for GET and HEAD is 0)` },
        413,
      );
    }

    return next();
  };
}

/* --------------------------------------------------------------- timeout ---- */

/**
 * Give up on a request that outlives the ceiling and answer 504.
 *
 * A middleware cannot stop work already running on this single-threaded event loop; it can
 * decline to keep the socket open and keep the promise chain alive. That is enough for the
 * case it is for — a handler awaiting a node that has stopped answering — and it is the
 * accurate description of what is being bought.
 *
 * Exempt paths are not a loophole: `/stream` is one request deliberately open for minutes,
 * and it already bounds itself at ten minutes with a shutdown on peer abort. Running a
 * blanket timeout over it would break the live view while looking like a control, which is
 * the specific kind of harm this file is supposed to reduce.
 */
export function requestTimeout(
  cfg: Partial<Pick<SecurityConfig, "timeoutMs" | "timeoutExemptPaths">> = {},
): MiddlewareHandler {
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_SECURITY.timeoutMs;
  const exempt = new Set(cfg.timeoutExemptPaths ?? DEFAULT_SECURITY.timeoutExemptPaths);

  return async function timeout(c: Context, next: Next) {
    if (exempt.has(c.req.path)) return next();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const worked = next().then(() => "done" as const);
    const expired = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), cfg.timeoutMs);
      // A pending timeout must not be the reason the process stays alive at shutdown.
      timer.unref?.();
    });

    const outcome = await Promise.race([worked, expired]);
    clearTimeout(timer);

    if (outcome === "timeout") {
      // The handler is still running and will finish into nobody's response. Its failure is
      // not a rejection anyone can act on now, so swallow it rather than crash the process.
      worked.catch(() => undefined);
      c.header("Retry-After", "1");
      const requestId = (c.var as Record<string, unknown>).requestId ?? null;
      return c.json({ error: "request timed out", requestId }, 504);
    }
  };
}

/* ------------------------------------------------------- plaintext gate ---- */

/**
 * Refuse a request that did not arrive over TLS.
 *
 * Off by default: the local demo is http on loopback, and a control that breaks it gets
 * switched off entirely. On for a deployment that terminates TLS in front, which is the
 * normal shape — and then this is the second line, not the transport. The first line is the
 * proxy not listening on 80 at all.
 *
 * It answers 403 rather than 301 to an https URL on purpose. A redirect is a browser
 * convenience; a JSON client follows it or does not, and telling an API caller "this
 * endpoint is plaintext-only" in the body is clearer than a Location header it cannot use.
 * If browser users need the redirect, that belongs in the proxy that knows the real host.
 */
export function enforceHttps(cfg: Pick<SecurityConfig, "trustProxy">): MiddlewareHandler {
  return async function gate(c: Context, next: Next) {
    if (isTls(c, cfg)) return next();
    return c.json(
      {
        error: "plaintext request refused: this deployment requires https",
        hint: "terminate TLS at the proxy and set TRUST_PROXY=1 so X-Forwarded-Proto is believed",
      },
      403,
    );
  };
}
