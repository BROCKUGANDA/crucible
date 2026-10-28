import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { MUST_BE_REFUSED, isRefusal, probe } from "./probe.mjs";
import { createGate, createRateLimiter } from "./gate.mjs";

/**
 * The probe is the only evidence that the deployed route goes through the gate, so it
 * gets the treatment the rest of this repo gives a money gate: it must be proven to fail.
 *
 * The negative control below is not hypothetical — it replays the exact responses measured
 * on the live endpoint on 2026-10-27, when the installed edge proxied /anvil straight to
 * anvil: `eth_accounts` returned the ten unlocked dev signers and `anvil_setBalance`
 * answered with the node's own `-32602`. A probe that passed that server would have been
 * the same class of claim as "the gate is deployed".
 */

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/`)));
}

/** The node as the bypass served it: everything answered, nothing refused. */
function stubAnvil() {
  return createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const calls = Array.isArray(body) ? body : [body];
      const results = calls.map((call) => {
        if (call.method === "eth_accounts") {
          return { jsonrpc: "2.0", id: call.id, result: ["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"] };
        }
        if (call.method === "anvil_setBalance") {
          return { jsonrpc: "2.0", id: call.id, error: { code: -32602, message: "invalid length 0, expected tuple variant EthRequest::SetBalance with 2 elements" } };
        }
        if (call.method === "eth_chainId") return { jsonrpc: "2.0", id: call.id, result: "0x7a69" };
        return { jsonrpc: "2.0", id: call.id, result: "0x1" };
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(body) ? results : results[0]));
    });
  });
}

const echoUpstream = async (url, init) => {
  const body = JSON.parse(String(init.body));
  const calls = Array.isArray(body) ? body : [body];
  const results = calls.map((call) => ({ jsonrpc: "2.0", id: call.id, result: call.method === "eth_chainId" ? "0x7a69" : "0x1" }));
  return new Response(JSON.stringify(Array.isArray(body) ? results : results[0]), { status: 200, headers: { "content-type": "application/json" } });
};

test("the probe passes against the gate", async (t) => {
  const gate = createGate({
    upstream: "http://upstream.invalid",
    limiter: createRateLimiter({ capacity: 10000, refillPerSecond: 10000 }),
    fetchImpl: echoUpstream,
  });
  const url = await listen(gate);
  t.after(() => gate.close());
  const rows = await probe(url);
  assert.equal(rows.length, MUST_BE_REFUSED.length + 2);
  const failures = rows.filter((r) => !r.ok);
  assert.deepEqual(failures.map((f) => f.probe), []);
});

test("NEGATIVE CONTROL: the probe fails against an ungated node — the 2026-10-27 bypass", async (t) => {
  const anvil = stubAnvil();
  const url = await listen(anvil);
  t.after(() => anvil.close());
  const rows = await probe(url);
  const failed = rows.filter((r) => !r.ok).map((r) => r.probe);
  // Both of the responses actually measured on the live endpoint must be caught...
  assert.ok(failed.some((p) => p.startsWith("eth_accounts")), "eth_accounts must fail against a node that answers it");
  assert.ok(failed.some((p) => p.startsWith("anvil_setBalance")), "the node's own -32602 must not read as a refusal");
  // ...and so must every other control method, because none of them were refused.
  assert.equal(failed.length, MUST_BE_REFUSED.length + 1, "every method probe must fail except the read that legitimately works");
});

test("isRefusal accepts only 403 + the gate's own code", () => {
  assert.equal(isRefusal({ status: 403, body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not available on this endpoint: eth_accounts" } }) }), true);
  // A node-side argument error is NOT a refusal: it means the method reached a node.
  assert.equal(isRefusal({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid length 0" } }) }), false);
  // A 403 with prose (an auth proxy, a WAF page) is not the gate either.
  assert.equal(isRefusal({ status: 403, body: "<html>forbidden</html>" }), false);
  // A partial refusal in a batch is not a refusal.
  assert.equal(isRefusal({ status: 403, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, error: { code: -32601 } }, { jsonrpc: "2.0", id: 2, result: "0x1" }]) }), false);
});
