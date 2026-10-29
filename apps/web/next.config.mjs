import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */

const here = path.dirname(fileURLToPath(import.meta.url));

// `@wagmi/connectors` exports every connector from one barrel, and some of those
// connectors reach into packages we neither install nor use. Webpack resolves the whole
// barrel regardless, then fails on their undeclared peers. Nothing in Crucible can ever
// reach this code — we use injected wallets and WalletConnect — so the unused subtrees
// are cut from the module graph here.
//
//   * `@base-org/account` -> `@coinbase/cdp-sdk` -> the optional `@x402/*` payment stack
//   * `@metamask/sdk` imports `@react-native-async-storage/*`, a React Native peer that
//     does not belong in a browser bundle
//
// Aliasing the *entry points* to `false` drops entire subtrees in one move, rather than
// chasing whichever leaf subpath fails first. A non-`$` key also matches subpaths.
//
// Remove these when `@wagmi/connectors` stops re-exporting the whole connector set from
// its root barrel, or when the upstream packages declare their peers properly.
const UNUSED_WALLET_SUBTREES = [
  "@base-org/account",
  "@coinbase/cdp-sdk",
  "@react-native-async-storage/async-storage",
  "@react-native-async-storage",
];

/**
 * `@crucible/indexer` resolves to its `api` module alone, not to its barrel.
 *
 * The repo has exactly one wei -> ETH formatter, and it lives in
 * `packages/indexer/src/api.ts` — it has to, because it builds every ETH string in every
 * API payload and the browser must not compute the same amount a second way. `src/lib/eth.ts`
 * therefore imports it as a value, which is the first time the indexer's runtime has ever
 * been in the client bundle, and the bundle does not compile:
 *
 *   node:fs -> packages/indexer/dist/scribe.js -> dist/index.js -> src/lib/eth.ts
 *
 * `Scribe` reads and writes a cursor file, so it legitimately imports `node:fs`; the barrel
 * re-exports it, so importing *anything* from the package drags the filesystem reader into
 * the browser. Webpack then fails the build with `UnhandledSchemeError: Reading from
 * "node:fs" is not handled by plugins` — a real error, and a fair one: a browser has no `fs`.
 *
 * Aliasing the package id to the api module cuts the barrel out of the graph while leaving
 * the shared formatter itself reachable. `api.js` imports only `./model.js` and
 * `@crucible/smith`, and neither touches a Node builtin, so what lands in the bundle is the
 * formatter and the read-model projections it builds payloads from.
 *
 * The `$` suffix keeps the alias exact, so a future deep import of another submodule
 * resolves normally instead of being silently rewritten. Every type-only import of this
 * package is unaffected — they are erased before bundling, which is why this hazard only
 * surfaced once a value was needed.
 *
 * Remove this when the indexer package publishes an `./api` subpath export (or when `Scribe`
 * stops sharing a barrel with the payload builders). Both are changes in
 * `packages/indexer`, which this file must not need to know about.
 */
const INDEXER_API_MODULE = path.join(
  here,
  "..",
  "..",
  "node_modules",
  "@crucible",
  "indexer",
  "dist",
  "api.js",
);

