/**
 * @file scoring-pg.ts — PostgreSQL-backed scoring store.
 *
 * Replaces the in-memory Map-based store in scoring.ts with durable
 * PostgreSQL storage for rubrics, dimension scores, and aggregate scores.
 */

import { getPool } from "@crucible/agent-security";
import type {
  Rubric,
  DimensionScore,
  AggregateScore,
  CreateRubricInput,
  CreateDimensionScoreInput,
  ScoreDimension,
} from "./scoring.js";

/* ------------------------------------------------------------------ */
/* Row converters                                                     */
/* ------------------------------------------------------------------ */

function rowToRubric(r: Record<string, unknown>): Rubric {
  return {
    id: r.id as string,
    name: r.name as string,
    description: r.description as string,
    dimensions: typeof r.dimensions === "string" ? JSON.parse(r.dimensions as string) : r.dimensions,
    version: r.version as string,
    status: r.status as "ACTIVE" | "DEPRECATED" | "DRAFT",
    createdAt: Number(r.created_at),
  };
}

function rowToDimensionScore(r: Record<string, unknown>): DimensionScore {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    rubricId: r.rubric_id as string,
    dimension: r.dimension as ScoreDimension,
    score: Number(r.score),
    weight: Number(r.weight ?? 1),
    evidence: typeof r.evidence === "string" ? JSON.parse(r.evidence as string) : (r.evidence as Record<string, unknown>),
    methodology: (r.methodology as string) ?? "",
    sampleCount: Number(r.sample_count),
    confidenceLower: r.confidence_lower != null ? Number(r.confidence_lower) : null,
    confidenceUpper: r.confidence_upper != null ? Number(r.confidence_upper) : null,
    variance: r.variance != null ? Number(r.variance) : null,
    judgeId: (r.judge_id as string) ?? null,
    judgeDecision: (r.judge_decision as string) ?? null,
    createdAt: Number(r.created_at),
  };
}

function rowToAggregateScore(r: Record<string, unknown>): AggregateScore {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    rubricId: r.rubric_id as string,
    score: Number(r.score),
    dimensionScores: typeof r.dimension_scores === "string" ? JSON.parse(r.dimension_scores as string) : (r.dimension_scores as Record<string, unknown>),
    methodology: (r.methodology as string) ?? "",
    confidenceLower: r.confidence_lower != null ? Number(r.confidence_lower) : null,
    confidenceUpper: r.confidence_upper != null ? Number(r.confidence_upper) : null,
    sampleCount: Number(r.sample_count),
    status: (r.status as "DISPUTED" | "PROVISIONAL" | "REVOKED" | "VERIFIED") ?? "PROVISIONAL",
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at ?? r.created_at),
  };
}

/* ------------------------------------------------------------------ */
/* Rubric operations                                                  */
/* ------------------------------------------------------------------ */

export async function pgCreateRubric(input: CreateRubricInput): Promise<Rubric> {
  const pool = getPool();
  const now = Date.now();
  const id = `rubric_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const version = input.version ?? "1";

  const r = await pool.query(
    `INSERT INTO rubrics (id, name, description, dimensions, version, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (name, version) DO NOTHING
     RETURNING *`,
    [
      id,
      input.name.trim(),
      input.description?.trim() ?? "",
      JSON.stringify(input.dimensions),
      version,
      "ACTIVE",
      now,
    ],
  );

  if (r.rows.length === 0) {
    throw new Error(`Rubric "${input.name}" version "${version}" already exists`);
  }

  return rowToRubric(r.rows[0]);
}

export async function pgGetRubric(id: string): Promise<Rubric | null> {
  const pool = getPool();
  const r = await pool.query(`SELECT * FROM rubrics WHERE id = $1`, [id]);
  return r.rows.length > 0 ? rowToRubric(r.rows[0]) : null;
}

export async function pgGetActiveRubric(name: string): Promise<Rubric | null> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT * FROM rubrics WHERE name = $1 AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1`,
    [name],
  );
  return r.rows.length > 0 ? rowToRubric(r.rows[0]) : null;
}

export async function pgListRubrics(filters: { status?: string; name?: string } = {}): Promise<Rubric[]> {
  const pool = getPool();
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  let idx = 1;

  if (filters.status) {
    conditions.push(`status = $${idx++}`);
    params.push(filters.status);
  }
  if (filters.name) {
    conditions.push(`name = $${idx++}`);
    params.push(filters.name);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const r = await pool.query(`SELECT * FROM rubrics ${where} ORDER BY created_at DESC`, params);
  return r.rows.map(rowToRubric);
}

/* ------------------------------------------------------------------ */
/* Dimension score operations                                         */
/* ------------------------------------------------------------------ */

export async function pgCreateDimensionScore(input: CreateDimensionScoreInput): Promise<DimensionScore> {
  const pool = getPool();
  const now = Date.now();
  const id = `dscore_${now}_${Math.random().toString(36).slice(2, 8)}`;

  const r = await pool.query(
    `INSERT INTO score_dimensions (
      id, run_id, rubric_id, dimension, score, evidence, sample_count,
      confidence_lower, confidence_upper, variance, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      id,
      input.runId,
      input.rubricId,
      input.dimension,
      input.score,
      JSON.stringify(input.evidence ?? {}),
      input.sampleCount ?? 1,
      input.confidenceLower ?? null,
      input.confidenceUpper ?? null,
      input.variance ?? null,
      now,
    ],
  );

  return rowToDimensionScore(r.rows[0]);
}

export async function pgGetDimensionScores(
  runId: string,
  filters: { dimension?: ScoreDimension } = {},
): Promise<DimensionScore[]> {
  const pool = getPool();
  const conditions: string[] = [`run_id = $1`];
  const params: (string | number)[] = [runId];
  let idx = 2;

  if (filters.dimension) {
    conditions.push(`dimension = $${idx++}`);
    params.push(filters.dimension);
  }

  const r = await pool.query(
    `SELECT * FROM score_dimensions WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
    params,
  );
  return r.rows.map(rowToDimensionScore);
}

/* ------------------------------------------------------------------ */
/* Aggregate score operations                                         */
/* ------------------------------------------------------------------ */

export async function pgCreateAggregateScore(input: {
  runId: string;
  rubricId: string;
  score: number;
  weights: Record<string, number>;
  sampleCount: number;
  confidenceLower?: number;
  confidenceUpper?: number;
  methodology: string;
}): Promise<AggregateScore> {
  const pool = getPool();
  const now = Date.now();
  const id = `aggr_${now}_${Math.random().toString(36).slice(2, 8)}`;

  const r = await pool.query(
    `INSERT INTO aggregate_scores (
      id, run_id, rubric_id, score, weights, sample_count,
      confidence_lower, confidence_upper, methodology, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      id,
      input.runId,
      input.rubricId,
      input.score,
      JSON.stringify(input.weights),
      input.sampleCount,
      input.confidenceLower ?? null,
      input.confidenceUpper ?? null,
      input.methodology,
      now,
    ],
  );

  return rowToAggregateScore(r.rows[0]);
}

export async function pgGetAggregateScore(runId: string): Promise<AggregateScore | null> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT * FROM aggregate_scores WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [runId],
  );
  return r.rows.length > 0 ? rowToAggregateScore(r.rows[0]) : null;
}
