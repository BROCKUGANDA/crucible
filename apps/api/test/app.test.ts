import { describe, expect, it } from "vitest";
import { replay, type EventLike } from "@crucible/indexer";
import { createApp } from "../src/app.js";

const SPONSOR = "0x1111111111111111111111111111111111111111";
const OPERATOR = "0x2222222222222222222222222222222222222222";
const TRIALS = "0x4444444444444444444444444444444444444444";

const PAID_TX = "0x" + "cd".repeat(32);
const IDENTITY_TX = "0x" + "ab".repeat(32);

function ev(
  eventName: string,
  args: Record<string, unknown>,
  blockNumber = 1n,
  transactionHash = "0x" + "11".repeat(32),
): EventLike {
  return { blockNumber, transactionHash, logIndex: 0, address: TRIALS, eventName, args };
}

function seededEvents(): EventLike[] {
  return [
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
  ];
}

function seededModel() {
  return replay(seededEvents());
}

/** A settled trial and a linked identity: the only model that has anything to prove. */
function hallModel() {
  return replay([
    ...seededEvents(),
    ev("RunSubmitted", { id: 1n, agentId: 1n, runHash: "0x" + "cc".repeat(32) }, 11n),
    ev("VerdictFinalized", { id: 1n, verdict: 1, agentPayout: 95n * 10n ** 16n }, 12n, PAID_TX),
    ev("IdentityLinked", { agentId: 1n, identityAgentId: 4242n }, 13n, IDENTITY_TX),
  ]);
}

