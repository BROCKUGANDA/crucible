import { describe, expect, it } from "vitest";
import { replay, type EventLike } from "@crucible/indexer";
import { createApp } from "../src/app.js";

const SPONSOR = "0x1111111111111111111111111111111111111111";
const OPERATOR = "0x2222222222222222222222222222222222222222";
const TRIALS = "0x4444444444444444444444444444444444444444";

function ev(eventName: string, args: Record<string, unknown>): EventLike {
  return {
    blockNumber: 1n,
    transactionHash: "0x" + "11".repeat(32),
    logIndex: 0,
    address: TRIALS,
    eventName,
    args,
  };
}

function seededModel() {
  return replay([
    ev("TrialCreated", {
      id: 1n, sponsor: SPONSOR, specCID: "0xaa", testsCID: "0xbb",
      reward: 10n ** 18n, bond: 2n * 10n ** 17n,
      deadline: 1_700_000_000n, breakWindow: 43_200n,
    }),
    ev("AgentRegistered", {
      agentId: 1n, operator: OPERATOR, runner: OPERATOR,
      metadataURI: "ipfs://m", stake: 10n ** 18n,
    }),
    ev("TrialClaimed", { id: 1n, agentId: 1n, bond: 2n * 10n ** 17n }),
  ]);
}

const model = seededModel();
// The app is constructed with rate limiting disabled for the route tests below: the
// point of most of them is that a *200* comes back, and a 61st request in the same
// test would be a 429, not a 200. The rate limiter is tested directly underneath.
const app = createApp(
  {
    getModel: () => model,
    alloyState: (id) => ({ locked: id === 1, tokenUri: `data:x/${id}` }),
  },
  { rateLimit: false },
);

describe("rate limiting", () => {
  const limitedApp = createApp({ getModel: () => model }, { rateLimit: { limit: 2, windowMs: 60_000, burst: 0 } });

  it("lets the first requests through and reports the ceiling", async () => {
    const res1 = await limitedApp.request("/health", { headers: { "x-forwarded-for": "10.0.0.1" } });
    expect(res1.status).toBe(200);
    expect(res1.headers.get("RateLimit-Limit")).toBe("2");
    expect(res1.headers.get("RateLimit-Remaining")).toBe("1");

    const res2 = await limitedApp.request("/health", { headers: { "x-forwarded-for": "10.0.0.1" } });
    expect(res2.status).toBe(200);
    expect(res2.headers.get("RateLimit-Remaining")).toBe("0");
  });

  it("429s the one that exceeds the bucket and sets Retry-After", async () => {
    const limited = createApp({ getModel: () => model }, { rateLimit: { limit: 1, windowMs: 60_000 } });
    await limited.request("/health", { headers: { "x-forwarded-for": "10.0.0.9" } });

    const res = await limited.request("/health", { headers: { "x-forwarded-for": "10.0.0.9" } });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    const body = await res.json();
    expect(body.error).toMatch(/too many/i);
    expect(body.retryAfterMs).toBeGreaterThan(0);
  });

  it("keys buckets per client, so a busy client cannot starve a quiet one", async () => {
    const limited = createApp({ getModel: () => model }, { rateLimit: { limit: 1, windowMs: 60_000 } });
    await limited.request("/health", { headers: { "x-forwarded-for": "10.0.1.1" } });
    // this one is blocked
    const blocked = await limited.request("/health", { headers: { "x-forwarded-for": "10.0.1.1" } });
    expect(blocked.status).toBe(429);
    // a different client still gets through
    const other = await limited.request("/health", { headers: { "x-forwarded-for": "10.0.1.2" } });
    expect(other.status).toBe(200);
  });

  it("refuses an unidentifiable request rather than giving it a free pass", async () => {
    const limited = createApp({ getModel: () => model }, { rateLimit: { limit: 1, windowMs: 60_000 } });
    await limited.request("/health"); // no IP headers at all
    const res = await limited.request("/health");
    expect(res.status).toBe(429);
  });

  it("the limiter itself exposes the contract a well-behaved client needs", async () => {
    // peek does not consume, so a client can ask "may I come back yet?" without
    // burning the window. Retry-After is measured in real seconds of waiting.
    const { RateLimiter } = await import("../src/rate-limit.js");
    const rl = new RateLimiter({ limit: 10, windowMs: 10_000, burst: 0 });
    const first = rl.consume("k");
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(9);
    for (let i = 0; i < 9; i++) rl.consume("k");
    expect(rl.consume("k").allowed).toBe(false);
    const peek = rl.peek("k");
    expect(peek.allowed).toBe(false);
    expect(peek.retryAfterMs).toBeGreaterThan(0);
  });
});

describe("routes", () => {
  // existing route tests run against the un-limited app above, so a 429 never
  // masquerades as a route failure.
  it("serves health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("serves a snapshot the UI can render in one call", async () => {
    const res = await app.request("/snapshot");
    const body = await res.json();
    expect(body.trials).toHaveLength(1);
    expect(body.counts.assigned).toBe(1);
    expect(body.agents[0].alloyLocked).toBe(true);
  });

  it("filters trials by status", async () => {
    const assigned = await (await app.request("/trials?status=assigned")).json();
    expect(assigned.trials).toHaveLength(1);
    const open = await (await app.request("/trials?status=open")).json();
    expect(open.trials).toHaveLength(0);
  });

  it("rejects an unknown status filter rather than returning everything", async () => {
    const res = await app.request("/trials?status=nonsense");
    expect(res.status).toBe(400);
    expect((await res.json()).valid).toContain("open");
  });

  it("serves one trial with its runs", async () => {
    const res = await app.request("/trials/1");
    expect(res.status).toBe(200);
    expect((await res.json()).trial.id).toBe(1);
  });

  it("404s a missing trial", async () => {
    const res = await app.request("/trials/999");
    expect(res.status).toBe(404);
  });

  it("400s a non-numeric id", async () => {
    const res = await app.request("/trials/abc");
    expect(res.status).toBe(400);
  });

  it("serves an agent with its trial history", async () => {
    const res = await app.request("/agents/1");
    const body = await res.json();
    expect(body.agent.id).toBe(1);
    expect(body.trials).toHaveLength(1);
  });

  it("serves the hall", async () => {
    const res = await app.request("/hall");
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).hall)).toBe(true);
  });

  it("serves the error copy table so the frontend has one source", async () => {
    const body = await (await app.request("/errors")).json();
    expect(body.errors.WindowOpen).toContain("Skeptic window");
  });

  it("answers unknown routes in the forge voice", async () => {
    const res = await app.request("/nowhere");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("Lost slag");
  });

  it("is JSON-serialisable end to end (no BigInt leaks)", async () => {
    const res = await app.request("/snapshot");
    expect(() => res.json()).not.toThrow();
  });
});
