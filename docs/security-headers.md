# Transport layer: what is protected, and what is decoration

This is the honest record of the in-transit controls on `apps/api` and `apps/web`. It is
written as a threat model rather than a feature list because several of these controls
protect less than a header name suggests, and a reader who is told otherwise will trust the
wrong thing.

Nothing in this document encrypts anything. **TLS termination is not this application's
job** — it belongs to the proxy or load balancer in front of it. What the API can do is
notice that it is behind one, refuse plaintext when told to, and advertise the policy. That
is defence in depth, not the transport.

## What is actually exposed

`apps/api` is a read-only projection of on-chain events. Every route returns data that is
already public on the chain: trials, agents, verdicts, transaction hashes. There is no
authentication, no session, no cookie, no key and no private path. `apps/web` signs
transactions in the browser with wagmi/RainbowKit; the API never submits anything.

That fact is what makes the following controls unequal in value.

## Controls, and whether they earn their place

| Control | Genuinely protective here? | Why |
|---|---|---|
| CORS allowlist | **Limited today, load-bearing later** | CORS is enforced by browsers only. `curl` ignores it, and every read here is public data, so nothing is hidden from a scripted client. What the old default did was advertise `Access-Control-Allow-Origin: *` **plus `PUT, POST, DELETE, PATCH`** to any page that asked — a standing permission slip for a write route that does not exist yet, and for credentialed reads the day someone adds auth. |
| `X-Content-Type-Options: nosniff` | **Yes, cheap** | Stops a browser guessing that a JSON body containing `<script>` is HTML. Relevant because the API reflects untrusted on-chain strings (`metadataURI`, `tokenURI`, CID text) into JSON. |
| `Cache-Control: no-store` (+ `no-transform` on the stream) | **Yes, the most real one here** | The read model is only correct at the instant it was built. A shared proxy caching `/snapshot` serves a settled trial as still open, and on stage that looks like a bug in the contract. On `/stream`, `no-transform` and `X-Accel-Buffering: no` keep nginx from buffering the SSE socket into what looks like a dead indexer. |
| `Referrer-Policy: no-referrer` | Marginal | An API does not navigate, so it emits few referrers. Costs nothing. |
| `Permissions-Policy` | Marginal | This origin has no reason to touch a camera or a payment API. Noise-proofing for the case where a document is ever served from it. |
| `Strict-Transport-Security`, TLS-only | **Yes, but only over TLS** | See below — emitting HSTS over plaintext is an outage, not a protection. |
| Body ceiling | **No, not yet** | There is no upload path. No route reads a request body; every route is a GET. It is a ceiling for the future write route and for `Content-Length` abuse, at the cost of one header read. It cannot bound a `chunked` body without consuming the stream — `client_max_body_size` at the proxy does that. |
| Request timeout | **Mostly no, not yet** | Handlers are synchronous over an in-memory `Map`, so nothing can currently hang. It is for the handler that awaits an RPC. A middleware cannot interrupt CPU work already running on this event loop; it can decline to keep waiting. |
| `/ready` | Yes, operationally | A balancer can act on it. See the difference from `/health` below. |
| Frontend CSP | **Partly — see the caveats** | `style-src 'unsafe-inline'` and `script-src 'unsafe-inline'` are forced. What remains is origin confinement, framing, `<base>` and `connect-src`. |

## Environment variables

Only the first three existed before. New ones, all optional, all resolved in
`apps/api/src/security.ts::securityFromEnv`:

| var | default | effect |
|---|---|---|
| `ALLOWED_ORIGINS` | `http://localhost:3000 http://127.0.0.1:3000 http://localhost:3001 http://127.0.0.1:3001` | Browser origins allowed to read. Comma- or space-separated. `*` selects the public-anonymous policy instead of a wider list. |
| `ALLOW_CREDENTIALS` | off (`1` to enable) | Emit `Access-Control-Allow-Credentials: true` for a listed origin. Never emitted next to `*`. |
| `MAX_BODY_BYTES` | `65536` | Ceiling on an announced `Content-Length`. |
| `REQUEST_TIMEOUT_MS` | `10000` | Answer 504 after this long. `/stream` is exempt. |
| `ENFORCE_HTTPS` | off (`1` to enable) | 403 any request that did not arrive over TLS. |
| `HSTS_MAX_AGE` | `31536000` | The `max-age` sent **only** when the request was TLS. No `includeSubDomains`, no `preload` — both are decisions about hosts this process cannot see. |
| `READY_MAX_LAG` | `5` | Blocks behind the head that still count as ready. `0` means exactly at the head. |
| `TRUST_PROXY` | off (`1` to enable) | Existing variable. Now does double duty: forwarded headers name the client **and** the forwarded protocol is believed. One assertion, because believing `X-Forwarded-Proto` while denying `X-Forwarded-For` — or the reverse — is incoherent, and the first one is how a plaintext request mints an HSTS pin. |