const model = seededModel();
// The app is constructed with rate limiting disabled for the route tests below: the
// point of most of them is that a *200* comes back, and a 61st request in the same
// test would be a 429, not a 200. The rate limiter is tested directly underneath.
const app = createApp(
  {
    getModel: () => model,
    alloyState: (id) => ({ tier: id === 1 ? 1 : null, locked: id === 1, tokenUri: `data:x/${id}` }),
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

  it("keys buckets per client when it is told to trust the proxy", async () => {
    const opts = { rateLimit: { limit: 1, windowMs: 60_000, trustProxy: true } };
    const limited = createApp({ getModel: () => model }, opts);
    await limited.request("/health", { headers: { "x-forwarded-for": "10.0.1.1" } });
    // this one is blocked
    const blocked = await limited.request("/health", { headers: { "x-forwarded-for": "10.0.1.1" } });
    expect(blocked.status).toBe(429);
    // a different client still gets through
    const other = await limited.request("/health", { headers: { "x-forwarded-for": "10.0.1.2" } });
    expect(other.status).toBe(200);
  });

  /**
   * The bypass this closes: `X-Forwarded-For` is a header the caller writes. Honouring it
   * unconditionally meant a loop with one distinct value per request never met a bucket it
   * had not already refilled — the limiter was decoration.
   */
  it("does not let a spoofed X-Forwarded-For mint a fresh bucket", async () => {
    const limited = createApp({ getModel: () => model }, { rateLimit: { limit: 2, windowMs: 60_000 } });

    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await limited.request("/health", { headers: { "x-forwarded-for": `203.0.113.${i}` } });
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 200)).toHaveLength(2);
    expect(statuses.filter((s) => s === 429)).toHaveLength(6);
    expect(statuses.at(-1)).toBe(429);
  });

  it("does not let cf-connecting-ip mint a fresh bucket either, unless trusted", async () => {
    const limited = createApp({ getModel: () => model }, { rateLimit: { limit: 1, windowMs: 60_000 } });
    await limited.request("/health", { headers: { "cf-connecting-ip": "198.51.100.1" } });
    const spoofed = await limited.request("/health", { headers: { "cf-connecting-ip": "198.51.100.2" } });
    expect(spoofed.status).toBe(429);
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
    // Iron, because the registry said tier 1 — not because the indexer guessed one
    expect(body.agents[0].tier).toBe(1);
    expect(body.agents[0].tierName).toBe("Iron");
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

  it("serves the hall as proofs, each row naming the log behind it", async () => {
    const hallApp = createApp(
      {
        getModel: () => hallModel(),
        // tier 2, a value the read model does not hold and could not have derived from
        // `wins: 1`, so a row that renders Bronze is provably rendering the registry.
        alloyState: (id) => ({ tier: 2, locked: id === 1, tokenUri: `data:x/${id}` }),
        proofSource: { chain: "Foundry", chainId: 31337, trialsAddress: TRIALS },
      },
      { rateLimit: false },
    );

    const res = await hallApp.request("/hall");
    expect(res.status).toBe(200);
    const body = await res.json();

    // The envelope doctrine: facts in `data`, provenance in `meta`, no `success` flag —
    // the HTTP status is the success signal.
    expect(body.success).toBeUndefined();
    expect(body.hall).toBeUndefined();
    expect(body.data.hall).toHaveLength(1);

    const row = body.data.hall[0];
    expect(row.wins).toBe(1);
    expect(row.tier).toBe(2);
    expect(row.tierName).toBe("Bronze");
    expect(row.settlements[0].txHash).toBe(PAID_TX);
    expect(row.settlements[0].blockNumber).toBe(12);
    expect(row.settlements[0].verdict).toBe("paid");
    expect(row.settlements[0].payoutEth).toBe("0.95");
    expect(row.identity.txHash).toBe(IDENTITY_TX);
    expect(row.identity.identityAgentId).toBe("4242");
    // the emitter is CrucibleTrials; the event never carried a registry address
    expect(row.identity.emitter).toBe(TRIALS);
    // the hardcoded `alloyLocked: true` is gone: the route never read a registry
    expect(row.alloyLocked).toBeUndefined();

    expect(body.meta.readModel).toBe("scribe");
    expect(body.meta.chain).toBe("Foundry");
    expect(body.meta.chainId).toBe(31337);
    expect(body.meta.trialsAddress).toBe(TRIALS);
    expect(body.meta.alloyLock).toBe("registry");
    expect(body.meta.count).toBe(1);
    expect(typeof body.meta.asOf).toBe("number");
  });

  it("reports what it could not read instead of inventing it", async () => {
    // The shared app has an alloyState but no proofSource, so the chain fields must
    // come back null rather than as a guessed chain id.
    const res = await app.request("/hall");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.hall).toEqual([]);
    expect(body.meta.chain).toBeNull();
    expect(body.meta.chainId).toBeNull();
    expect(body.meta.trialsAddress).toBeNull();
    expect(body.meta.alloyLock).toBe("registry");
  });

  it("prints no tier for a hall row it never read from the registry", async () => {
    // The bug this covers: `/hall` rendered the indexer's frozen `tier: 0`, so an agent
    // the chain had already moved to Iron was published as "Unforged" — a wrong number
    // in the one place a leaderboard is supposed to be checkable. Without a registry
    // read the honest answer is null, and a null is not renderable as a tier name.
    const blind = createApp({ getModel: () => hallModel() }, { rateLimit: false });
    const body = await (await blind.request("/hall")).json();

    const row = body.data.hall[0];
    expect(row.wins).toBe(1);
    expect(row.settlements).toHaveLength(1);
    expect(row.tier).toBeNull();
    expect(row.tierName).toBeNull();
    expect(row.tierName).not.toBe("Unforged");
    expect(body.meta.alloyLock).toBe("not-read");

    const agents = await (await blind.request("/agents")).json();
    expect(agents.agents[0].tier).toBeNull();
    // the lock field used to be `agent.wins > 0`, which was never a chain read either
    expect(agents.agents[0].alloyLocked).toBeNull();
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

/**
 * The live stream's cost and its shutdown.
 *
 * `/stream` is one request that never ends, so the rate limiter in front of it cannot see
 * what it actually spends. Without these two assertions the route can rebuild the read model
 * once a second per subscriber and keep rebuilding after every subscriber has gone, and
 * every other test in this file still passes — which is precisely how both defects shipped.
 */
describe("/stream", () => {
  async function openStream(app: ReturnType<typeof createApp>, signal: AbortSignal) {
    const res = await app.request("http://localhost/stream", { signal });
    const reader = res.body?.getReader();
    // Wait for the first frame so the loop is genuinely running, not merely accepted.
    const first = await reader?.read();
    return { res, reader, first: new TextDecoder().decode(first?.value ?? new Uint8Array()) };
  }

  function appCountingReads() {
    const model = hallModel();
    let reads = 0;
    const app = createApp(
      {
        getModel: () => {
          reads += 1;
          return model;
        },
      },
      { rateLimit: false },
    );
    return { app, reads: () => reads };
  }

  it("pushes a full snapshot as the first frame", async () => {
    const { app } = appCountingReads();
    const ac = new AbortController();
    const { first } = await openStream(app, ac.signal);
    expect(first).toContain("event: snapshot");
    const payload = JSON.parse(first.split("data: ")[1].split("\n")[0]);
    expect(payload.hall[0].settlements[0].txHash).toBeTruthy();
    ac.abort();
  });

  it("rebuilds the read model once a tick, not once a tick per subscriber", async () => {
    const { app, reads } = appCountingReads();
    const controllers = [new AbortController(), new AbortController(), new AbortController()];

    await Promise.all(controllers.map((c) => openStream(app, c.signal)));
    const afterHandshake = reads();
    await new Promise((r) => setTimeout(r, 2_300));

    // Three subscribers over ~2 ticks. Per-subscriber rebuilding would put this at 6-9
    // above the handshake count; the shared tick keeps it to the number of ticks.
    const growth = reads() - afterHandshake;
    expect(growth).toBeLessThanOrEqual(4);
    controllers.forEach((c) => c.abort());
  });

  it("stops working when the subscriber goes away", async () => {
    const { app, reads } = appCountingReads();
    const ac = new AbortController();
    await openStream(app, ac.signal);
    ac.abort();

    const settled = reads();
    await new Promise((r) => setTimeout(r, 2_300));
    // A leaked loop ticks once a second for the full ten minutes after the peer is gone,
    // so the only correct answer here is that nothing further was read.
    expect(reads()).toBe(settled);
  });
});

/**
 * A health endpoint that answers `ok: true` for an index that stopped listening is the
 * reason a silently-empty leaderboard can run for an evening without anyone noticing.
 */
describe("/health", () => {
  it("reports 503 when the indexer refused to advance", async () => {
    const stalled = createApp(
      {
        getModel: () => model,
        indexStatus: () => ({
          head: 6n,
          indexedTo: 0n,
          syncError: "getLogs returned nothing for blocks 0–6 but a logsBloom there may contain a Crucible event",
        }),
      },
      { rateLimit: false },
    );
    const res = await stalled.request("/health");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.indexedTo).toBe(0);
    expect(body.head).toBe(6);
    expect(String(body.syncError)).toContain("logsBloom");
  });

  it("stays 200 while the index is moving", async () => {
    const fine = createApp(
      { getModel: () => model, indexStatus: () => ({ head: 42n, indexedTo: 42n, syncError: null }) },
      { rateLimit: false },
    );
    const res = await fine.request("/health");
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});
