import { Hono, type Context } from "hono";
import { ERROR_COPY, type BreakerStatus } from "@crucible/smith";
import {
  buildSnapshot,
  type AlloyState,
  type ApiSnapshot,
  type ReadModel,
  type ScribeStatus,
  type TrialStatus,
} from "@crucible/indexer";
import { rateLimit } from "./rate-limit.js";
import { dlq } from "./dlq.js";
import { authRoutes } from "./auth.js";
import { createVoiceRoutes, type VoiceConfig } from "./voice.js";
import {
  bodyLimit,
  corsPolicy,
  enforceHttps,
  requestTimeout,
  resolveSecurity,
  securityHeaders,
  type SecurityConfig,
} from "./security.js";
import { streamSSE } from "hono/streaming";

/**
 * The REST surface, built as a pure function over a read-model getter so it can be
 * tested without a chain, a database, or a running process.
 *
 * Nothing here can move on-chain money. State changes go through the contracts
 * directly from the wallet, because an API that can submit transactions is an API
 * that needs to be trusted with chain keys. The optional voice proxy is the one
 * route that spends something — a text-to-speech credit — and it is a closed set of
 * fixed moments with its own tighter bucket, not a general-purpose synthesizer.
 */

export interface ApiDeps {
  getModel: () => ReadModel;
  /**
   * Alloy facts for one agent — tier, soulbound lock, token URI — sourced from
   * `AlloyRegistry`. Kept synchronous so a snapshot build cannot await the chain: the
   * host reads the registry on its own clock and hands this a cached answer, or
   * `UNKNOWN_ALLOY` when it has none.
   */
  alloyState?: (agentId: number) => AlloyState;
  /** sponsor-submitted CID text, which never reaches the chain */
  disclosure?: () => { trialId: number; specCID?: string; testsCID?: string }[];
  /**
   * What the hall's tx proofs are against. A transactionHash only means something on
   * one chain and in one contract's logs, and the read model is chain-agnostic — it
   * cannot infer either. The host that knows them supplies them; anything it does not
   * supply is reported as null rather than guessed, because a proof with an invented
   * chain is worse than no proof.
   */
  proofSource?: { chain: string; chainId: number; trialsAddress: string };
  /**
   * How far the index actually reaches, and why it may have stopped. Supplied by the host
   * process because the read model itself cannot know — it is a Map, and an empty Map looks
   * identical whether the chain is quiet or the indexer refused to read it.
   */
  indexStatus?: () => ScribeStatus;
  /**
   * Snapshot of every circuit breaker this process depends on, keyed by breaker name. The
   * host owns them because they sit on its hops, not on the read model's; `/health` reports
   * them as data and reads nothing into them — an open breaker is a degraded dependency, and
   * the HTTP code stays the index's verdict.
   */
  breakers?: () => Record<string, BreakerStatus>;
  /**
   * The chain's settlement fee, in basis points.
   *
   * The contract keeps a fee for the treasury on every settlement, and nothing
   * published it — so the platform's revenue was a number in a constant that
   * nobody could see. The host reads it from the contract, because the number
   * the snapshot shows has to be the number the chain charges.
   *
   * Null when the host could not read it, which is a different answer from zero:
   * zero says the protocol charges nothing.
   */
  protocolFeeBps?: () => number | null;
}

const VALID_STATUSES = ["open", "assigned", "judging", "challenged", "settled"] as const satisfies readonly TrialStatus[];

/**
 * The same list as a set, for a membership test.
 *
 * `VALID_STATUSES.includes(status)` on a literal tuple needs a cast, because `status` is a
 * `string` and the tuple holds five literals. A `Set<string>` asks the question the route
 * actually asks — "is this one of the five?" — without narrowing the argument to something
 * it is not.
 */
const VALID_STATUS_SET: ReadonlySet<string> = new Set<string>(VALID_STATUSES);