A malformed numeric value is **ignored**, not honoured: `MAX_BODY_BYTES=unbounded` parses to
`NaN`, `NaN` compares false against everything, and a limit built that way is no limit at
all while still looking like one in the config.

### `ALLOWED_ORIGINS=*` — what it means, and why it is not a wider allowlist

For a read-only API, "any site may read this in a visitor's browser" is a defensible
position rather than a hole: the data is on a public chain. If that is the intent, `*` is
the honest way to say it. But `*` is a **different policy**, not a bigger list:

* reads are public and anonymous;
* `Access-Control-Allow-Credentials` is never sent, because the wildcard-plus-credentials
  pair is illegal in the spec and rejected by every browser — emitting it would look like a
  grant and behave like a bug;
* a credentialed or private path is impossible under `*`, which is the point.

The default is the explicit local list, not `*`, because an explicit list is what stops a
future authenticated route from inheriting the wildcard by accident. **Setting
`ALLOWED_ORIGINS` replaces the defaults rather than adding to them** — a deployment that
sets it must include the web app's own origin or the browser stops reading the API.

## Middleware order

`apps/api/src/app.ts`:

```
request id -> security headers -> CORS -> plaintext gate -> rate limit -> body ceiling -> timeout -> routes
```

* The id is outermost so a refusal that never reached a route is still nameable in a report.
* Headers are set **before** the handler runs as well as after it. Hono's error handler lives
  outside the middleware chain, so a header applied only after `next()` is missing on exactly
  the 500 nobody remembered to check.
* Rate limiting precedes the body check: a client already over budget should not cost a second
  middleware.
* `/stream` is exempt from the timeout and is the only path exempt. It is one request
  deliberately open for minutes, capped at ten by the route itself, and it stops on peer
  abort. A blanket timeout across the app looks like a working control and quietly kills the
  live view.
* `Cache-Control` for the stream is applied **after** the handler, because `streamSSE` sets
  `Cache-Control: no-cache` itself; a pre-handler value would have been silently overwritten
  and a caching proxy would then hold a live read model.

## TLS detection

`isTls()` answers from what the process can observe:

1. the scheme of the request URL — `@hono/node-server` derives it from `socket.encrypted`, so
   it is true when this process terminates TLS itself;
2. with `TRUST_PROXY=1`, `X-Forwarded-Proto` (first hop) or Cloudflare's `cf-visitor`.

Without `TRUST_PROXY`, neither forwarded header is believed. HSTS is emitted only when one of
these says TLS, and never otherwise. With `ENFORCE_HTTPS=1` the same test decides the 403.

The plaintext refusal is a 403 with an explanation, not a 301 to `https://…`. A JSON client
follows a redirect or does not; telling it "this endpoint requires TLS" in the body is clearer
than a `Location` it cannot use. If browser users need the redirect, put it in the proxy that
actually knows the public host name.

## `/health` versus `/ready`

* `/health` — liveness plus index reach: `ok`, `trials`, `indexedTo`, `head`, `syncError`.
  `503` when the last sync tick failed. It is the sentence an operator reads. Unchanged by this
  work.
* `/ready` — readiness, and it fails closed. `200` only when the host supplied an index
  status, the last tick did not fail, and the cursor is no more than `READY_MAX_LAG` blocks
  behind the head. `503` with a `reason` otherwise.

The difference has teeth: an instance whose first `sync()` has not landed is alive, answers
`/health` 200 with `indexedTo: 0`, and would render an empty Hall of Alloy to the first
visitor. `/health` cannot gate traffic on that without breaking its liveness meaning — a
restart loop is worse than a slow page — so `/ready` carries the gate instead.

Both are `no-store`: a cached "ready" is a lie about a moving system.

## Frontend CSP: measured, not assumed

Verified by loading the running app in Chromium with policies injected into the document
response (`verify2.mjs`), and then with a real production build served on its own port.

The constraints are hard:

