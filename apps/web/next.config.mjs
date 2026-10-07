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
 *   * `script-src 'unsafe-inline'` is also not optional: Next's App Router ships the flight
 *     payload as inline `<script>self.__next_f.push(...)</script>` (15 blocked on `/hall`),
 *     and Next 15 has no built-in nonce for those.
 *   * In **dev**, `script-src` additionally needs `'unsafe-eval'` — React Refresh evaluates the
 *     patch, and without the allowance the page hydrates to zero rows. Since that is a
 *     dev-server-only mechanism and a policy that breaks hot reload gets disabled within the
 *     hour, the CSP is applied to production builds only. `next dev` still gets the harmless
 *     headers below.
 *   * `connect-src` has to name the API origin: the browser talks to the API directly
 *     (`src/lib/useSnapshot.ts` opens an `EventSource`), and a policy that blocks it does not
 *     error visibly — it silently degrades the live view to the polling fallback.
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
 * server. Tightening past that needs the inline styles and flight scripts restructured, which
 * is a component change and outside this file.
 */

// The API origins a production bundle may be pointed at, plus the loopback defaults the README
// documents. Set NEXT_PUBLIC_API_URL at build time; the value is inlined into the client
// bundle, so it has to be in the policy too or the CSP will disagree with the app.
const API_ORIGINS = new Set(
  [
    process.env.NEXT_PUBLIC_API_URL,
    "http://127.0.0.1:8787",
    "http://127.0.0.1:8788",
    "http://localhost:8787",
    "http://localhost:8788",
  ]
    .map((v) => {
      try {
        return v ? new URL(v).origin : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean),
);

// The RPC is called from the browser by wagmi; WalletConnect's relay, bridge and telemetry are
// called by its provider when a project id is configured. Naming these hosts is the difference
// between a CSP and a broken connect button.
const THIRD_PARTY = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  ...(process.env.NEXT_PUBLIC_ANVIL_RPC ? [new URL(process.env.NEXT_PUBLIC_ANVIL_RPC).origin] : []),
  "wss://relay.walletconnect.com",
  "https://relay.walletconnect.com",
  "https://bridge.walletconnect.org",
  "https://pulse.walletconnect.com",
];

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // Images carry data: URIs from RainbowKit's wallet registry and blob: from generated QR
  // codes; https: is left open because a wallet icon host is not something this repo controls.
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self' ${[...API_ORIGINS, ...THIRD_PARTY].join(" ")}`,
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  // Wallet onboarding flows open third-party frames; blocking them blocks signing, not attacks.
  "frame-src 'self' https:",
].join("; ");

const isProductionBuild = process.env.NODE_ENV === "production";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()",
  },
  ...(isProductionBuild ? [{ key: "Content-Security-Policy", value: CSP }] : []),
];

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@crucible/smith", "@crucible/indexer"],

  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
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
    return config;
  },
};

export default nextConfig;