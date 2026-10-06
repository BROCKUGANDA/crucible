import { Hono } from "hono";
import { cors } from "hono/cors";
import { ERROR_COPY } from "@crucible/smith";
import { buildSnapshot, type ApiSnapshot, type ReadModel, type TrialStatus } from "@crucible/indexer";
import { rateLimit } from "./rate-limit.js";

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
  /** alloy lock/token state, read live from the registry */
  alloyState?: (agentId: number) => { locked: boolean; tokenUri: string | null };
  /** sponsor-submitted CID text, which never reaches the chain */
  disclosure?: () => { trialId: number; specCID?: string; testsCID?: string }[];
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
  rateLimit?: { limit: number; windowMs: number; burst?: number } | false;
}

export function createApp(deps: ApiDeps, opts: ApiOptions = {}): Hono {
  const app = new Hono();

  app.use("*", cors());

  if (opts.rateLimit !== false) {
    app.use("*", rateLimit(opts.rateLimit ?? DEFAULT_RATE_LIMIT));
  }

  app.get("/health", (c) =>
    c.json({ ok: true, trials: deps.getModel().trials.size }),
  );

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

  app.get("/hall", (c) => {
    const snap = buildSnapshot(deps.getModel(), { now: Date.now() });
    return c.json({ hall: snap.hall });
  });

  /**
   * The contract-error copy table. The frontend fetches this rather than
   * duplicating it, so the error matrix has exactly one home.
   */
  app.get("/errors", (c) => c.json({ errors: ERROR_COPY }));

  app.notFound((c) => c.json({ error: "Lost slag. This page never left the crucible." }, 404));

  app.onError((err, c) => {
    console.error("[api]", err);
    return c.json(
      { error: "The crucible cracked.", detail: err.message },
      500,
    );
  });

  return app;
}