* **`style-src 'unsafe-inline'` is unavoidable.** `/hall` produced 11 `style-src-attr`
  violations without it. The components carry 213 inline `style={{}}` props across 13 files,
  and an inline style attribute can only be allowed with `unsafe-inline` — a hash or nonce
  does not apply to attributes. Removing it means moving styling into `globals.css` or a
  CSS-in-JS layer, which is a component change.
* **`script-src 'unsafe-inline'` is unavoidable.** Next's App Router emits the flight payload
  as inline `<script>self.__next_f.push(...)</script>` (15 blocked violations on `/hall`), and
  Next 15 has no built-in nonce for them.
* **In `next dev`, `'unsafe-eval'` is also required** — React Refresh evaluates the patch.
  Without it the page hydrates to zero rows. So the CSP is applied **only to production
  builds**: a policy that breaks hot reload gets switched off inside the hour, and a header
  that is switched off protects nothing.
* `connect-src` must name the API origin, the RPC, and WalletConnect's relay/bridge/pulse
  hosts. The live feed is an `EventSource` to the API from a different origin; a `connect-src`
  that blocks it does not throw — it silently degrades to polling.

With two `unsafe-inline` allowances this policy does **not** stop an injected inline script.
What it does buy: scripts cannot come from a host that is not this origin, `object-src` is
gone, the app cannot be framed by someone else (`frame-ancestors 'self'`), `<base>` cannot be
hijacked, forms cannot repoint, and exfiltration needs a host already on the `connect-src`
list. Tightening further requires restructuring the inline styles, then dropping
`unsafe-inline` from `style-src` first (the safer half) and from `script-src` only with nonce
support.

The production build was then run for real — `next build` into a scratch dist directory,
`next start -p 3000`, Chromium against it, with the API on its default allowlist:

```
content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline'; ... connect-src 'self' http://127.0.0.1:8788 ...
x-content-type-options: nosniff | referrer-policy: no-referrer | permissions-policy: present
strict-transport-security: absent (correct — this was http)

/hall      http=200  .hall-row=2  .proof=4  nodes with a style attribute=43
           securitypolicyviolation=0  console errors=0  "Signal lost" banner=absent
/          http=200  violations=0, the live ticker painted the trials
api calls  GET 127.0.0.1:8788/stream   <- the EventSource got through connect-src *and* CORS
```

Zero violations with 43 live inline-style nodes is the point: the policy as shipped is the
one the app can actually run under, not one that looks stricter and silently empties the
page. `connect-src` listing the API origin is load-bearing for the same reason — a policy
that blocks it does not throw, it degrades the live view to polling without saying so.

`Strict-Transport-Security` is deliberately **not** set from `next.config.mjs`: `headers()` is
static and cannot know whether the request arrived over TLS, so it would also be sent over
plaintext — the exact way a demo hostname gets pinned in a browser and stops loading. Set it
at the TLS terminator.

## How this was verified, and the two traps in doing it

* API: `apps/api/test/security.test.ts`, 47 tests, each written against the shape of the fix
  and run red first against the blanket `cors()` / headerless server — 34 failed, with
  messages like `expected '*' to be null` and
  `expected 'GET,HEAD,PUT,POST,DELETE,PATCH,QUERY' not to contain 'POST'`.
* Real socket: the API on `:8795` against Anvil on `:8546`, driven with `curl.exe` — the
  deny path (`Origin: https://evil.example` → no `Access-Control-Allow-Origin`), the demo
  path (`http://127.0.0.1:3001` → echoed exactly), the preflight pair (403 vs 204 `GET, HEAD,
  OPTIONS`), the 413s, the stream's `no-transform` + `X-Accel-Buffering: no`, and `/ready`.
* Browser: Playwright (a cached install, outside the repo) loading `/hall` and `/`, counting
  rows and `securitypolicyviolation` events rather than trusting a header dump.

Two traps worth recording, because both produce a confident wrong answer:

1. **`next dev` restarts when `next.config.mjs` changes**, and the first hit on a route then
   recompiles. A check that waits a few seconds sees the pre-hydration shell — 374 characters
   and zero rows — and reports the new headers as if they had broken the UI. It had not; the
   same route renders 2 rows seconds later.
