/**
 * The API's only contact with @human.tech/clean.sdk: a loopback HTTP read.
 *
 * Keeping the SDK in its own process is deliberate. It carries the Aztec bridge and a native
 * level store; none of that belongs in the escrow's API, in CI's workspace install, or on the
 * settlement path (ADR-0001). This process exposes one read and holds no key.
 */

import http from "node:http";
import { pathToFileURL } from "node:url";
import { createEligibilitySource } from "./eligibility.mjs";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

export function createServer(source, { logger = console } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, configured: true, check: "l1-eligibility" });
    }

    if (req.method === "GET" && url.pathname.startsWith("/eligibility/")) {
      const address = decodeURIComponent(url.pathname.slice("/eligibility/".length));
      if (!ADDRESS.test(address)) {
        return json(res, 400, { error: "wallet must be a 0x-prefixed 20-byte Ethereum address" });
      }
      try {
        return json(res, 200, await source.check(address));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.error(`[clean-passport] eligibility failed: ${reason}`);
        return json(res, 502, { error: "passport source did not answer", reason });
      }
    }

    return json(res, 404, { error: "not found" });
  });
}

async function main() {
  const port = Number(process.env.CLEAN_PASSPORT_PORT ?? 8789);
  const host = process.env.CLEAN_PASSPORT_HOST ?? "127.0.0.1";
  const apiUrl = process.env.CLEAN_API_URL ?? "https://shield.human.tech";
  // The SDK's constructor requires an L1 RPC URL. The eligibility route never dials it, and
  // the default is deliberately unreachable so this process cannot quietly start reading a
  // chain it was not asked to read.
  const l1RpcUrl = process.env.L1_RPC_URL ?? "http://127.0.0.1:1";
  const domain = process.env.CLEAN_DOMAIN ?? "localhost";

  const source = createEligibilitySource({ apiUrl, l1RpcUrl, domain });
  const server = createServer(source);
  server.listen(port, host, () => {
    console.log(`[clean-passport] listening on http://${host}:${port} (upstream ${apiUrl})`);
  });

  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) {
  main().catch((err) => {
    console.error(`[clean-passport] failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
