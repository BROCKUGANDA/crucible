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

async function post(server, body) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
