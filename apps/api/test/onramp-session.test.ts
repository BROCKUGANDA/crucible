import { afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { emptyModel } from "@crucible/indexer";
import { createApp } from "../src/app.js";

const WALLET = "0x" + "ab".repeat(20);
const ONRAMP = "https://pay.coinbase.com/buy/select-asset?sessionToken=one";

let funder: http.Server | null = null;
let calls = 0;

async function fakeFunder(status = 200, body: unknown = { ok: true, url: ONRAMP }) {
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/onramp/session") calls += 1;
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => {
      funder = server;
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

afterAll(async () => {
  if (funder) await new Promise<void>((resolve) => funder!.close(() => resolve()));
});

describe("onramp session proxy", () => {
  it("mints a fresh no-store URL on every call", async () => {
    calls = 0;
    const f = await fakeFunder();
    try {
      const app = createApp(
        { getModel: () => emptyModel(), funderUrl: f.url },
        { rateLimit: false },
      );
      for (let i = 0; i < 2; i++) {
        const res = await app.request("/onramp/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ wallet: WALLET }),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const body = await res.json();
        expect(body).toEqual({ ok: true, url: ONRAMP });
      }
      expect(calls).toBe(2);
    } finally {
      await f.close();
      funder = null;
    }
  });

  it("refuses a malformed wallet before asking the funder", async () => {
    calls = 0;
    const f = await fakeFunder();
    try {
      const app = createApp({ getModel: () => emptyModel(), funderUrl: f.url }, { rateLimit: false });
      const res = await app.request("/onramp/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: "nope" }),
      });
      expect(res.status).toBe(400);
      expect(calls).toBe(0);
    } finally {
      await f.close();
      funder = null;
    }
  });

  it("says unconfigured when no funder is present", async () => {
    const app = createApp({ getModel: () => emptyModel() }, { rateLimit: false });
    const res = await app.request("/onramp/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: WALLET }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).configured).toBe(false);
  });

  it("does not relay a non-Coinbase URL from the funder", async () => {
    const f = await fakeFunder(200, { ok: true, url: "https://evil.example/buy" });
    try {
      const app = createApp({ getModel: () => emptyModel(), funderUrl: f.url }, { rateLimit: false });
      const res = await app.request("/onramp/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: WALLET }),
      });
      expect(res.status).toBe(502);
    } finally {
      await f.close();
      funder = null;
    }
  });
});