/**
 * Response headers for the web app, and why each one is where it is.
 *
 * The measured constraints, from loading the running app in Chromium with policies injected
 * into the document response (`crucible-scratch/security/verify2.mjs`):
 *
 *   * `style-src 'unsafe-inline'` is **not optional**. `/hall` alone produced 11
 *     `style-src-attr` violations without it, because the components carry 213 inline
 *     `style={{}}` props across 13 files and an inline style attribute is exactly what CSP's
 *     `style-src` governs. A hash or nonce cannot help: an attribute-level allowance has to be
 *     `unsafe-inline`, or the styles move into a stylesheet, which is a component change.
 *     The app's own inline `style={{}}` props are gone now — `test/no-inline-styles.test.ts` is
 *     the gate — but the allowance stays, because RainbowKit's modal writes style attributes by
 *     itself and that surface has never been re-measured here. Dropping it is a measured change,
 *     not a one-line edit; see `docs/security-headers.md`.
 *   * `script-src 'unsafe-inline'` is also not optional: Next's App Router ships the flight
 *     payload as inline `<script>self.__next_f.push(...)</script>` (15 blocked on `/hall`),
 *     and those tags come from the framework's renderer, not from this app's markup.
 *   * **Nonces exist in this version of Next and they are still not free.** The guide
 *     (`node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`) is explicit:
 *     the renderer reads a `nonce-` value out of the policy on the *request*, so a nonce needs a
 *     `proxy.ts` minting one per response — which forces **dynamic rendering** for every page,
 *     disables static generation and CDN caching, and is incompatible with PPR. This site
 *     currently prerenders (`X-Nextjs-Prerender: 1` on `/`) and has no database to render from
 *     (ADR-0008: the indexer is in-memory and the browser streams it). A static `headers()`
 *     entry cannot carry a nonce either: `headers()` is evaluated at build time, so the "nonce"
 *     would be one fixed string on every response — the appearance of the control without the
 *     property. So the enforcing policy keeps `'unsafe-inline'`, and what this file can honestly
 *     do instead is (a) refuse to name origins that only exist on a laptop, and (b) emit a
 *     **report-only** strict policy when a collector is configured, so the cost of dropping
 *     `'unsafe-inline'` is measured on the real deployment rather than argued about.
 *   * In **dev**, `script-src` additionally needs `'unsafe-eval'` — React Refresh evaluates the
 *     patch, and without the allowance the page hydrates to zero rows. Since that is a
 *     dev-server-only mechanism and a policy that breaks hot reload gets disabled within the
 *     hour, the CSP is applied to production builds only. `next dev` still gets the harmless
 *     headers below.
 *   * `connect-src` has to name the API origin: the browser talks to the API directly
 *     (`src/lib/useSnapshot.ts` opens an `EventSource`), and a policy that blocks it does not
 *     error visibly — it silently degrades the live view to the polling fallback. That failure
 *     mode is why the loopback origins below are *conditional* rather than deleted: `compose.yaml`
 *     builds this same image against `http://127.0.0.1:8787` and the host-published Anvil port,
 *     and un-naming them there would break the demo invisibly on a laptop while looking like a
 *     tightening.
 *
 * Not here: `Strict-Transport-Security`. `headers()` is static, so it cannot know whether the
 * request arrived over TLS, and emitting HSTS over plaintext is how a local demo gets its
 * hostname pinned into the browser and stops loading. That header belongs at whatever
 * terminates TLS, which is also where the real transport security lives.
 *
 * What this policy is worth with `'unsafe-inline'` in two of its directives is limited and
 * worth saying plainly: it does not stop an injected inline script. What it does stop is a
 * script loaded from a host that is not this origin, a `<base>` tag hijack, a form repointing
 * somewhere else, this app being framed, and `connect-src`-level exfiltration to an arbitrary
 * server — which is exactly why the loopback entries mattered so much on the public origin: an
 * injected script needs a *reachable* host to talk to, and naming a visitor's own ports handed it
 * one. Tightening past `'unsafe-inline'` needs the flight scripts restructured plus a
 * per-request nonce, i.e. the dynamic-rendering change described above.
 */

// The API origins a build may be pointed at. `NEXT_PUBLIC_API_URL` is inlined into the client
// bundle at build time, so whatever the bundle talks to must appear here too or the CSP
// disagrees with the app. The four loopback values are the README's local-demo endpoints;
// hardcoding them unconditionally is what the browser audit of 2026-10-29 found on the public
// HTTPS origin (`http://127.0.0.1:8787`, `:8788`, `http://localhost:8787`, `:8788`, and the
// Anvil port from `NEXT_PUBLIC_ANVIL_RPC`). They are now admitted only to a local-target
// policy — see `localTargetOnly`, and `test/csp-origins.test.ts` for both halves of that rule.
const LOOPBACK_API_DEFAULTS = [
  "http://127.0.0.1:8787",
  "http://127.0.0.1:8788",
  "http://localhost:8787",
  "http://localhost:8788",
];