/**
 * A path parameter that must be a positive whole number.
 *
 * `Number(param)` accepts more than a number: `"0x10"` is 16, `"1e3"` is 1000, `" 1 "` is 1,
 * and a 21-digit integer passes `Number.isInteger` while losing precision. None of those
 * is a trial id, and a route that answers a request for trial `0x10` with trial 16 is a
 * route that is not reading what it was asked for.
 */
function positiveId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return null;
  return value;
}

/**
 * How many live streams this process will hold at once.
 *
 * Each one is a socket open for up to ten minutes and a timer on the shared event loop.
 * The rate limiter cannot see them — it counts requests, and a stream is one request — so
 * the ceiling is what stops a client from opening connections in a loop for free.
 *
 * 200 is far above what a real audience needs (a browser tab, a phone, a watch) and far
 * below what the process can carry. Past it, a stream is refused with a 503 and a
 * `Retry-After`, which is a queue the client can back off from rather than a wall.
 */
const MAX_OPEN_STREAMS = 200;

/**
 * The default ceiling. 60/min per IP with a small burst is enough for a real UI to
 * poll `/snapshot` every few seconds, and far too much for a loop. Overridable per app
 * so tests and the demo can move it, because a test that cannot make requests is not a
 * test.
 */
const DEFAULT_RATE_LIMIT = { limit: 60, windowMs: 60_000, burst: 20 } as const;

export interface ApiOptions {
  rateLimit?: { limit: number; windowMs: number; burst?: number; trustProxy?: boolean } | false;
  /**
   * Honour `X-Forwarded-For` / `cf-connecting-ip` when identifying a client. Off unless set,
   * including for the default limits — those headers are caller-writable, so trusting them
   * by default would let one loop mint a fresh bucket per request.
   */
  trustProxy?: boolean;
  /**
   * How many live `/stream` connections this process holds at once.
   *
   * The rate limiter counts requests and a stream is one request that then holds a socket
   * open, so the limiter cannot see how many are open. This is the ceiling that does.
   * Lower it to refuse streams sooner; the default is far above what a real audience needs.
   */
  maxStreams?: number;
  /**
   * Transport-layer policy: browser origins, response headers, body ceiling, request
   * timeout, plaintext. Explicit values here beat `ALLOWED_ORIGINS` and friends in the
   * environment, which beat `DEFAULT_SECURITY`. See `security.ts` for what each buys and
   * what it does not.
   */
  security?: Partial<SecurityConfig>;
  /**
   * Frenchy. Null or absent means the voice host is off and `/voice/status` says so;
   * the rest of the app is unchanged.
   */
  voice?: VoiceConfig | null;
  /**
   * The voice route spends a provider credit per call, so it gets its own bucket
   * rather than sharing the 60/min read allowance. `false` disables it for tests.
   */
  voiceRateLimit?: { limit: number; windowMs: number; burst?: number } | false;
}

/**
 * Fold the options that belong to both subsystems.
 *
 * `trustProxy` is a single assertion — "something in front of this process overwrites the
 * forwarded headers" — and it has to be the same assertion in the rate limiter and in the
 * TLS detector. Two independent flags would let a deployment believe `X-Forwarded-For` while
 * refusing `X-Forwarded-Proto`, or the reverse, and the second one is how a plaintext request
 * mints an HSTS pinning header for a hostname.
 */
function securityOverrides(opts: ApiOptions): Partial<SecurityConfig> {
  const overrides: Partial<SecurityConfig> = { ...opts.security };
  if (overrides.trustProxy === undefined && opts.trustProxy !== undefined) {
    overrides.trustProxy = opts.trustProxy;
  }
  return overrides;
}

