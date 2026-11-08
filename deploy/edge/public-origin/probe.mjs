#!/usr/bin/env node
/**
 * Prove the public site was not built against a developer's own machine.
 *
 * `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_ANVIL_RPC` are inlined into the browser bundle at
 * BUILD time. On 2026-11-07 the host `.env` still carried the loopback defaults, so the shipped
 * chunk read `let a="http://127.0.0.1:8787"` and every visitor's browser asked *their own*
 * localhost for the chain. `/trials/:id` and `/hall` rendered "Couldn't reach the chain" while
 * `/api/ready`, `/api/snapshot` and `/api/stream` all answered 200 from the same host — the API
 * was healthy and the product was not. The landing kept working because it does not read through
 * that constant, which is exactly why nobody noticed.
 *
 * `next.config.mjs` already has a `localTargetOnly` CSP policy, but it ADAPTS to a loopback build
 * instead of refusing to serve one, and `deploy.yml` excludes `.env` from the sync without ever
 * checking what the host's copy says. So this is the leg that measures the deployed artefact.
 *
 * What it deliberately does NOT assert: "the bundle contains no 127.0.0.1". Measured on the
 * healthy deployment, vendor code legitimately carries `http://127.0.0.1:8545` (viem's `foundry`
 * chain default, which the app overrides). A naive loopback scan is red on a good site, which
 * would teach an operator to ignore it. These are the five values that mean "a laptop wrote this
 * build", taken from `.env.example` and `LOOPBACK_API_DEFAULTS`.
 *
 * Exit 0 = the public origin is baked, the policy names it, and the public stream is a stream.
 * Exit 1 = at least one of those is false; the site is serving a local-target build.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { pathToFileURL } from "node:url";

/** The developer defaults. Their presence in a public bundle is the defect, not a clue. */
export const LOCAL_DEFAULTS = [
  "http://127.0.0.1:8787",
  "http://127.0.0.1:8788",
  "http://localhost:8787",
  "http://localhost:8788",
  "http://127.0.0.1:8555",
];

/** Which developer defaults a body of served JavaScript carries. */
export function findLocalDefaults(text) {
  return LOCAL_DEFAULTS.filter((value) => text.includes(value));
}

/** The connect-src directive of a CSP header, or null when the header names none. */
export function connectSrcOf(csp) {
  if (!csp) return null;
  for (const part of csp.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("connect-src")) return trimmed.slice("connect-src".length).trim();
  }
  return null;
}

/**
 * A public production build cannot name a plaintext origin (next.config.mjs drops them), so a
 * loopback entry in connect-src means `localTargetOnly` was true — i.e. every configured target
 * was plaintext, i.e. the build args were a laptop's.
 */
export function policyNamesLoopback(csp) {
  const directive = connectSrcOf(csp);
  if (!directive) return false;
  return /(?:^|\s)http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\s|$)/.test(directive);
}

/** SSE must arrive as a stream. `text/html` here is the edge handing back the page instead. */
export function isEventStream({ status, contentType }) {
  return status === 200 && /^text\/event-stream\b/i.test(contentType ?? "");
}

function get(url, { timeoutMs = 20000, headersOnly = false, maxBytes = 4_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const send = url.startsWith("https:") ? httpsRequest : httpRequest;
    const req = send(url, { method: "GET", headers: { accept: "*/*" } }, (res) => {
      const status = res.statusCode ?? 0;
      const headers = res.headers;
      // An SSE response never ends. Headers are the whole question, so hang up on them.
      if (headersOnly) {
        res.destroy();
        resolve({ status, headers, body: "" });
        return;
      }
      let body = "";
      let bytes = 0;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) {
          res.destroy();
          reject(new Error(`response over ${maxBytes} bytes: ${url}`));
          return;
        }
        body += chunk;
      });
      res.on("end", () => resolve({ status, headers, body }));
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms: ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

/** The chunk paths a served document references. */
export function chunkPathsOf(html) {
  const found = new Set();
  for (const match of html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+\.js)"/g)) found.add(match[1]);
  return [...found];
}

export async function probe(url, opts = {}) {
  const origin = new URL(url).origin;
  const rows = [];

  const page = await get(`${origin}/`, opts);
  const csp = page.headers["content-security-policy"] ?? "";
  rows.push({
    probe: "CSP names the public origin",
    ok: page.status === 200 && (connectSrcOf(csp) ?? "").includes(origin),
    response: `${page.status} connect-src: ${connectSrcOf(csp) ?? "(none)"}`,
  });
  rows.push({
    probe: "CSP names no loopback (a public build cannot be local-target)",
    ok: page.status === 200 && !policyNamesLoopback(csp),
    response: policyNamesLoopback(csp) ? "connect-src admits a laptop origin" : "no loopback in connect-src",
  });

  const paths = chunkPathsOf(page.body);
  // A scan that walks zero files proves nothing — the failure this repo has been caught in twice.
  rows.push({
    probe: "the document references app chunks to scan",
    ok: paths.length > 0,
    response: `${paths.length} chunks`,
  });

  let hits = [];
  let publicBaseSeen = false;
  for (const path of paths) {
    const res = await get(`${origin}${path}`, opts);
    if (res.status !== 200) {
      hits.push(`${path} -> HTTP ${res.status}`);
      continue;
    }
    hits.push(...findLocalDefaults(res.body).map((value) => `${path}: ${value}`));
    if (res.body.includes(`${origin}/api`)) publicBaseSeen = true;
  }
  rows.push({
    probe: "no developer default baked into the served bundle",
    ok: paths.length > 0 && hits.length === 0,
    response: hits.length ? hits.slice(0, 6).join("; ") : `scanned ${paths.length} chunks, none of the ${LOCAL_DEFAULTS.length} defaults`,
  });
  rows.push({
    probe: "the public API base is baked into the served bundle",
    ok: publicBaseSeen,
    response: publicBaseSeen ? `${origin}/api present` : `${origin}/api absent from every chunk`,
  });

  const stream = await get(`${origin}/api/stream`, { ...opts, headersOnly: true });
  rows.push({
    probe: "public /api/stream answers text/event-stream",
    ok: isEventStream({ status: stream.status, contentType: stream.headers["content-type"] }),
    response: `${stream.status} ${stream.headers["content-type"] ?? "(no content-type)"}`,
  });

  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--url");
  const url = at >= 0 ? args[at + 1] : args[0];
  if (!url) {
    console.error("usage: probe.mjs --url https://host");
    process.exit(2);
  }
  const rows = await probe(url);
  let failed = 0;
  for (const row of rows) {
    console.log(`${row.ok ? "PASS" : "FAIL"}  ${row.probe}\n      ${row.response}`);
    if (!row.ok) failed += 1;
  }
  if (failed > 0) {
    console.error(`\n${failed} of ${rows.length} probes failed: ${url} is serving a local-target build.`);
    process.exit(1);
  }
  console.log(`\n${rows.length}/${rows.length} probes as expected: ${url} was built for the public origin.`);
}
