/**
 * @file workloads.ts — Workload run API (WP0-WP9).
 *
 * Mounted at `/v1`. Delegates to `@crucible/eval` adapters. Every write requires
 * a SIWE session; tenant, run id and score are server-resolved, never
 * client-supplied.
 *
 * The one rule this file exists to enforce: **a caller may not report its own
 * verdict.** A submitter supplies the task and the attempt; the evidence comes
 * from the runner, through `deps.evidence`. With no evidence seam wired, the run
 * is recorded as `EVIDENCE_INCOMPLETE` with a `null` score — the honest answer,
 * and never a pass and never a zero.
 *
 * POST bodies may carry `evidence` only when the host explicitly allows
 * self-reported evidence (`allowClientEvidence`, default off, and refused in
 * production). That switch exists for the demo and local runs; it is not a
 * production path, and saying so in one place beats scattering the decision.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import {
  checkCompatibility,
  checkRows,
  getAdapter,
  listAdapters,
  preExecutionVerdict,
  validateDataContract,
  validateMandate,
  previewContract,
  canonicalIntentHash,
  assertRunTransition,
  runStateForVerification,
  withheldReasonFor,
  type ArtifactRef,
  type CheckEvidence,
  type DataContractFull,
  type RunState,
  type RunTransition,
  type WorkloadProfile,
  type RunContext,
} from "@crucible/eval";
import { verifiedSessionFromContext } from "./auth.js";
import { IdempotencyStore, parseIdempotencyKey } from "./idempotency.js";
import { WORKLOAD_PROFILES } from "./workload-profiles.js";

type RunRecord = {
  runId: string;
  attemptId: string;
  tenantId: string;
  trialId: string;
  trialRevisionId: string;
  workloadProfile: WorkloadProfile;
  status: string;
  /**
   * The run's state in the documented machine (§2.2).
   *
   * `status` is the *verdict* (PASS/FAIL/…); `state` is where the run is in its
   * lifecycle. They were one field, which meant a run could be "PASS" before it
   * had been verified and nothing noticed.
   */
  state: RunState;
  /** Every move, served at `/runs/:id/events`. Sequence starts at 1. */
  transitions: RunTransition[];
  artifacts: ArtifactRef[];
  /** Why a run is not scoreable, when it is not. */
  withheldReason: string | null;
  evidenceSource: "runner" | "client" | "none";
  manifest: unknown;
  scorecard?: unknown;
  report?: unknown;
  createdAt: number;
  /** the verified session address that created the run; the only reader of the record */
  createdBy: string;
};

const runs = new Map<string, RunRecord>();
/** Creator-scoped Idempotency-Key -> runId; in-memory and restart-lossy (ADR-0008). */
const idempotency = new IdempotencyStore();

export function __resetRunsForTests(): void {
  runs.clear();
}
export function __seedRunForTests(record: RunRecord): void {
  runs.set(record.runId, record);
}

export interface WorkloadDeps {
  /**
   * Fetch the runner's observations for an attempt.
   *
   * This is the trusted seam. The runner is the only component that may say
   * what it observed, and it names the attempt so a caller cannot borrow
   * another run's evidence.
   */
  evidence?: (
    attemptId: string,
    context: { tenantId: string; trialId: string; profile: WorkloadProfile },
  ) => Promise<{
    evidence: CheckEvidence[];
    infrastructureFailure?: string | null;
    outcome?: "completed" | "failed";
  } | null>;
  /** Allow a submitter to attach its own evidence. Demo/local only; refused in production. */
  allowClientEvidence?: boolean;
  /** An injected clock, so deadline and idempotency tests are deterministic. */
  now?: () => number;
}