export function createApp(deps: ApiDeps, opts: ApiOptions = {}): Hono {
  const app = new Hono();

  const TICK_MS = 1000;
  /** Ceiling on how long a cached stream payload may go without a fresh `now`. */
  const MAX_TICK_AGE_MS = 30_000;
  /** Live streams currently open, against `MAX_OPEN_STREAMS`. */
  let openStreams = 0;
  /** The ceiling, overridable so a deployment (and a test) can move it. */
  const maxStreams = opts.maxStreams ?? MAX_OPEN_STREAMS;

  /**
   * The snapshot every stream subscriber is served from, rebuilt at most once a tick for
   * the whole process.
   *
   * The read model is shared and the payload is identical for every client, so per-subscriber
   * rebuilding is CPU spent proving the same fact N times. `signature` is what a subscriber
   * compares against its own last write; `payload` is serialised once for the same reason.
   * `alloyState` is included because this is the payload the UI actually renders — leaving it
   * out made the live view disagree with a refresh, the same defect that lived on `/hall`.
   */
  let tick: { builtAt: number; version: number; signature: string; payload: string; snapshot: ApiSnapshot } | null = null;

  function sharedTick(): { signature: string; payload: string; snapshot: ApiSnapshot } {
    const now = Date.now();
    // Read the model exactly once per tick. Asking twice would make the cheap path cost
    // the same as the expensive one, and the difference is the entire point of the gate.
    const model = deps.getModel();
    const version = model.version;
    // Rebuild when the read model moved. The version counter is the right trigger because
    // it does not move for a duplicate log — so a reorg that re-applies a settled verdict
    // invalidates nothing, exactly as it changes no counter.
    //
    // `MAX_TICK_AGE_MS` is a safety valve, not a feature: the payload's only remaining
    // clock-dependent field is `now`, and the client re-anchors and counts locally between
    // snapshots, so a stale one is harmless today. It stops being harmless the moment
    // somebody adds a second derived timestamp, and a periodic refresh is cheaper than
    // discovering that.
    if (!tick || version !== tick.version || now - tick.builtAt >= MAX_TICK_AGE_MS) {
      const snap = buildSnapshot(model, {
        now,
        alloyState: deps.alloyState,
        feeBps: deps.protocolFeeBps?.() ?? null,
      });
      tick = {
        builtAt: now,
        version,
        // The signature is what decides whether a subscriber gets a new frame,
        // so it has to name everything the payload can change. It used to be
        // the trial counts and the length: a registry tier that moved, or a
        // settlement fee that changed, did not move it, so no frame was sent
        // and the live view showed a stale tier indefinitely while a refresh
        // showed the new one — the exact disagreement this cache was built to
        // end.
        signature: [
          snap.counts.open,
          snap.counts.assigned,
          snap.counts.judging,
          snap.counts.challenged,
          snap.counts.settled,
          snap.trials.length,
          snap.economics.feesEth,
          snap.economics.paidOutEth,
          snap.agents.map((a) => `${a.id}:${a.tier ?? "?"}`).join(","),
        ].join(":"),
        payload: JSON.stringify(snap),
        snapshot: snap,
      };
    }
    return tick;
  }

  /**
   * One SSE frame, reported as success or failure.
   *
   * hono's `write()` swallows a broken pipe, so a thrown error is not how a dead peer shows
   * up — but the frames still stop being deliverable. Returning false is the caller's signal
   * to end the loop instead of ticking on into a socket nobody is reading.
   */
  async function write(stream: { writeSSE: (f: { event: string; data: string }) => Promise<void> }, frame: { event: string; data: string }): Promise<boolean> {
    try {
      await stream.writeSSE(frame);
      return true;
    } catch (err) {
      // A client that vanishes mid-stream is routine; a pattern of them is not. The
      // DLQ turns "the stream felt flaky" into a count an operator can alert on.
      dlq.push("sse", err instanceof Error ? err.message : "frame delivery failed");
      return false;
    }
  }

  /**
   * Order is the whole design, so it is written down once.
   *
   *   request id -> security headers -> CORS -> plaintext gate -> rate limit -> body
   *   ceiling -> timeout -> routes
   *
   * The id is outermost because a report has to be able to name a request that was refused
   * before it reached a route. The headers are next because a 403, a 429 and a 500 are
   * responses too — and because they are set *before* the handler runs, they also survive
   * the error handler, which lives outside this chain entirely. CORS before the gates so a
   * refusal is still legible to the browser that asked. Rate limit before body limit: a
   * client already over budget should not get a second middleware to spend time on.
   */
  const security = resolveSecurity(securityOverrides(opts), process.env);

  // One id per request, reflected in responses and logs, so a report can name the exact
  // request the client saw. Deterministic for the process via crypto.randomUUID.
  app.use("*", async (c, next) => {
    const id = crypto.randomUUID();
    c.header("X-Request-Id", id);
    (c.var as Record<string, unknown>).requestId = id;
    await next();
  });

  app.use("*", securityHeaders(security));
  app.use("*", corsPolicy(security));
  if (security.enforceHttps) app.use("*", enforceHttps(security));

  if (opts.rateLimit !== false) {
    const limits: { limit: number; windowMs: number; burst?: number; trustProxy?: boolean } =
      opts.rateLimit ?? DEFAULT_RATE_LIMIT;
    // Built ONCE. `rateLimit()` closes over the bucket store, so calling it per
    // request would mint a fresh bucket for every request and limit nothing.
    const limiter = rateLimit({
      ...limits,
      trustProxy: limits.trustProxy ?? opts.trustProxy ?? false,
    });
    app.use("*", async (c, next) => {
      // The live stream is EXEMPT.
      //
      // The limiter exists to stop one client looping on `/snapshot` from
      // starving the event loop the indexer shares. A stream is the opposite of
      // that: it is one request that then holds a socket open, and it pushes
      // frames rather than asking for work. Charging it against a per-minute
      // request budget means a handful of idle tabs — each holding a stream
      // and polling the fallback — exhaust the bucket for everything else,
      // and the reads that matter start returning 429 to real visitors.
      //
      // The exemption is by path, not by method or by header, so it cannot be
      // reached by asking for a stream-shaped URL on a read route.
      if (c.req.path === "/stream") {
        await next();
        return;
      }
      return limiter(c, next);
    });
  }

  app.use("*", bodyLimit(security));
  app.use("*", requestTimeout(security));

  /**
   * Sign-In with Ethereum, mounted as a closed sub-app. Ported from the merged
   * Scaffold-ETH 2 build; it holds no chain keys and cannot move money, and it
   * answers 503 unless `AUTH_SECRET` is configured rather than signing sessions
   * with a known default. See `auth.ts` for the idempotency properties the port
   * was made to keep.
   */
  app.route("/auth", authRoutes(security.maxBodyBytes));

  /**
   * The voice host. `/voice/status` is a cheap read; `/voice/speak` is the only
   * route that spends money, so it has a bucket of its own on top of the global one.
   */
  if (opts.voiceRateLimit !== false) {
    const voiceLimiter = rateLimit({
      limit: 8,
      windowMs: 60_000,
      burst: 2,
      trustProxy: opts.trustProxy ?? false,
      ...opts.voiceRateLimit,
    });
    app.use("/voice/*", voiceLimiter);
  }
  app.route("/voice", createVoiceRoutes(opts.voice ?? null));

  /**
   * Liveness, plus the reach of the index. `/ready` is the gate a balancer acts on; this is
   * the sentence an operator reads.
   */
  const health = (c: Context) => {
    const index = deps.indexStatus?.() ?? null;
    const stalled = index?.syncError != null;
    return c.json(
      {
        ok: !stalled,
        trials: deps.getModel().trials.size,
        // `ok: true` with an empty index is the report that hides an outage. These three
        // fields are what tells a quiet chain apart from an indexer that stopped listening,
        // and they are only honest because Scribe refuses to advance across a window it
        // could not confirm was empty.
        indexedTo: index ? Number(index.indexedTo) : null,
        head: index?.head === null || index?.head === undefined ? null : Number(index.head),
        // The indexer's own error is safe to publish: it is written by this
        // process, about blocks and blooms, and it is the sentence an operator
        // needs. The dead letter's last detail is NOT: it carries whatever a
        // third-party error said, and a viem error carries the RPC URL — which
        // on a provider with a key in it hands the key to whoever provoked the
        // error. The detail is still on disk and still in the log.
        syncError: index?.syncError ?? null,
        // Failures the process survived — failed syncs, failed registry reads, SSE
        // frames a dead client refused. A size that only grows is an operator's alarm.
        dlq: { ...dlq.summary(), lastDetail: null },
        // The same sentence for the dependencies this process calls: which ones are tripped,
        // how many failures it took, and how long before a probe is allowed through. Reported
        // as data, never as a status — an open breaker is why the index above stopped moving.
        breakers: deps.breakers?.() ?? {},
      },
      stalled ? 503 : 200,
    );
  };
  app.get("/health", health);
  app.get("/healthz", health);

  /**
   * Readiness, which is not health.
   *
   * `/health` answers "this process is up, and here is how far the index reaches" — the
   * sentence a human reads when something looks wrong. `/ready` answers the only question a
   * load balancer can act on: "if I route traffic here, does the caller get a complete read
   * model *now*?" It fails closed on the three things health merely reports: no index status
   * supplied, the last tick failed, and the cursor further behind the head than the
   * tolerance allows.
   *
   * The distinction has teeth. An instance whose first `sync()` has not landed is alive,
   * answers `/health` 200 with `indexedTo: 0`, and would render an empty Hall of Alloy to the
   * first visitor — the exact outage the index-reach fields were added to make visible.
   * Readiness is where something other than a human can act on it.
   */
  const readiness = (c: Context) => {
    const index = deps.indexStatus?.() ?? null;
    const trials = deps.getModel().trials.size;

    if (!index) {
      return c.json(
        {
          ready: false,
          reason: "the host supplied no index status; cannot claim the read model is complete",
          trials,
        },
        503,
      );
    }

    const head = index.head === null || index.head === undefined ? null : Number(index.head);
    const indexedTo = Number(index.indexedTo);
    const lag = head === null ? null : Math.max(0, head - indexedTo);

    const reasons: string[] = [];
    if (index.syncError) reasons.push(`last sync tick failed: ${index.syncError}`);
    if (head === null) reasons.push("the chain head has never been read");
    else if (lag !== null && lag > security.readyMaxLag) {
      reasons.push(`index is ${lag} blocks behind the head, tolerance is ${security.readyMaxLag}`);
    }

    const ready = reasons.length === 0;
    return c.json(
      {
        ready,
        reason: ready ? null : reasons.join("; "),
        head,
        indexedTo,
        lag,
        maxLag: security.readyMaxLag,
        syncError: index.syncError ?? null,
        trials,
      },
      ready ? 200 : 503,
    );
  };
  app.get("/ready", readiness);
  app.get("/readyz", readiness);

  /** One payload the whole UI can render from. */
  app.get("/snapshot", (c) => {
    // The same cached payload the stream serves. Every route used to build its own
    // snapshot, and they drifted: the stream carried the registry tier and the
    // settlement fee while `/snapshot` carried neither, so a refresh and a live
    // update could describe the same chain differently. One build per tick, one
    // payload, no disagreement.
    return c.json(sharedTick().snapshot satisfies ApiSnapshot);
  });

  app.get("/trials", (c) => {
    const status = c.req.query("status");
    const snap = sharedTick().snapshot;
    if (!status) return c.json({ trials: snap.trials, counts: snap.counts });
    if (!VALID_STATUS_SET.has(status)) {
      return c.json(
        { error: `unknown status "${status}"`, valid: [...VALID_STATUSES] },
        400,
      );
    }
    return c.json({
      trials: snap.trials.filter((t) => t.status === status),
      counts: snap.counts,
    });
  });

  app.get("/trials/:id", (c) => {
    const id = positiveId(c.req.param("id"));
    if (id === null) {
      return c.json({ error: "trial id must be a positive integer" }, 400);
    }
    const snap = sharedTick().snapshot;
    const trial = snap.trials.find((t) => t.id === id);
    if (!trial) return c.json({ error: `trial ${id} not found` }, 404);
    // The map is walked, not copied. `[...runs.values()]` allocated one array of every
    // run on the chain for each hit on this route, and then threw most of it away.
    const runs: {
      trialId: number;
      agentId: number;
      runHash: string;
      submittedAt: number;
      artifactCID: string | null;
      signature: string | null;
    }[] = [];
    for (const r of deps.getModel().runs.values()) {
      if (r.trialId !== id) continue;
      runs.push({
        trialId: r.trialId,
        agentId: r.agentId,
        runHash: r.runHash,
        submittedAt: r.submittedAt,
        artifactCID: r.artifactCID,
        // The signature is published: it is public data that lets anyone re-verify.
        signature: r.signature,
      });
    }
    return c.json({ trial, runs });
  });

  app.get("/agents", (c) => {
    return c.json({ agents: sharedTick().snapshot.agents });
  });

  app.get("/agents/:id", (c) => {
    const id = positiveId(c.req.param("id"));
    if (id === null) {
      return c.json({ error: "agent id must be a positive integer" }, 400);
    }
    const snap = sharedTick().snapshot;
    const agent = snap.agents.find((a) => a.id === id);
    if (!agent) return c.json({ error: `agent ${id} not found` }, 404);
    const trials = snap.trials.filter((t) => t.agentId === id);
    return c.json({ agent, trials });
  });

  /**
   * The Hall of Alloy, as proofs rather than claims.
   *
   * Each row carries the `VerdictFinalized` log that paid for a win (or slashed for a
   * scar) and the `IdentityLinked` log that binds the agent to an ERC-8004 identity, so
   * a reader can re-fetch the log and check the arithmetic instead of trusting this
   * server. `meta` names what those hashes are against; a null there means nobody told
   * this process, and the caller should not assume the proof is verifiable.
   *
   * `alloyState` is passed here as it is on `/snapshot` and `/agents`: the hall used to
   * build its snapshot without it, so the three routes reported different things about
   * the same agent — and the hall papered over the gap with a hardcoded `alloyLocked`.
   */
  app.get("/hall", (c) => {
    const snap = sharedTick().snapshot;
    return c.json({
      data: { hall: snap.hall },
      meta: {
        readModel: "scribe",
        chain: deps.proofSource?.chain ?? null,
        chainId: deps.proofSource?.chainId ?? null,
        trialsAddress: deps.proofSource?.trialsAddress ?? null,
        // Whether the alloy state on `agents` and the tier on these rows came from a
        // registry read at all. Naming the source is honest; naming it when nobody looked
        // would not be. "registry" means the host was asked — a row can still carry a null
        // tier when that read failed or had not landed yet, and null is not tier 0.
        alloyLock: deps.alloyState ? "registry" : "not-read",
        count: snap.hall.length,
        asOf: snap.now,
      },
    });
  });

  /**
   * The contract-error copy table. The frontend fetches this rather than
   * duplicating it, so the error matrix has exactly one home.
   */
  app.get("/errors", (c) => c.json({ errors: ERROR_COPY }));

  /**
   * Live updates, without polling.
   *
   * One event per indexer tick: the first is the full snapshot (so a fresh subscriber is
   * rendered immediately), then a snapshot only when the read model has actually moved, with
   * a heartbeat every HEARTBEAT_MS to keep proxies from buffering a quiet socket.
   *
   * Three properties this route has to hold, and did not:
   *
   *   * the read model is rebuilt at most once per tick for the whole process, not once per
   *     tick per subscriber. Ten open tabs used to mean sixty `buildSnapshot` calls a minute
   *     for a chain that changed none.
   *   * an abandoned subscriber stops. `@hono/node-server` does not abort the callback when
   *     the peer goes away, and hono's own `write()` swallows the broken-pipe error, so a
   *     refresh left a loop running for the full `maxMs`. A demo audience that refreshes is
   *     dozens of leaked loops starving the one event loop everything else shares — the
   *     exact failure the rate limiter above was written to prevent, walking back in
   *     through the route the limiter cannot see, because a stream is one request.
   *   * the number of open streams has a ceiling. The rate limiter cannot count them —
   *     it counts requests, and a stream is one request that then holds a socket open
   *     for ten minutes — so a client that opened connections in a loop paid nothing and
   *     left a timer per connection running on the event loop the indexer shares. The
   *     exemption from the limiter made this route cheap to open and unlimited in number;
   *     a ceiling is what makes the exemption safe.
   */
  app.get("/stream", (c) => {
    if (openStreams >= maxStreams) {
      // A refused stream is a normal outcome, not a failure worth a DLQ entry: the
      // client is asking for something the server is busy with.
      c.header("Retry-After", "5");
      return c.json({ error: "too many live streams", maxStreams }, 503);
    }
    openStreams += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      openStreams -= 1;
    };

    // hono only attaches its own abort listener to `c.req.raw.signal` on old Bun
    // (helper/streaming/stream.js), so on @hono/node-server `stream.onAbort` never fires when
    // a browser closes the tab. The request signal is what actually moves: `@hono/node-server`
    // aborts it when the peer disconnects, and it is the same signal a test can control.
    const signal = c.req.raw.signal;

    try {
      return streamSSE(c, async (stream) => {
        try {
          const HEARTBEAT_MS = 15_000;
          const maxMs = 10 * 60 * 1000;
          const started = Date.now();

          let running = !signal.aborted;
          signal.addEventListener(
            "abort",
            () => {
              running = false;
            },
            { once: true },
          );
          stream.onAbort(() => {
            running = false;
          });

          let lastSignature = "";
          let lastWriteAt = 0;

          while (running && Date.now() - started < maxMs) {
            const { signature, payload } = sharedTick();

            if (signature !== lastSignature) {
              lastSignature = signature;
              if (!(await write(stream, { event: "snapshot", data: payload }))) return;
              lastWriteAt = Date.now();
            } else if (Date.now() - lastWriteAt >= HEARTBEAT_MS) {
              if (!(await write(stream, { event: "heartbeat", data: "{}" }))) return;
              lastWriteAt = Date.now();
            }

            await new Promise((r) => setTimeout(r, TICK_MS));
            // Checked the moment the sleep lands: a subscriber that left during the wait must
            // not get one more rebuild, so the shutdown is immediate rather than one tick late.
            if (!running) return;
          }
        } finally {
          // The slot is released however the stream ended: a clean end, an aborted
          // peer, a write that failed. A counter that only decrements on the happy
          // path is a counter that reaches the ceiling and never comes back down.
          release();
        }
      });
    } catch (err) {
      // `streamSSE` builds the response before the callback can release the slot.
      release();
      throw err;
    }
  });

  app.notFound((c) => c.json({ error: "Lost slag. This page never left the crucible." }, 404));

  app.onError((err, c) => {
    console.error("[api]", err);
    const requestId = c.res.headers.get("X-Request-Id");
    // The message goes to the log, not to the caller. A viem error carries
    // the RPC URL — which, on a provider with a key in it, hands the key to
    // whoever provoked the error — and a stack trace is an invitation.
    console.error(`[api] request ${requestId} failed:`, err);
    return c.json(
      {
        error: "The crucible cracked.",
        detail: process.env.NODE_ENV === "production" ? undefined : err.message,
        requestId,
      },
      500,
    );
  });

  return app;
}
