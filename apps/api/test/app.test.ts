import { describe, expect, it } from "vitest";
import { replay, type EventLike } from "@crucible/indexer";
import { CircuitBreaker } from "@crucible/smith";
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

  it("does not charge the live stream against the request budget", async () => {
    // A stream is one request that then holds a socket open. Charging it
    // against a per-minute request budget meant a handful of idle tabs —
    // each holding a stream and polling the fallback — exhausted the bucket
    // and every real read started answering 429.
    const limited = createApp({ getModel: () => model }, { rateLimit: { limit: 1, windowMs: 60_000 } });
    const headers = { "x-forwarded-for": "10.0.0.42" };

    await limited.request("/health", headers);
    // The bucket is spent. A read is refused…
    expect((await limited.request("/health", headers)).status).toBe(429);
    // …but the stream is not, because it is not a request flood.
    const stream = await limited.request("/stream", headers);
    expect(stream.status).toBe(200);
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
   * `X-Real-IP` is not evidence of anything, and reading it is how the limiter used to
   * be escaped.
   *
   * The code used to read `X-Real-IP` FIRST, on the belief that "Caddy overwrites it
   * with the peer it actually saw". Caddy does not: its documented defaults are
   * `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`, and "By default,
   * Caddy passes through incoming headers—including Host—to the backend without
   * modifications". So a client that sent `X-Real-IP` had that value delivered to the
   * API untouched, and one header on the request bought a fresh 60/min allowance.
   *
   * The header is not read at all now, so varying it cannot move the bucket.
   */
  it("does not let a forged X-Real-IP mint a fresh bucket", async () => {
    const limited = createApp(
      { getModel: () => model },
      { rateLimit: { limit: 1, windowMs: 60_000, trustProxy: true } },
    );

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await limited.request("/health", {
        // The same proxy-recorded client, a different forged header on every request.
        headers: { "x-forwarded-for": "10.0.9.9", "x-real-ip": `203.0.113.${i}` },
      });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(3);
  });

  /**
   * The proxy that sets the header, which is the one this stack has.
   *
   * Caddy does not append to `X-Forwarded-For` — "by default, the proxy will ignore
   * their values from incoming requests, to prevent spoofing" — it REPLACES the header
   * with the peer it saw. So the value this process reads is the proxy's own record of
   * the client, and a caller cannot have written it.
   */
  it("keys on the address the proxy recorded, not the one the caller wrote", async () => {
    const limited = createApp(
      { getModel: () => model },
      { rateLimit: { limit: 1, windowMs: 60_000, trustProxy: true } },
    );

    // What the API sees after Caddy replaced the header: one address, every time.
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await limited.request("/health", {
        headers: { "x-forwarded-for": "198.51.100.7" },
      });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(3);
  });

  /**
   * A proxy that APPENDS to `X-Forwarded-For` puts the real client at the
   * right-hand end and leaves the caller's own value at the left. Reading the
   * left-most entry — which is what the code did — meant a client chose its
   * own bucket, one per request, and the limiter was decoration.
   */
  it("reads the right-most hop, not the one the caller wrote", async () => {
    const limited = createApp(
      { getModel: () => model },
      { rateLimit: { limit: 1, windowMs: 60_000, trustProxy: true } },
    );

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await limited.request("/health", {
        headers: { "x-forwarded-for": `203.0.113.${i}, 10.0.8.8` },
      });
      statuses.push(res.status);
    }
    // Every request had a different LEFT-most entry and the same right-most
    // one, so they all land in the same bucket.
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(3);
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

  it("serves the /healthz alias with the same body", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("serves readiness at /readyz", async () => {
    const readyApp = createApp(
      {
        getModel: () => model,
        indexStatus: () => ({ head: 42n, indexedTo: 42n, syncError: null }),
      },
      { rateLimit: false },
    );
    const res = await readyApp.request("/readyz");
    expect(res.status).toBe(200);
    expect((await res.json()).ready).toBe(true);
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

  it("tells the same story on every route about the same chain", async () => {
    // The bug this covers: every route built its own snapshot, and they drifted.
    // The live stream carried the registry tier and the settlement fee while
    // `/snapshot` carried neither — so a refresh and a live update described the
    // same chain differently, and the published books read zero on a protocol
    // that was taking five percent. One payload, served everywhere.
    const feeApp = createApp(
      {
        getModel: () => hallModel(),
        alloyState: (id) => ({ tier: 2, locked: id === 1, tokenUri: `data:x/${id}` }),
        proofSource: { chain: "Foundry", chainId: 31337, trialsAddress: TRIALS },
        protocolFeeBps: () => 500,
      },
      { rateLimit: false },
    );

    const snapshot = await (await feeApp.request("/snapshot")).json();
    const hall = await (await feeApp.request("/hall")).json();
    const agents = await (await feeApp.request("/agents")).json();

    // The books carry the chain's own fee, not a copy this process keeps.
    expect(snapshot.economics.feeBps).toBe(500);
    expect(snapshot.economics.feesEth).toBe("0.05");
    expect(snapshot.economics.paidOutEth).toBe("0.95");
    expect(snapshot.economics.paidSettlements).toBe(1);

    // The tier the registry reported is the tier every route reports.
    expect(snapshot.agents[0].tier).toBe(2);
    expect(agents.agents[0].tier).toBe(2);
    expect(hall.data.hall[0].tier).toBe(2);
  });

  /**
   * A fee the host could not read is published as unknown, not as zero.
   *
   * The books used to be derived from `FEE_BPS`, so a failed read of that constant
   * published a fee of "0" ETH and a payout of the FULL reward — a number the chain
   * never charged, presented as though it had been measured. The settled amounts now
   * come from the settlement logs, so they are exact either way, and the rate is
   * reported as what it is: unread.
   */
  it("publishes an unread protocol fee as unknown rather than as zero", async () => {
    const feeApp = createApp(
      {
        getModel: () => hallModel(),
        protocolFeeBps: () => null,
      },
      { rateLimit: false },
    );

    const snapshot = await (await feeApp.request("/snapshot")).json();
    expect(snapshot.economics.feeBps).toBeNull();
    // The money is exact anyway: it came from the chain's own settlement log.
    expect(snapshot.economics.feesEth).toBe("0.05");
    expect(snapshot.economics.paidOutEth).toBe("0.95");
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

  /**
   * Rebuilds counted through `alloyState`, not by watching `getModel`. Building a snapshot
   * calls the host once per agent, so it observes the expensive work directly — and
   * `getModel` now has to run every tick just to read the version, so a call counter there
   * would measure the cheap path and pass on a regression.
   */
  function appCountingRebuilds() {
    const model = hallModel();
    let rebuilds = 0;
    const app = createApp(
      {
        getModel: () => model,
        alloyState: (id) => {
          rebuilds += 1;
          return { tier: id === 1 ? 1 : null, locked: id === 1, tokenUri: null };
        },
      },
      { rateLimit: false },
    );
    return { app, model, rebuilds: () => rebuilds };
  }

  /**
   * Three open streams on an idle chain must cost what one costs. The previous shape
   * rebuilt the read model once a second *per subscriber*, so ten tabs was sixty rebuilds a
   * minute for a chain that had not moved — and the rate limiter could not see it, because a
   * stream is one request.
   */
  it("shares one rebuild across every subscriber", async () => {
    const { app, rebuilds } = appCountingRebuilds();
    const controllers = [new AbortController(), new AbortController(), new AbortController()];

    await Promise.all(controllers.map((c) => openStream(app, c.signal)));
    const afterHandshake = rebuilds();

    await new Promise((r) => setTimeout(r, 2_500));
    expect(rebuilds() - afterHandshake).toBe(0);
    controllers.forEach((c) => c.abort());
  });

  /**
   * The version counter is what makes an idle chain free. It also must not move for a
   * duplicate log — the replay guards reject one without changing a counter, so a reorg
   * invalidates nothing.
   */
  it("does not rebuild while the read model is idle, and does when it moves", async () => {
    const { app, model, rebuilds } = appCountingRebuilds();
    const ac = new AbortController();
    await openStream(app, ac.signal);
    const idle = rebuilds();

    await new Promise((r) => setTimeout(r, 2_500));
    expect(rebuilds()).toBe(idle);

    model.version += 1;
    await new Promise((r) => setTimeout(r, 2_500));
    expect(rebuilds()).toBeGreaterThan(idle);
    ac.abort();
  }, 20_000);

  /**
   * A subscriber is pushed to only when content changed. A version bump that altered nothing
   * visible must not emit — otherwise the gate just moves the waste from CPU to the wire.
   *
   * Frames are drained sequentially rather than raced against a timer. A `reader.read()`
   * that loses a race is still pending, and it will quietly consume the next frame — so the
   * assertion that follows it times out looking like a product bug when the stream actually
   * delivered.
   */
  /**
   * A subscriber is pushed to when content changes.
   *
   * Over a real socket rather than `app.request()`. The in-process `ReadableStream` hono
   * builds for a synthetic Request surfaces only its first chunk to a reader, so asserting a
   * second frame there tests the harness rather than the route — it failed while the same
   * sequence through `@hono/node-server` delivered the update within a tick.
   */
  it("pushes an update to a connected subscriber over a real socket", async () => {
    const { serve } = await import("@hono/node-server");
    const { app, model } = appCountingRebuilds();
    const port = 8899;
    const server = await new Promise<ReturnType<typeof serve>>((res) => {
      const s = serve({ fetch: app.fetch, port }, () => res(s));
    });

    try {
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/stream`, { signal: ac.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      const grab = (ms: number) =>
        Promise.race([
          reader.read().then((r) => dec.decode(r.value)),
          new Promise<string>((r) => setTimeout(() => r("<none>"), ms)),
        ]);

      const first = await grab(4_000);
      expect(first).toContain("event: snapshot");
      expect(first).not.toContain('"id":2');

      model.trials.set(2, { ...model.trials.get(1)!, id: 2 });
      model.version += 1;

      const next = await grab(5_000);
      expect(next).toContain("event: snapshot");
      expect(next).toContain('"id":2');
      ac.abort();
    } finally {
      server.close();
    }
  }, 30_000);

  /**
   * The load shape a demo actually sees: everyone in the room on the stream at once.
   *
   * Forty real sockets through `@hono/node-server`, because the in-process
   * `app.request()` stream only surfaces its first chunk and cannot answer the
   * question this test exists for. Three properties, each one a way fan-out
   * quietly broke before:
   *
   *   - every handshake completes — a connection accepted but never framed is a
   *     spectator staring at a loading state;
   *   - an idle audience costs nothing — rebuilds stay flat while all forty sit
   *     there, because the tick is shared, not per-viewer;
   *   - one chain move reaches all forty — counted per client, so a client that
   *     silently lost its loop is caught instead of averaged away.
   */
  it("holds forty concurrent subscribers: one shared tick, every client served", async () => {
    const { serve } = await import("@hono/node-server");
    const { app, model, rebuilds } = appCountingRebuilds();
    const port = 8898;
    const server = await new Promise<ReturnType<typeof serve>>((res) => {
      const s = serve({ fetch: app.fetch, port }, () => res(s));
    });

    try {
      const CLIENTS = 40;
      const controllers = Array.from({ length: CLIENTS }, () => new AbortController());
      const dec = new TextDecoder();

      // Handshake: every client must receive its first snapshot frame.
      const handshakes = await Promise.all(
        controllers.map(async (ac) => {
          const res = await fetch(`http://127.0.0.1:${port}/stream`, { signal: ac.signal });
          const reader = res.body!.getReader();
          const first = dec.decode((await reader.read()).value);
          return { reader, first };
        }),
      );
      for (const h of handshakes) {
        expect(h.first).toContain("event: snapshot");
      }

      // Idle audience: two full seconds with all forty connected must not add a
      // single read-model rebuild.
      const idleAt = rebuilds();
      await new Promise((r) => setTimeout(r, 2_000));
      expect(rebuilds()).toBe(idleAt);

      // One chain move: every client gets the update, within a bound that is
      // generous for CI timing but still proves liveness under load.
      model.trials.set(2, { ...model.trials.get(1)!, id: 2 });
      model.version += 1;
      const updates = await Promise.all(
        handshakes.map(async ({ reader }) =>
          Promise.race([
            reader.read().then((r) => dec.decode(r.value)),
            new Promise<string>((res2) => setTimeout(() => res2("<timeout>"), 8_000)),
          ]),
        ),
      );
      const served = updates.filter((u) => u.includes('"id":2')).length;
      expect(served, "every one of the forty received the move").toBe(CLIENTS);

      controllers.forEach((ac) => ac.abort());
    } finally {
      server.close();
    }
  }, 30_000);

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

  /**
   * The number of open streams has a ceiling.
   *
   * The rate limiter cannot count them — it counts requests, and a stream is ONE request
   * that then holds a socket open for ten minutes — so a client that opened connections
   * in a loop paid nothing and left a timer per connection on the event loop the indexer
   * shares. The exemption from the limiter made this route cheap to open and unlimited
   * in number.
   */
  it("refuses a stream past the ceiling and lets it go again when one closes", async () => {
    const model = hallModel();
    const app = createApp({ getModel: () => model }, { rateLimit: false, maxStreams: 1 });

    const first = new AbortController();
    await openStream(app, first.signal);

    // The second connection is refused, and the refusal says what to do about it.
    const refused = await app.request("http://localhost/stream");
    expect(refused.status).toBe(503);
    expect(refused.headers.get("Retry-After")).toBeTruthy();
    const body = await refused.json();
    expect(body.error).toMatch(/too many/i);

    // A closed stream gives its slot back: a counter that only decrements on the happy
    // path reaches the ceiling and never comes down. The loop notices the abort when its
    // one-second tick lands, so the slot comes back within a tick — not instantly.
    first.abort();
    await new Promise((r) => setTimeout(r, 1_500));

    const third = new AbortController();
    const reopened = await openStream(app, third.signal);
    expect(reopened.res.status).toBe(200);
    third.abort();
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
          // A refused advance is a FAILED read, which is what /health is allowed to call stalled;
          // a lagging cursor that is still ticking is not, and no longer reports 503.
          syncStalled: true,
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

  /**
   * A tripped dependency is *why* the index above stopped moving, so it is reported beside the
   * DLQ rather than left in a log line: state, the failures that got there, and the cooldown
   * left before a probe is let through. Data, never a status — the index still owns the code.
   */
  it("reports every circuit breaker the process runs on", async () => {
    const guard = new CircuitBreaker({ name: "scribe.rpc", threshold: 1, cooldownMs: 60_000 });
    const withBreaker = createApp(
      {
        getModel: () => model,
        indexStatus: () => ({ head: 42n, indexedTo: 42n, syncError: null }),
        breakers: () => ({ [guard.name]: guard.status() }),
      },
      { rateLimit: false },
    );

    const closed = (await (await withBreaker.request("/health")).json()).breakers;
    expect(closed["scribe.rpc"].state).toBe("closed");
    expect(closed["scribe.rpc"].failures).toBe(0);

    await expect(
      guard.exec(async () => {
        throw new Error("connection refused");
      }),
    ).rejects.toThrow("connection refused");

    const body = await (await withBreaker.request("/health")).json();
    expect(body.breakers["scribe.rpc"].state).toBe("open");
    expect(body.breakers["scribe.rpc"].failures).toBe(1);
    expect(body.breakers["scribe.rpc"].retryAfterMs).toBeGreaterThan(0);
    expect(body.ok).toBe(true);
  });

  it("reports an empty breaker set when the host wires none", async () => {
    expect((await (await app.request("/health")).json()).breakers).toEqual({});
  });
});

/**
 * The list routes are pageable, and the default is not to page.
 *
 * A silent cap would be the worse half of this feature: a monitor that counts trials
 * reading a truncated page would report a shorter chain as a healthy one. So the default
 * returns everything, `limit` is opt-in, and when there genuinely is more the response says
 * so with `truncated` and a `nextCursor` that is an id rather than an offset.
 */
describe("pagination", () => {
  async function get(url: string): Promise<{ status: number; body: any }> {
    const res = await app.request(`http://localhost${url}`);
    return { status: res.status, body: await res.json() };
  }

  it("returns the whole list and says there is nothing held back", async () => {
    const { body } = await get("/trials");
    const all = body.trials.length;
    expect(body.page.total).toBe(all);
    expect(body.page.truncated).toBe(false);
    expect(body.page.nextCursor).toBeNull();
  });

  /**
   * A model with three trials, on its own app.
   *
   * The shared fixture holds a single trial, and paging one item proves nothing about
   * cursors. Mutating the shared model to add rows would leak into every other test in this
   * file, so this builds a private one instead.
   */
  function threeTrialApp() {
    const m = seededModel();
    const base = [...m.trials.values()][0]!;
    m.trials.set(base.id + 1, { ...base, id: base.id + 1 });
    m.trials.set(base.id + 2, { ...base, id: base.id + 2 });
    m.version += 1;
    return createApp({ getModel: () => m }, { rateLimit: false });
  }

  it("pages by id and the second page continues without overlap", async () => {
    const paged = await threeTrialApp().request("http://localhost/trials?limit=2");
    const first = await paged.json();
    expect(first.trials).toHaveLength(2);
    expect(first.page.truncated).toBe(true);
    expect(first.page.total).toBe(3);
    // Ids descend, so the cursor is the smaller of the two it just returned.
    expect(first.page.nextCursor).toBe(first.trials[1].id);

    const next = await (
      await threeTrialApp().request(`http://localhost/trials?limit=2&after=${first.page.nextCursor}`)
    ).json();
    expect(next.trials).toHaveLength(1);
    expect(next.trials[0].id).toBe(first.trials[1].id - 1);
    expect(next.page.truncated).toBe(false);
    expect(next.page.nextCursor).toBeNull();

    const ids = [...first.trials.map((t: { id: number }) => t.id), ...next.trials.map((t: { id: number }) => t.id)];
    expect(new Set(ids).size, "a page boundary repeated or dropped a trial").toBe(3);
  });

  it("refuses a limit that is not a bounded whole number", async () => {
    for (const bad of ["0", "-1", "abc", "1.5", "99999"]) {
      const { status, body } = await get(`/trials?limit=${bad}`);
      expect(status, `limit=${bad} was accepted`).toBe(400);
      expect(body.error).toMatch(/limit/);
    }
  });

  it("keeps a status filter and a page together, and totals the filtered set", async () => {
    const full = await get("/trials");
    const open = (full.body.trials as { status: string }[]).filter((t) => t.status === "open");
    const { body } = await get("/trials?status=open&limit=1");
    expect(body.counts).toBeTruthy();
    expect(body.page.total).toBe(open.length);
  });

  it("starts over rather than failing when a cursor has aged out of the list", async () => {
    const { body } = await get("/trials?limit=1&after=999999");
    // An id that is no longer here is not the client's fault — a filtered list loses
    // members as the chain settles trials. Say so, and hand back page one.
    expect(body.page.cursorStale).toBe(true);
    expect(body.trials.length).toBeGreaterThan(0);
  });

  it("pages the agent list the same way", async () => {
    const all = (await get("/agents")).body.agents as { id: number }[];
    const { body } = await get("/agents?limit=1");
    expect(body.agents.length).toBeLessThanOrEqual(1);
    expect(body.page.total).toBe(all.length);
  });
});

/**
 * The chain clock.
 *
 * `now` is this process's wall clock, and every deadline in the payload is a claim about
 * `block.timestamp`. On a demo chain that is warped deliberately the two disagree, and a browser
 * holding only `now` cannot tell a window that closed from one the node still holds open. The
 * index reads block bodies already, so it can say what time the chain thinks it is for no extra
 * cost — and when it has not read one, that has to arrive as unknown rather than as 1970.
 */
describe("the chain clock in the payload", () => {
  it("publishes the head timestamp the index actually read", async () => {
    const withChain = createApp(
      {
        getModel: () => model,
        indexStatus: () => ({
          head: 42n,
          indexedTo: 42n,
          syncError: null,
          syncStalled: false,
          partialTrials: 0,
          headTimestamp: 1_792_638_015,
        }),
      },
      { rateLimit: false },
    );
    const body = await (await withChain.request("/snapshot")).json();
    expect(body.headTimestamp).toBe(1_792_638_015);
    // Both clocks travel: they answer different questions and must not be confused downstream.
    expect(typeof body.now).toBe("number");
  });

  it("publishes an unread chain clock as unknown, never as the epoch", async () => {
    const bare = createApp({ getModel: () => model }, { rateLimit: false });
    const body = await (await bare.request("/snapshot")).json();
    expect(body.headTimestamp).toBeNull();
    // A zero here would be 1970, and a client anchoring on it would report every window closed.
    expect(body.headTimestamp).not.toBe(0);
  });
});

describe("identity routes", () => {
  const alloy = () => ({
    tier: 1,
    locked: true,
    tokenUri: null,
    epoch: null,
    epochStartedAt: null,
    lifetimeWins: null,
    lifetimeSlashes: null,
    holder: null,
  });
  const identityApp = createApp(
    { getModel: () => hallModel(), alloyState: () => alloy() },
    { rateLimit: false },
  );

  it("serves the evidence behind a score and names Passport as unconfigured", async () => {
    const res = await identityApp.request(`/identity/evidence/${OPERATOR}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // A missing source must be declared. Silence would read as "checked and neutral".
    expect(body.sources.passport.configured).toBe(false);
    expect(body.sources.passport.reason).toMatch(/Passport/);
    expect(body.evidence.map((e: { name: string }) => e.name)).toContain("identityLinked");
    expect(typeof body.pUniqueHuman).toBe("number");
    expect(body.chainNow).toBeNull(); // no block read on this harness: unknown, not 1970
  });

  it("still answers the score route the same way", async () => {
    const res = await identityApp.request(`/identity/risk/${OPERATOR}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.score.wallet).toBe(OPERATOR);
    expect(body.decision.action).toBeTruthy();
  });

  it("rejects a malformed wallet on both routes", async () => {
    expect((await identityApp.request("/identity/evidence/nope")).status).toBe(400);
    expect((await identityApp.request("/identity/risk/nope")).status).toBe(400);
  });
});