2. **Header injection is not the same as a real build, and only a control experiment tells
   them apart.** Testing a CSP by adding the response header to a dev server's document proves
   what the policy does to *that* markup, which needs `'unsafe-eval'` for React Refresh even
   though production does not. The hostile policies in `verify2.mjs` (no `unsafe-inline` at
   all) exist to prove the injection mechanism bites: 27 violations, 0 rows. Without that
   control, "0 violations" on the candidate is indistinguishable from a test that did nothing.

Scripts live in `C:/Users/HP/crucible-scratch/security/` (`verify.mjs`, `verify2.mjs`,
`verify-prod.mjs`, `baseline.mjs`, `diagnose.mjs`) with their logs. They are outside the repo
on purpose: they depend on a Playwright install that is not a project dependency.


## Deploying behind a proxy

```nginx
# TLS terminates here; the API is http on loopback.
add_header Strict-Transport-Security "max-age=31536000" always;   # only on the :443 server

location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_set_header X-Forwarded-Proto $scheme;      # required with ENFORCE_HTTPS=1 + TRUST_PROXY=1
  proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
  client_max_body_size 64k;                        # the real body ceiling; chunked bodies
}                                                  # cannot be bounded from inside the app

location /stream {                                 # SSE: unbuffered, or the index looks dead
  proxy_buffering off;
  proxy_read_timeout 900s;                         # must exceed the route's own 10-minute cap
}
```

```bash
ALLOWED_ORIGINS="https://crucible.example" \
ENFORCE_HTTPS=1 TRUST_PROXY=1 \
npm run start --workspace @crucible/api
```

The server prints the policy it resolved at boot, so the running process states what it is
actually doing rather than what the environment file appears to say:

```
[crucible] cors: https://crucible.example
[crucible] transport: https required, HSTS max-age=31536000s over TLS
[crucible] limits: body <= 65536B announced, request <= 10000ms (/stream exempt)
```

## Not done, and not pretend-done

* **No HSTS from the API over a real TLS socket was observed.** The TLS branch is exercised by
  requesting an `https://` URL through the app in tests, which reaches the same code path as
  `socket.encrypted` in production. A live `createSecureServer` run would be the direct proof;
  it was not set up here.
* **Wallet flows were not exercised under the CSP.** Headless Chromium has no wallet
  extension, so the `frame-src`/`img-src`/`connect-src` allowances for RainbowKit and
  WalletConnect are reasoned rather than observed. They are deliberately permissive for that
  reason.
* **No certificate automation is in this repo.** `infra/` and `.github/` were out of scope.
* **CORS does not stop a scripted client from reading anything**, and is not claimed to. It is
  a browser policy and a fence for the future, not access control. If a route ever needs to be
  private, it needs authentication; `Access-Control-Allow-Origin` is not that.
* **`/stream` is unbounded in subscriber count per process.** The rate limiter sees one request
  per tab and the route caps itself at ten minutes, so a client opening a hundred tabs is
  charged for a hundred buckets — but a subscriber that never reads and never closes is still
  one live loop. `maxMs` bounds it; nothing bounds the count.
* **A preflight is answered before the rate limiter.** CORS sits outside it deliberately: if
  the limiter fired first, a legitimate cross-origin client over budget would get a 429 with no
  `Access-Control-Allow-Origin`, which the browser reports as a CORS failure rather than as a
  retry. The cost of that choice is that an `OPTIONS` flood is limited only by how cheap a 403
  is — it never reaches a route, so it never triggers a `buildSnapshot`. Stated rather than
  hidden because it is a real trade, not an oversight.
* **The body ceiling reads `Content-Length`, and nothing else.** A chunked body with no
  announced length passes through to the router. Since no route reads a body, nothing consumes
  it — but the honest ceiling for that case is the proxy's `client_max_body_size`.

## Documentation this work could not touch

`.env.example`, `README.md` and `HARDENING.md` are outside the files this change owns, so the
new variables are not yet in them. The lines to add to the `# required by apps/api` block of
`.env.example`:

```bash
# optional: transport policy. Defaults keep the local demo on http working unchanged;
# see docs/security-headers.md for what each one is actually worth.
ALLOWED_ORIGINS=
ALLOW_CREDENTIALS=
ENFORCE_HTTPS=
TRUST_PROXY=
MAX_BODY_BYTES=65536
REQUEST_TIMEOUT_MS=10000
HSTS_MAX_AGE=31536000
READY_MAX_LAG=5
```

An empty `ALLOWED_ORIGINS` is not "allow nothing" — it means "use the four documented demo
origins", which is what makes the default install behave.
