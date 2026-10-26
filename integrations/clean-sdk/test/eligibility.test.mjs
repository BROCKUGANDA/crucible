import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createEligibilitySource } from "../src/eligibility.mjs";
import { createServer } from "../src/server.mjs";

const WALLET = "0x" + "ab".repeat(20);
const OTHER = "0x" + "cd".repeat(20);

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

function sourceFor(url) {
  return createEligibilitySource({
    apiUrl: url,
    // Deliberately unreachable: this route must not need an L1 node.
    l1RpcUrl: "http://127.0.0.1:1",
    domain: "localhost",
  });
}

test("reads eligibility through the SDK and maps the Passport fields", async () => {
  let seen = "";
  const upstream = await listen((req, res) => {
    seen = req.url ?? "";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      address: WALLET,
      eligible: true,
      method: "passport",
      passportScore: 25,
      passportThreshold: 20,
      passportMaxAmount: "100000000",
    }));
  });
  try {
    const out = await sourceFor(upstream.url).check(WALLET);
    assert.equal(seen, `/api/attestation/l1-eligibility?address=${WALLET}`);
    assert.deepEqual(out, {
      address: WALLET,
      eligible: true,
      method: "passport",
      score: 25,
      threshold: 20,
      maxAmount: "100000000",
      sanctioned: false,
      reason: null,
    });
  } finally {
    await upstream.close();
  }
});

test("caches a successful reading and reuses it for a checksummed spelling", async () => {
  let calls = 0;
  const upstream = await listen((_req, res) => {
    calls += 1;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ address: WALLET, eligible: true, method: "passport", passportScore: 25, passportThreshold: 20 }));
  });
  try {
    const source = sourceFor(upstream.url);
    const first = await source.check(WALLET);
    const second = await source.check("0x" + "AB".repeat(20));
    assert.equal(calls, 1, "the second check must be served from the cache");
    assert.deepEqual(second, first);
  } finally {
    await upstream.close();
  }
});

test("the cache expires after its TTL", async () => {
  let calls = 0;
  let clock = 0;
  const upstream = await listen((_req, res) => {
    calls += 1;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ address: WALLET, eligible: true }));
  });
  try {
    const source = createEligibilitySource({
      apiUrl: upstream.url,
      l1RpcUrl: "http://127.0.0.1:1",
      domain: "localhost",
      ttlMs: 1000,
      now: () => clock,
    });
    await source.check(WALLET);
    clock = 1001;
    await source.check(WALLET);
    assert.equal(calls, 2, "a check after the TTL must reach the vendor again");
  } finally {
    await upstream.close();
  }
});

test("concurrent checks for one address share one in-flight call", async () => {
  let calls = 0;
  const upstream = await listen((_req, res) => {
    calls += 1;
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ address: WALLET, eligible: true }));
    }, 50);
  });
  try {
    const source = sourceFor(upstream.url);
    const [a, b] = await Promise.all([source.check(WALLET), source.check(WALLET)]);
    assert.equal(calls, 1, "two concurrent requests must not double the vendor load");
    assert.deepEqual(a, b);
  } finally {
    await upstream.close();
  }
});

test("a transport failure is not cached", async () => {
  let calls = 0;
  const upstream = await listen((_req, res) => {
    calls += 1;
    if (calls === 1) {
      res.statusCode = 503;
      res.end("down");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ address: WALLET, eligible: true }));
  });
  try {
    const source = sourceFor(upstream.url);
    await assert.rejects(() => source.check(WALLET));
    const second = await source.check(WALLET);
    assert.equal(calls, 2, "a failed call must be retried, not remembered as a result");
    assert.equal(second.eligible, true);
  } finally {
    await upstream.close();
  }
});

test("carries a sanctions match as its own fact", async () => {
  const upstream = await listen((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ address: WALLET, eligible: false, method: null, sanctioned: true, reason: "sanctions match" }));
  });
  try {
    const out = await sourceFor(upstream.url).check(WALLET);
    assert.equal(out.eligible, false);
    assert.equal(out.sanctioned, true);
    assert.equal(out.reason, "sanctions match");
    assert.equal(out.score, null, "a score the vendor did not send must stay unknown");
  } finally {
    await upstream.close();
  }
});

test("refuses an answer about a different address", async () => {
  const upstream = await listen((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ address: OTHER, eligible: true }));
  });
  try {
    await assert.rejects(() => sourceFor(upstream.url).check(WALLET), /answered for .*not/);
  } finally {
    await upstream.close();
  }
});

test("bounds a vendor that never answers", async () => {
  const upstream = await listen(() => {
    // Never answer. The adapter's own deadline is the only way out.
  });
  try {
    const source = createEligibilitySource({
      apiUrl: upstream.url,
      l1RpcUrl: "http://127.0.0.1:1",
      domain: "localhost",
      timeoutMs: 25,
    });
    await assert.rejects(() => source.check(WALLET), /timed out after 25ms/);
  } finally {
    await upstream.close();
  }
});

test("an upstream failure is an error, not an ineligible wallet", async () => {
  const upstream = await listen((_req, res) => {
    res.statusCode = 503;
    res.end("down");
  });
  try {
    await assert.rejects(() => sourceFor(upstream.url).check(WALLET));
  } finally {
    await upstream.close();
  }
});

test("the sidecar serves the normalized shape and rejects a malformed wallet", async () => {
  const upstream = await listen((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ address: WALLET, eligible: true, method: "poch" }));
  });
  const server = createServer(sourceFor(upstream.url), { logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).check, "l1-eligibility");

    const good = await fetch(`http://127.0.0.1:${port}/eligibility/${WALLET}`);
    assert.equal(good.status, 200);
    assert.deepEqual(await good.json(), {
      address: WALLET,
      eligible: true,
      method: "poch",
      score: null,
      threshold: null,
      maxAmount: null,
      sanctioned: false,
      reason: null,
    });

    const bad = await fetch(`http://127.0.0.1:${port}/eligibility/nope`);
    assert.equal(bad.status, 400);
  } finally {
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
    await upstream.close();
  }
});
