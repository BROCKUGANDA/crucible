import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_METHODS, createGate, createRateLimiter } from "./gate.mjs";

/**
 * The public RPC gate.
 *
 * The failure mode this file guards is the demo chain's cheat surface: an
 * unauthenticated `anvil_setBalance` or `anvil_impersonateAccount` from
 * anyone on the internet. Every test here is a method that must never
 * reach the node, or a wallet method that must keep working.
 */

function startGate(handler) {
  return new Promise((resolve) => {
    const server = createGate({
      upstream: "http://upstream.invalid",
      limiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }),
      fetchImpl: handler,
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function post(server, body, headers = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

const echoUpstream = async (url, init) =>
  new Response(init.body, { status: 200, headers: { "content-type": "application/json" } });

test("forwards an allowlisted read", async (t) => {
  const server = await startGate(echoUpstream);
  t.after(() => server.close());
  const res = await post(server, { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });
  assert.equal(res.status, 200);
  assert.match(res.text, /eth_blockNumber/);
});

test("forwards eth_sendRawTransaction (the wallet's own signed tx)", async (t) => {
  const server = await startGate(echoUpstream);
  t.after(() => server.close());
  assert.ok(ALLOWED_METHODS.has("eth_sendRawTransaction"));
  const res = await post(server, { jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: ["0xdead"] });
  assert.equal(res.status, 200);
});

test("refuses node-control methods before the node sees them", async (t) => {
  const server = await startGate(echoUpstream);
  t.after(() => server.close());
  for (const method of [
    "anvil_setBalance",
    "anvil_impersonateAccount",
    "anvil_setNextBlockTimestamp",
    "evm_mine",
    "evm_revert",
    "debug_traceTransaction",
    "personal_sign",
    "admin_peers",
    "eth_sendTransaction",
    "eth_sign",
  ]) {
    const res = await post(server, { jsonrpc: "2.0", id: 3, method, params: [] });
    assert.equal(res.status, 403, `${method} must be refused`);
    assert.match(res.text, /method not available/);
  }
});

test("refuses a batch containing one forbidden method", async (t) => {
  const server = await startGate(echoUpstream);
  t.after(() => server.close());
  const res = await post(server, [
    { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
    { jsonrpc: "2.0", id: 2, method: "anvil_mine", params: [] },
  ]);
  assert.equal(res.status, 403);
});

test("refuses non-POST and malformed JSON", async (t) => {
  const server = await startGate(echoUpstream);
  t.after(() => server.close());
  const { port } = server.address();
  const get = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(get.status, 200);
  const bad = await post(server, "{not json");
  assert.equal(bad.status, 400);
});

test("rate limiter admits a burst then refuses", () => {
  let nowMs = 0;
  const limiter = createRateLimiter({ capacity: 3, refillPerSecond: 1, now: () => nowMs });
  assert.equal(limiter.take("a"), true);
  assert.equal(limiter.take("a"), true);
  assert.equal(limiter.take("a"), true);
  assert.equal(limiter.take("a"), false);
  assert.equal(limiter.take("b"), true);
  nowMs += 2000;
  assert.equal(limiter.take("a"), true);
});

test("keys the limiter on the right-most forwarded entry, so a spoofed prefix cannot mint buckets", async (t) => {
  // The proxy overwrites X-Forwarded-For, so in production the header carries exactly
  // one entry — the real client. The header below is what a caller sends when the
  // overwrite is missing (or what arrives if the gate is reached in-network): a fresh
  // invented entry prepended per request. Keying on the LEFT entry gave each of these
  // its own bucket and made the limiter decorative; the right-most entry is the one
  // the trusted hop wrote, so all three of these share one bucket and the third
  // refusal is the control working.
  const server = new Promise((resolve) => {
    const s = createGate({
      upstream: "http://upstream.invalid",
      limiter: createRateLimiter({ capacity: 2, refillPerSecond: 0 }),
      fetchImpl: echoUpstream,
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.then((s) => s.close()));
  const up = await server;

  const first = await post(up, { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }, {
    "x-forwarded-for": "9.9.9.9, 203.0.113.7",
  });
  assert.equal(first.status, 200);

  const second = await post(up, { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] }, {
    "x-forwarded-for": "8.8.8.8, 203.0.113.7",
  });
  assert.equal(second.status, 200);

  const third = await post(up, { jsonrpc: "2.0", id: 3, method: "eth_blockNumber", params: [] }, {
    "x-forwarded-for": "7.7.7.7, 203.0.113.7",
  });
  assert.equal(third.status, 429, "a spoofed left entry must not mint a fresh bucket");

  // And a genuinely different right-most entry still has its own bucket: the limiter
  // limits per client, not per planet.
  const other = await post(up, { jsonrpc: "2.0", id: 4, method: "eth_blockNumber", params: [] }, {
    "x-forwarded-for": "203.0.113.9",
  });
  assert.equal(other.status, 200);
});
