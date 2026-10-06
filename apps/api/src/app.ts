import { Hono } from "hono";
import { cors } from "hono/cors";
import { ERROR_COPY } from "@crucible/smith";
import {
  buildSnapshot,
  type AlloyState,
  type ApiSnapshot,
  type ReadModel,
  type ScribeStatus,
  type TrialStatus,
} from "@crucible/indexer";
import { rateLimit } from "./rate-limit.js";
import { streamSSE } from "hono/streaming";

/**
 * The REST surface, built as a pure function over a read-model getter so it can be
 * tested without a chain, a database, or a running process.
 *
 * Nothing here can move money. Every route is a read. State changes go through the
 * contracts directly from the wallet, because an API that can submit transactions
 * is an API that needs to be trusted with keys.
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
}

const VALID_STATUSES: TrialStatus[] = ["open", "assigned", "judging", "challenged", "settled"];

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
}

export function createApp(deps: ApiDeps, opts: ApiOptions = {}): Hono {
  const app = new Hono();

  const TICK_MS = 1000;

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
  let tick: { builtAt: number; signature: string; payload: string } | null = null;

  function sharedTick(): { signature: string; payload: string } {
    const now = Date.now();
    if (!tick || now - tick.builtAt >= TICK_MS) {
      const snap = buildSnapshot(deps.getModel(), { now, alloyState: deps.alloyState });
      tick = {
        builtAt: now,
        signature: `${snap.counts.open}:${snap.counts.assigned}:${snap.counts.judging}:${snap.counts.challenged}:${snap.counts.settled}:${snap.trials.length}`,
        payload: JSON.stringify(snap),
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
    } catch {
      return false;
    }
  }

  app.use("*", cors());

  // One id per request, reflected in responses and logs, so a report can name the exact
  // request the client saw. Deterministic for the process via crypto.randomUUID.
  app.use("*", async (c, next) => {
    const id = crypto.randomUUID();
    c.header("X-Request-Id", id);
    (c.var as Record<string, unknown>).requestId = id;
    await next();
  });

  if (opts.rateLimit !== false) {
    const limits: { limit: number; windowMs: number; burst?: number; trustProxy?: boolean } =
      opts.rateLimit ?? DEFAULT_RATE_LIMIT;
    app.use("*", rateLimit({ ...limits, trustProxy: limits.trustProxy ?? opts.trustProxy ?? false }));
  }

  app.get("/health", (c) => {
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
        syncError: index?.syncError ?? null,
      },
      stalled ? 503 : 200,
    );
  });

  /** One payload the whole UI can render from. */
  app.get("/snapshot", (c) => {
    const disclosure = deps.disclosure?.() ?? [];
    const snap = buildSnapshot(deps.getModel(), {
      now: Date.now(),
      alloyState: deps.alloyState,
    });
    // disclosure is applied by the indexer on ingest; surface the flag per trial
    return c.json(snap satisfies ApiSnapshot);
  });

  app.get("/trials", (c) => {
    const status = c.req.query("status");
    const snap = buildSnapshot(deps.getModel(), { now: Date.now() });
    if (!status) return c.json({ trials: snap.trials, counts: snap.counts });
    if (!VALID_STATUSES.includes(status as TrialStatus)) {
      return c.json(
        { error: `unknown status "${status}"`, valid: VALID_STATUSES },
        400,
      );
    }
    return c.json({
      trials: snap.trials.filter((t) => t.status === status),
      counts: snap.counts,
    });
  });

  app.get("/trials/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) {
      return c.json({ error: "trial id must be a positive integer" }, 400);
    }
    const snap = buildSnapshot(deps.getModel(), { now: Date.now() });
    const trial = snap.trials.find((t) => t.id === id);
    if (!trial) return c.json({ error: `trial ${id} not found` }, 404);
    const runs = [...deps.getModel().runs.values()]
      .filter((r) => r.trialId === id)
      .map((r) => ({
        trialId: r.trialId,
        agentId: r.agentId,
        runHash: r.runHash,
        submittedAt: r.submittedAt,
        artifactCID: r.artifactCID,
        // The signature is published: it is public data that lets anyone re-verify.
        signature: r.signature,
      }));
    return c.json({ trial, runs });
  });

  app.get("/agents", (c) => {
    const snap = buildSnapshot(deps.getModel(), {
      now: Date.now(),
      alloyState: deps.alloyState,
    });
    return c.json({ agents: snap.agents });
  });

  app.get("/agents/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) {
      return c.json({ error: "agent id must be a positive integer" }, 400);
    }
    const model = deps.getModel();
    const snap = buildSnapshot(model, { now: Date.now(), alloyState: deps.alloyState });
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
    const snap = buildSnapshot(deps.getModel(), {
      now: Date.now(),
      alloyState: deps.alloyState,
    });
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
   * Two properties this route has to hold, and did not:
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
   */
  app.get("/stream", (c) => {
    // hono only attaches its own abort listener to `c.req.raw.signal` on old Bun
    // (helper/streaming/stream.js), so on @hono/node-server `stream.onAbort` never fires when
    // a browser closes the tab. The request signal is what actually moves: `@hono/node-server`
    // aborts it when the peer disconnects, and it is the same signal a test can control.
    const signal = c.req.raw.signal;

    return streamSSE(c, async (stream) => {
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
    });
  });

  app.notFound((c) => c.json({ error: "Lost slag. This page never left the crucible." }, 404));

  app.onError((err, c) => {
    console.error("[api]", err);
    const requestId = c.res.headers.get("X-Request-Id");
    return c.json(
      { error: "The crucible cracked.", detail: err.message, requestId },
      500,
    );
  });

  return app;
}
