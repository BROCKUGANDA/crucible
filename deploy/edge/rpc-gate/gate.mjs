/**
 * The public chain RPC, gated.
 *
 * The browser wallet needs an RPC it can reach (reads and its own signed
 * transactions), but the node behind it is an anvil with cheat methods:
 * `anvil_setBalance`, `anvil_impersonateAccount`, `anvil_setNextBlockTimestamp`
 * and friends let anyone rewrite the demo chain's state. Serving the node
 * directly made every trial on the site griefable by curl.
 *
 * This gate is the whole control: a method allowlist. Standard wallet methods
 * pass; the node-control namespaces (`anvil_`, `evm_`, `debug_`, `personal_`,
 * `admin_`) and anything unlisted are refused before the node sees them. It
 * holds no key, signs nothing, and keeps no state beyond a rate-limit bucket.
 *
 * What it deliberately does not do: authenticate callers. The demo chain is
 * valueless and the wallet methods it allows are the ones any public RPC
 * serves. On a chain holding real funds this gate is not sufficient — the
 * endpoint must then sit behind auth or not exist (mainnet runbook).
 */
import { createServer } from "node:http";

export const ALLOWED_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getBlockReceipts",
  "eth_getCode",
  "eth_getLogs",
  "eth_getProof",
  "eth_getStorageAt",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_sendRawTransaction",
  "net_version",
  "web3_clientVersion",
  "web3_sha3",
]);

export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_BATCH = 100;

/** Token bucket: `capacity` burst, refilled at `refillPerSecond`. */
export function createRateLimiter({ capacity = 120, refillPerSecond = 2, now = Date.now } = {}) {
  const buckets = new Map();
  return {
    take(key) {
      const t = now();
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { tokens: capacity, last: t };
        buckets.set(key, bucket);
      }
      const elapsed = Math.max(0, (t - bucket.last) / 1000);
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSecond);
      bucket.last = t;
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
  };
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function clientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function createGate({ upstream, limiter = createRateLimiter(), fetchImpl = fetch } = {}) {
  if (!upstream) throw new Error("RPC_GATE_UPSTREAM is required");
  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(jsonRpcError(null, -32600, "method not allowed: POST only"));
        return;
      }
      if (!limiter.take(clientKey(req))) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "5" });
        res.end(jsonRpcError(null, -32005, "rate limited"));
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(jsonRpcError(null, -32600, "request too large"));
          return;
        }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      let parsed;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(jsonRpcError(null, -32700, "parse error"));
        return;
      }
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      if (calls.length > MAX_BATCH) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(jsonRpcError(null, -32600, "batch too large"));
        return;
      }
      for (const call of calls) {
        const method = call && typeof call === "object" ? call.method : undefined;
        if (typeof method !== "string" || !ALLOWED_METHODS.has(method)) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(
            jsonRpcError(
              call && typeof call === "object" ? call.id : null,
              -32601,
              `method not available on this endpoint: ${String(method)}`,
            ),
          );
          return;
        }
      }
      const upstreamRes = await fetchImpl(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      const text = await upstreamRes.text();
      res.writeHead(upstreamRes.status, {
        "content-type": upstreamRes.headers.get("content-type") ?? "application/json",
      });
      res.end(text);
    } catch {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(jsonRpcError(null, -32603, "upstream unavailable"));
      }
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.RPC_GATE_PORT ?? 8791);
  const gate = createGate({ upstream: process.env.RPC_GATE_UPSTREAM });
  gate.listen(port, "0.0.0.0", () => {
    console.log(`[rpc-gate] listening on :${port}, upstream ${process.env.RPC_GATE_UPSTREAM}`);
  });
}
