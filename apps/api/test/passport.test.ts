import { describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createPassportSource } from "../src/passport.js";

const WALLET = "0x" + "ab".repeat(20);

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("the Passport source", () => {
  it("says unconfigured without making a call when no URL is set", async () => {
    const out = await createPassportSource(null)(WALLET);
    expect(out.configured).toBe(false);
    expect(out.available).toBe(false);
    expect(out.reason).toMatch(/Passport/);
  });

  it("maps an eligible credential and keeps unknown fields null", async () => {
    let seen = "";
    const server = await listen((req, res) => {
      seen = req.url ?? "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ eligible: true, method: "passport", score: 25, threshold: 20, sanctioned: false }));
    });
    try {
      const out = await createPassportSource(server.url)(WALLET);
      expect(seen).toBe(`/eligibility/${WALLET}`);
      expect(out).toEqual({
        configured: true,
        available: true,
        eligible: true,
        method: "passport",
        score: 25,
        threshold: 20,
        sanctioned: false,
        reason: null,
      });
    } finally {
      await server.close();
    }
  });

  it("reports a sanctions match as its own fact", async () => {
    const server = await listen((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ eligible: false, sanctioned: true, reason: "sanctions match" }));
    });
    try {
      const out = await createPassportSource(server.url)(WALLET);
      expect(out.available).toBe(true);
      expect(out.eligible).toBe(false);
      expect(out.sanctioned).toBe(true);
      expect(out.score).toBeNull();
      expect(out.reason).toBe("sanctions match");
    } finally {
      await server.close();
    }
  });

  it("an upstream error is unavailable, not an ineligible wallet", async () => {
    const server = await listen((_req, res) => {
      res.statusCode = 503;
      res.end("down");
    });
    try {
      const out = await createPassportSource(server.url)(WALLET);
      expect(out.configured).toBe(true);
      expect(out.available).toBe(false);
      expect(out.eligible).toBeNull();
      expect(out.reason).toContain("503");
    } finally {
      await server.close();
    }
  });

  it("a timeout is unavailable and names the deadline", async () => {
    const server = await listen(() => {
      // Never answer. The client's deadline is the only way out.
    });
    try {
      const out = await createPassportSource(server.url, { timeoutMs: 25 })(WALLET);
      expect(out.configured).toBe(true);
      expect(out.available).toBe(false);
      expect(out.reason).toMatch(/timed out after 25ms/);
    } finally {
      await server.close();
    }
  });

  it("refuses a body that is not an object", async () => {
    const server = await listen((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end("null");
    });
    try {
      const out = await createPassportSource(server.url)(WALLET);
      expect(out.available).toBe(false);
      expect(out.reason).toMatch(/no usable body/);
    } finally {
      await server.close();
    }
  });

  it("never asks the source about a malformed wallet", async () => {
    let called = false;
    const server = await listen((_req, res) => {
      called = true;
      res.end("{}");
    });
    try {
      const out = await createPassportSource(server.url)("nope");
      expect(called).toBe(false);
      expect(out.available).toBe(false);
    } finally {
      await server.close();
    }
  });
});