function originOf(value) {
  try {
    return value ? new URL(value).origin : null;
  } catch {
    return null;
  }
}

/** Anything reachable over plaintext http: a laptop's port today, a bare-IP host tomorrow. */
function isInsecure(origin) {
  try {
    return new URL(origin).protocol === "http:";
  } catch {
    return true;
  }
}

const isProductionBuild = process.env.NODE_ENV === "production";

// The origins this build was *configured* to reach — including the RPC, whose value belongs to
// the chain/provider configuration another agent owns. Reading them is what separates a public
// deployment from the local stack: `compose.yaml` passes loopback defaults, the VPS passes
// `https://crucible.svalley.tech`. Nothing here rewrites an RPC URL; it only decides whether a
// given one may enter a public policy.
const CONFIGURED_ORIGINS = [
  originOf(process.env.NEXT_PUBLIC_API_URL),
  originOf(process.env.NEXT_PUBLIC_ANVIL_RPC),
].filter(Boolean);

const localTargetOnly =
  !isProductionBuild ||
  // Nothing configured: this is the documented local default, not a public host.
  CONFIGURED_ORIGINS.length === 0 ||
  // Every configured target is plaintext, so the deployment is the local stack.
  CONFIGURED_ORIGINS.every(isInsecure);

// WalletConnect's relay, bridge and telemetry are called by its provider when a project id is
// configured. Naming these hosts is the difference between a CSP and a broken connect button.
const THIRD_PARTY = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  ...(process.env.NEXT_PUBLIC_ANVIL_RPC ? [originOf(process.env.NEXT_PUBLIC_ANVIL_RPC)] : []),
  "wss://relay.walletconnect.com",
  "https://relay.walletconnect.com",
  "https://bridge.walletconnect.org",
  "https://pulse.walletconnect.com",
];

const connectOrigins = new Set(
  [
    ...(localTargetOnly ? LOOPBACK_API_DEFAULTS : []),
    process.env.NEXT_PUBLIC_API_URL,
    ...THIRD_PARTY,
  ]
    .map(originOf)
    .filter(Boolean)
    // A public production build cannot name a plaintext origin. When the build *is*
    // local-target the entries stay, because dropping them degrades the live feed silently
    // rather than loudly (see the `connect-src` bullet above).
    .filter((origin) => localTargetOnly || !isInsecure(origin)),
);

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // Images carry data: URIs from RainbowKit's wallet registry and blob: from generated QR
  // codes; https: is left open because a wallet icon host is not something this repo controls.
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // Frenchy's clip is fetched as bytes and played from a blob: object URL, and `default-src
  // 'self'` does not cover blob: for media — the element reports "no supported source was
  // found", which is indistinguishable from a dead provider unless the CSP is stated here.
  "media-src 'self' blob:",
  `connect-src 'self' ${[...connectOrigins].join(" ")}`,
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  // Wallet onboarding flows open third-party frames; blocking them blocks signing, not attacks.
  "frame-src 'self' https:",
].join("; ");

