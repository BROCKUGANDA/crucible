/**
 * @file scoring-routes.ts — Hono routes for the scoring engine.
 *
 * Provides rubric management, dimension scores, and aggregate scores.
 * Uses PostgreSQL-backed stores when DATABASE_URL is set.
 */

import { Hono } from "hono";
import { verifiedSessionFromContext } from "./auth.js";
import {
  createRubric,
  getRubric,
  getActiveRubric,
  listRubrics,
  createDimensionScore,
  getDimensionScores,
  computeAggregateScore,
  type Rubric,
  type DimensionScore,
  type AggregateScore,
  type CreateRubricInput,
  type CreateDimensionScoreInput,
} from "./scoring.js";
import {
  pgCreateRubric,
  pgGetRubric,
  pgGetActiveRubric,
  pgListRubrics,
  pgCreateDimensionScore,
  pgGetDimensionScores,
  pgCreateAggregateScore,
  pgGetAggregateScore,
} from "./scoring-pg.js";

const usePg = !!process.env.DATABASE_URL;

export function createScoringRoutes(): Hono {
  const app = new Hono();

  // List rubrics
  app.get("/rubrics", async (c) => {
    const status = c.req.query("status");
    const name = c.req.query("name");
    const rubrics = usePg
      ? await pgListRubrics({ status, name })
      : listRubrics({ status: status as any, name });
    return c.json(rubrics);
  });

  // Create rubric
  app.post("/rubrics", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const input = await c.req.json<CreateRubricInput>();
    try {
      const rubric = usePg ? await pgCreateRubric(input) : createRubric(input);
      return c.json(rubric, 201);
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }
  });

  // Get rubric by ID
  app.get("/rubrics/:id", async (c) => {
    const id = c.req.param("id");
    const rubric = usePg ? await pgGetRubric(id) : getRubric(id);
    if (!rubric) return c.json({ error: "Rubric not found" }, 404);
    return c.json(rubric);
  });

  // Get active rubric by name
  app.get("/rubrics/name/:name", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const rubric = usePg ? await pgGetActiveRubric(name) : getActiveRubric(name);
    if (!rubric) return c.json({ error: "Active rubric not found" }, 404);
    return c.json(rubric);
  });

  // List dimension scores for a run
  app.get("/runs/:runId/dimensions", async (c) => {
    const runId = c.req.param("runId");
    const dimension = c.req.query("dimension");
    const scores = usePg
      ? await pgGetDimensionScores(runId)
      : getDimensionScores(runId);
    return c.json(scores);
  });

  // Create dimension score
  app.post("/runs/:runId/dimensions", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const runId = c.req.param("runId");
    const input = await c.req.json<CreateDimensionScoreInput>();
    input.runId = runId;

    try {
      const score = usePg ? await pgCreateDimensionScore(input) : createDimensionScore(input);
      return c.json(score, 201);
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }
  });

  // Get aggregate score for a run
  app.get("/runs/:runId/aggregate", async (c) => {
    const runId = c.req.param("runId");
    const aggregate = usePg ? await pgGetAggregateScore(runId) : null;

    // If not in DB, compute from dimension scores
    if (!aggregate) {
      const dimScores = usePg
        ? await pgGetDimensionScores(runId)
        : getDimensionScores(runId);
      if (dimScores.length === 0) {
        return c.json({ error: "No scores found for this run" }, 404);
      }
      // Return computed aggregate
      return c.json({
        runId,
        scores: dimScores,
        note: "Aggregate not yet persisted",
      });
    }
    return c.json(aggregate);
  });

  return app;
}