function ctx(body: Record<string, unknown>, profile: WorkloadProfile, now: number): RunContext {
  const runId = `run-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    runId,
    attemptId: `att-${runId}`,
    tenantId: String(body.tenantId ?? "default"),
    trialId: String(body.trialId ?? "trial-1"),
    trialRevisionId: String(body.trialRevisionId ?? "rev-1"),
    workloadProfile: profile,
    environmentDigest: String(body.environmentDigest ?? "sha256:local"),
    deadlineAt: new Date(now + 600_000).toISOString(),
    idempotencyKey: runId,
    abortSignal: new AbortController().signal,
  };
}

const PROFILES: readonly WorkloadProfile[] = WORKLOAD_PROFILES;

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function createWorkloadRoutes(deps: WorkloadDeps = {}): Hono {
  const app = new Hono();
  const now = deps.now ?? (() => Date.now());
  /** Client-supplied evidence is never acceptable on a production host. */
  const allowClientEvidence = (deps.allowClientEvidence ?? false) && !isProduction();

  app.get("/workloads", (c) => c.json({ workloads: listAdapters() }));

  /* ------------------------------------------------------------------ */
  /* Runs                                                                */
  /* ------------------------------------------------------------------ */

  app.post("/runs", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    const creator = session.payload.address.toLowerCase();
    const { key: idempotencyKey, error: idempotencyError } = parseIdempotencyKey(
      c.req.header("idempotency-key") ?? null,
    );
    if (idempotencyError) return c.json({ error: idempotencyError, code: "bad-request" }, 400);
    // A retried POST used to create a second run; the key makes the retry answer
    // with the run it already created. Scoped to the creator, so a key is not
    // transferable.
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
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }

    const profile = String(body.profile ?? "SOFTWARE_ENGINEERING") as WorkloadProfile;
    if (!PROFILES.includes(profile)) {
      return c.json({ error: "unknown workload profile", code: "bad-request" }, 400);
    }
    // A caller that supplies its own score or verdict is refused outright: those
    // are computed, and accepting them would make the whole surface decorative.
    for (const forbidden of ["score", "aggregate", "verified", "status", "report"]) {
      if (body[forbidden] !== undefined) {
        return c.json(
          {
            error: `"${forbidden}" is computed by the verifier and may not be supplied by a caller`,
            code: "stamp_client_verdict_refused",
          },
          400,
        );
      }
    }

    const adapter = getAdapter(profile);
    const runCtx = ctx(body, profile, now());

    // The run's lifecycle from here on is recorded, not narrated. Every move
    // goes through the state machine, so an out-of-order status is a throw at
    // the line that caused it rather than a record that reads plausibly later.
    let state: RunState = "QUEUED";
    const transitions: RunTransition[] = [];
    const move = (to: RunState, reason?: string): void => {
      assertRunTransition(state, to);
      transitions.push({ sequence: transitions.length + 1, from: state, to, at: now(), ...(reason ? { reason } : {}) });
      state = to;
    };

    const validation = await adapter.validateTask(body.task ?? body);
    if (!validation.valid) {
      return c.json(
        { error: "validation failed", details: validation.errors, code: "bad-request" },
        400,
      );
    }
    move("ADMITTED", "the task validated");
    move("PREPARING", "the adapter resolved the pinned manifest");

    const prepared = await adapter.prepare((body.task ?? body) as never, runCtx);
    move("RUNNING", "the runner was asked to execute");
    const executed = await adapter.execute(prepared, runCtx);
    move("COLLECTING_EVIDENCE", "execution finished; evidence is being gathered");

    // Evidence: the runner's, or (on a non-production host, with the switch on)
    // the caller's. Never silently the caller's.
    let evidenceSource: RunRecord["evidenceSource"] = "none";
    let evidence: CheckEvidence[] | undefined;
    let infrastructureFailure = executed.infrastructureFailure ?? null;
    let outcome = executed.outcome;

    if (deps.evidence) {
      const runner = await deps
        .evidence(prepared.manifest.attemptId, {
          tenantId: runCtx.tenantId,
          trialId: runCtx.trialId,
          profile,
        })
        .catch(() => null);
      if (runner) {
        evidence = runner.evidence;
        infrastructureFailure = runner.infrastructureFailure ?? infrastructureFailure;
        outcome = runner.outcome ?? outcome;
        evidenceSource = "runner";
      }
    }
    if (!evidence && allowClientEvidence && Array.isArray(body.evidence)) {
      evidence = body.evidence as CheckEvidence[];
      evidenceSource = "client";
    }

    executed.evidence = evidence;
    executed.evidence === undefined && delete executed.evidence;

    move("VERIFYING", "the evidence set is closed");
    const report = await adapter.verify(
      { ...executed, infrastructureFailure, outcome, evidence },
      runCtx,
    );
    const verifiedState = runStateForVerification(report.status);
    move(verifiedState, `the verifier returned ${report.status}`);
    const rubric =
      profile === "SOFTWARE_ENGINEERING"
        ? { id: "engineering-regression", version: "v1", dimensions: [{ id: "acceptance_correctness", weight: 0.35 }] }
        : profile === "STRUCTURED_DATA"
          ? { id: "data-etl", version: "v1", dimensions: [{ id: "schema_correctness", weight: 0.2 }] }
          : { id: "autonomous-finance", version: "v1", dimensions: [{ id: "policy_compliance", weight: 0.25 }] };
    const scorecard = await adapter.score(report, rubric as never);
    // A scored run reaches PROVISIONAL_RESULT, not FINAL_RESULT: the dispute
    // window in §2.2 has not opened, and calling a provisional result final is
    // exactly the shortcut the machine exists to prevent.
    if (verifiedState === "SCORING") move("PROVISIONAL_RESULT", "scored; the dispute window has not opened");
    const withheldReason = withheldReasonFor(report.status as never);

    const record: RunRecord = {
      runId: runCtx.runId,
      attemptId: runCtx.attemptId,
      tenantId: runCtx.tenantId,
      trialId: runCtx.trialId,
      trialRevisionId: runCtx.trialRevisionId,
      workloadProfile: profile,
      status: report.status,
      state,
      transitions,
      artifacts: executed.artifacts ?? [],
      withheldReason,
      evidenceSource,
      manifest: prepared.manifest,
      report,
      scorecard,
      createdAt: now(),
      createdBy: creator,
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

  /** The run's pinned manifest: what was executed, on what, with what digests. */
  app.get("/runs/:runId/manifest", (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    const r = runs.get(c.req.param("runId"));
    if (!r || r.createdBy !== session.payload.address.toLowerCase()) {
      return c.json({ error: "run not found", code: "not-found" }, 404);
    }
    return c.json({ manifest: r.manifest });
  });

  app.get("/runs/:runId/scorecard", (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    const r = runs.get(c.req.param("runId"));
    if (!r || r.createdBy !== session.payload.address.toLowerCase()) {
      return c.json({ error: "run not found", code: "not-found" }, 404);
    }
    return c.json({ scorecard: r.scorecard ?? null, withheldReason: r.withheldReason });
  });

  /**
   * The run's state transitions, in order.
   *
   * §3.10 asks for `GET /v1/runs/{runId}/events`. Each entry is a move the
   * server actually made, with its reason — not a narration written after the
   * fact, and not the runner's telemetry (that is Forge Watch's stream).
   */
  app.get("/runs/:runId/events", (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    const r = runs.get(c.req.param("runId"));
    if (!r || r.createdBy !== session.payload.address.toLowerCase()) {
      return c.json({ error: "run not found", code: "not-found" }, 404);
    }
    return c.json({ runId: r.runId, state: r.state, events: r.transitions });
  });

  /** The artifacts the run produced, by digest. Empty is an answer, not an absence. */
  app.get("/runs/:runId/artifacts", (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    const r = runs.get(c.req.param("runId"));
    if (!r || r.createdBy !== session.payload.address.toLowerCase()) {
      return c.json({ error: "run not found", code: "not-found" }, 404);
    }
    return c.json({ runId: r.runId, artifacts: r.artifacts });
  });

  /* ------------------------------------------------------------------ */
  /* Data contracts                                                      */
  /* ------------------------------------------------------------------ */

  app.post("/data/contracts/validate", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    let body: { contract?: unknown } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    const v = validateDataContract(body.contract);
    return c.json({ valid: v.valid, errors: v.errors, warnings: v.warnings });
  });

  /** Structural + quality checks against a real row set. */
  app.post("/data/validate", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    let body: {
      contract?: unknown;
      rows?: Record<string, unknown>[];
      destination?: string;
      sourceRowCount?: number;
      sourceTotal?: number;
    } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    const v = validateDataContract(body.contract);
    if (!v.valid) return c.json({ error: "contract invalid", details: v.errors }, 400);
    if (!Array.isArray(body.rows)) return c.json({ error: "rows must be an array" }, 400);
    const result = previewContract(body.contract as DataContractFull, body.rows, {
      destination: body.destination ?? null,
      sourceRowCount: body.sourceRowCount ?? null,
      sourceTotal: body.sourceTotal ?? null,
    });
    return c.json({ checks: result.checks, passed: result.passed });
  });

  /** Compatibility between two contract revisions, before a pipeline publishes. */
  app.post("/data/contracts/compatibility", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    let body: { previous?: unknown; next?: unknown } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    const previousValid = validateDataContract(body.previous);
    const nextValid = validateDataContract(body.next);
    if (!previousValid.valid || !nextValid.valid) {
      return c.json(
        { error: "both contracts must be valid", previous: previousValid.errors, next: nextValid.errors },
        400,
      );
    }
    return c.json({
      compatibility: checkCompatibility(body.previous as DataContractFull, body.next as DataContractFull),
    });
  });

  /* ------------------------------------------------------------------ */
  /* Finance                                                             */
  /* ------------------------------------------------------------------ */

  app.post("/finance/risk-check", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    const v = validateMandate(body.mandate);
    if (!v.valid) return c.json({ error: "mandate invalid", details: v.errors }, 400);
    // The whole pre-execution sequence, not just the size checks: an approval, a
    // duplicate and a suspension are as much a refusal as an over-limit order.
    const verdict = preExecutionVerdict({
      mandate: body.mandate as never,
      proposal: body.proposal as never,
      context: {
        dailyNotionalSoFar: Number(body.dailyNotionalSoFar ?? 0),
        positionPct: Number(body.positionPct ?? 0),
        resultingLeverage: Number(body.resultingLeverage ?? 0),
        actionsToday: body.actionsToday === undefined ? undefined : Number(body.actionsToday),
        rollingNotional: body.rollingNotional === undefined ? undefined : Number(body.rollingNotional),
        inputAgeMinutes: body.inputAgeMinutes === undefined ? null : Number(body.inputAgeMinutes),
        newestInputAt: body.newestInputAt === undefined ? null : Number(body.newestInputAt),
        now: now(),
      },
      approval: (body.approval as never) ?? null,
      duplicateIntent: body.duplicateIntent === true,
      reconciliationDiscrepancy: body.reconciliationDiscrepancy === true,
    });
    return c.json({
      allowed: verdict.allowed,
      checks: verdict.checks,
      reasons: verdict.reasons,
      securityIncident: verdict.securityIncident,
    });
  });

  /** The canonical hash an approval must name. */
  app.post("/finance/intent-hash", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    let body: { payload?: Record<string, unknown> } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    if (!body.payload || typeof body.payload !== "object") {
      return c.json({ error: "payload must be an object" }, 400);
    }
    return c.json({ canonicalHash: canonicalIntentHash(body.payload) });
  });

  /* ------------------------------------------------------------------ */
  /* Asset intelligence                                                   */
  /* ------------------------------------------------------------------ */

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

/** Kept for the routes that only need a contract check without a session. */
export function checkContractRows(
  contract: DataContractFull,
  rows: Record<string, unknown>[],
): ReturnType<typeof checkRows> {
  return checkRows(contract, rows);
}

export type { Context };