/**
 * The report-only probe: the shipped policy minus exactly the two inline allowances.
 *
 * A `Content-Security-Policy-Report-Only` header observes and reports; it enforces nothing, so
 * emitting it cannot empty a page. What it buys is the measurement the constraint above needs:
 * with a collector configured, the deployment learns which inline blocks a strict policy would
 * break (the flight payload, the wallet modal's style attributes) and how many per page load,
 * instead of the repo re-deriving it from a laptop.
 *
 * It is emitted **only** when `CSP_REPORT_URL` names a collector. A report header pointing at
 * nothing is decoration, and this project has no endpoint that accepts CSP reports — `apps/api`
 * is a read-only chain projection and is outside this file. Nothing was added to serve one, so
 * the hook ships dark. The volume is not trivial (every page load reports every blocked inline
 * block), which is the second reason this stays opt-in: whatever receives it must rate-limit.
 * `report-to` is the current mechanism and needs the companion `Reporting-Endpoints` header;
 * `report-uri` is the legacy fallback. Both name the same collector.
 */
const reportEndpoint = isProductionBuild ? (process.env.CSP_REPORT_URL ?? "").trim() : "";

const reportOnlyCsp = reportEndpoint
  ? [
      CSP.replace("script-src 'self' 'unsafe-inline'", "script-src 'self'").replace(
        "style-src 'self' 'unsafe-inline'",
        "style-src 'self'",
      ),
      "report-to csp",
      `report-uri ${reportEndpoint}`,
    ].join("; ")
  : "";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    key: "Permissions-Policy",
    // The microphone is open to this origin, and that is a correction rather
    // than a relaxation.
    //
    // The policy said `microphone=()` while the product has shipped a voice
    // control since 2026-10-28: the header's Frenchy panel asks for the
    // microphone, and `microphone=()` makes the browser refuse it before the
    // visitor is ever prompted. The button could not work, and the refusal it
    // produced told the visitor to change their browser settings - which is not
    // what was wrong.
    //
    // `microphone=(self)` is the narrowest thing that lets the feature work:
    // this origin may ask, no other origin may, and the browser still asks the
    // visitor. The microphone is requested only when somebody presses Listen.
    value: "camera=(), microphone=(self), geolocation=(), payment=(), usb=(), display-capture=()",
  },
  ...(isProductionBuild ? [{ key: "Content-Security-Policy", value: CSP }] : []),
  ...(reportEndpoint
    ? [
        { key: "Reporting-Endpoints", value: `csp="${reportEndpoint}"` },
        { key: "Content-Security-Policy-Report-Only", value: reportOnlyCsp },
      ]
    : []),
];

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@crucible/smith", "@crucible/indexer"],

  // The 2026-10-29 browser audit found `X-Powered-By: Next.js` on the public origin. Nothing
  // here reads it, the edge does not route on it, and the standalone image does not use it; all
  // it does is tell a scanner which stack to attack. `Via` is Caddy's own addition, so it is
  // deleted there (`deploy/edge/Caddyfile`), and the `X-Nextjs-*` cache markers are left alone —
  // see the report on what that means for stack disclosure.
  poweredByHeader: false,

  // TypeScript 7 ships no compiler API, so Next's in-process tsconfig reader cannot load
  // the `paths` aliases; CLI mode reads them back through `tsc --showConfig`.
  experimental: {
    useTypeScriptCli: true,
  },

  // Traced server for the Docker runner stage (apps/web/Dockerfile); `next start`
  // is unaffected.
  output: "standalone",

  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      // Gate 478-482: X-Robots-Tag noindex on internal surfaces so crawlers never index
      // SSE streams, API endpoints, or replay views even if a link leaks.
      {
        source: "/api/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex" }],
      },
      {
        source: "/ticker/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex" }],
      },
      {
        source: "/replay/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex" }],
      },
      {
        source: "/zone/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex" }],
      },
    ];
  },

  // This is a monorepo; without this Next picks whichever lockfile it finds first,
  // which on this machine is an unrelated one in the home directory.
  outputFileTracingRoot: path.join(here, "..", ".."),

  webpack: (config) => {
    for (const pkg of UNUSED_WALLET_SUBTREES) {
      config.resolve.alias[pkg] = false;
    }
    config.resolve.alias["@crucible/indexer$"] = INDEXER_API_MODULE;
    return config;
  },
};

export default nextConfig;