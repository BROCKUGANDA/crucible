/**
 * @file workloads.ts — Workload run API (WP0-WP9 Fullstack).
 *
 * Mounted at /v1. Delegates to @crucible/eval adapters. Every write requires
 * SIWE session; tenant/run/score are server-resolved, never client-supplied.
 */

import { Hono } from "hono";
import {
  getAdapter,
  listAdapters,
  validateDataContract,
  checkRows,
  validateMandate,
  riskCheck,
  type WorkloadProfile,
  type RunContext,
} from "@crucible/eval";
import { verifiedSessionFromContext } from "./auth.js";
import { IdempotencyStore, parseIdempotencyKey } from "./idempotency.js";
// In-memory run registry (ADR-0008; PG migration 0003 provides durable tables).
type RunRecord = {
  runId: string;
  attemptId: string;
  tenantId: string;
  trialId: string;
  workloadProfile: WorkloadProfile;
  status: string;
  scorecard?: unknown;
  report?: unknown;
  createdAt: number;
  /** the verified session address that created the run; the only reader of the record */
  createdBy: string;
};
const runs = new Map<string, RunRecord>();
/** Creator-scoped Idempotency-Key -> runId; in-memory and restart-lossy (ADR-0008). */
const idempotency = new IdempotencyStore();
export function __resetRunsForTests(): void { runs.clear(); }
export function __seedRunForTests(record: RunRecord): void { runs.set(record.runId, record); }

function ctx(body: Record<string, unknown>, profile: WorkloadProfile): RunContext {
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    runId,
    attemptId: `att-${runId}`,
    tenantId: String(body.tenantId ?? "default"),
    trialId: String(body.trialId ?? "trial-1"),
    trialRevisionId: String(body.trialRevisionId ?? "rev-1"),
    workloadProfile: profile,
    environmentDigest: String(body.environmentDigest ?? "sha256:local"),
    deadlineAt: new Date(Date.now() + 600_000).toISOString(),
    idempotencyKey: runId,
    abortSignal: new AbortController().signal,
  };
}

export function createWorkloadRoutes(): Hono {
  const app = new Hono();

  app.get("/workloads", (c) => c.json({ workloads: listAdapters() }));

  // POST /v1/runs — create + validate + verify + score in one call.
  app.post("/runs", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    const creator = session.payload.address.toLowerCase();
    const { key: idempotencyKey, error: idempotencyError } = parseIdempotencyKey(
      c.req.header("idempotency-key") ?? null,
    );
    if (idempotencyError) return c.json({ error: idempotencyError, code: "bad-request" }, 400);
    // A retried POST used to create a second run; the key makes the retry answer with
    // the run it already created. Scoped to the creator, so a key is not transferable.
    if (idempotencyKey) {
      const priorRunId = idempotency.get(creator, idempotencyKey);
      const prior = priorRunId ? runs.get(priorRunId) : undefined;
      if (prior) {
        return c.json(
          { run: prior, report: prior.report, scorecard: prior.scorecard, replayed: true },
          200,
        );
      }
    }
    let body: Record<string, unknown> = {};
    try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid body" }, 400); }
    const profile = String(body.profile ?? "SOFTWARE_ENGINEERING") as WorkloadProfile;
    if (!["SOFTWARE_ENGINEERING", "STRUCTURED_DATA", "AUTONOMOUS_FINANCE"].includes(profile)) {
      return c.json({ error: "unknown workload profile", code: "bad-request" }, 400);
    }
    const adapter = getAdapter(profile);
    const runCtx = ctx(body, profile);

    // Validate task/contract/mandate.
    const validation = await adapter.validateTask(body.task ?? body);
    if (!validation.valid) return c.json({ error: "validation failed", details: validation.errors, code: "bad-request" }, 400);

    const prepared = await adapter.prepare((body.task ?? body) as never, runCtx);
    const executed = await adapter.execute(prepared, runCtx);
    const report = await adapter.verify(executed, runCtx);
    // Score with the adapter's own rubric.
    const rubric =
      profile === "SOFTWARE_ENGINEERING" ? { id: "engineering-regression", version: "v1", dimensions: [{ id: "acceptance_correctness", weight: 0.35 }] }
      : profile === "STRUCTURED_DATA" ? { id: "data-etl", version: "v1", dimensions: [{ id: "schema_correctness", weight: 0.2 }] }
      : { id: "autonomous-finance", version: "v1", dimensions: [{ id: "policy_compliance", weight: 0.25 }] };
    const scorecard = await adapter.score(report, rubric as never);

    const record: RunRecord = {
      runId: runCtx.runId, attemptId: runCtx.attemptId, tenantId: runCtx.tenantId,
      trialId: runCtx.trialId, workloadProfile: profile,
      status: report.status, report, scorecard, createdAt: Date.now(),
      createdBy: session.payload.address.toLowerCase(),
    };
    runs.set(runCtx.runId, record);
    if (idempotencyKey) idempotency.set(creator, idempotencyKey, runCtx.runId);
    return c.json({ run: record, report, scorecard }, 201);
  });

  app.get("/runs/:runId", (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    const r = runs.get(c.req.param("runId"));
    // A run record carries the creator's report and scorecard: 404 — not 403 —
    // for a stranger, so the ID confirms nothing about existence.
    if (!r || r.createdBy !== session.payload.address.toLowerCase()) {
      return c.json({ error: "run not found", code: "not-found" }, 404);
    }
    return c.json({ run: r });
  });

  // Data: validate rows against a contract (WP5-WP7).
  app.post("/data/validate", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    let body: { contract?: unknown; rows?: Record<string, unknown>[] } = {};
    try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "invalid body" }, 400); }
    const v = validateDataContract(body.contract);
    if (!v.valid) return c.json({ error: "contract invalid", details: v.errors }, 400);
    const checks = checkRows(body.contract as never, body.rows ?? []);
    return c.json({ checks, passed: checks.every((x) => x.passed) });
  });

  // Finance: risk-check a proposal against a mandate (WP8-WP9).
  app.post("/finance/risk-check", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    let body: { mandate?: unknown; proposal?: unknown; dailyNotionalSoFar?: number; positionPct?: number } = {};
    try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "invalid body" }, 400); }
    const v = validateMandate(body.mandate);
    if (!v.valid) return c.json({ error: "mandate invalid", details: v.errors }, 400);
    const checks = riskCheck(body.mandate as never, body.proposal as never, {
      dailyNotionalSoFar: body.dailyNotionalSoFar ?? 0,
      positionPct: body.positionPct ?? 0,
    });
    return c.json({ checks, allowed: checks.every((x) => x.passed) });
  });

  // Asset intelligence: canonical mint resolution (registered assets only).
  app.get("/assets/resolve", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    const mint = c.req.query("mint") ?? "";
    if (!mint) return c.json({ error: "mint required", code: "bad-request" }, 400);
    try {
      const { resolveMint } = await import("./assets/solana-registry.js");
      return c.json({ asset: await resolveMint(mint) });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "asset_not_registered") return c.json({ error: "asset_not_registered", code }, 404);
      return c.json({ error: (err as Error).message, code: "provider_error" }, 502);
    }
  });

  app.get("/assets/search", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    const q = c.req.query("q") ?? "";
    if (!q) return c.json({ error: "q required", code: "bad-request" }, 400);
    try {
      const { searchAssets } = await import("./assets/solana-registry.js");
      return c.json({ assets: await searchAssets(q) });
    } catch (err) {
      return c.json({ error: (err as Error).message, code: "provider_error" }, 502);
    }
  });

  return app;
}
