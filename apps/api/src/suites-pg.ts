/**
 * @file suites-pg.ts — PostgreSQL-backed suite registry store.
 *
 * Replaces the in-memory Map-based store in suites.ts with durable
 * PostgreSQL storage. Uses the same table schema as migration 0008.
 *
 * Follows the same pattern as tx-store-pg.ts: raw pg Pool queries,
 * row-to-entity conversion, transactional operations.
 */

import { getPool } from "@crucible/agent-security";
import { computeSuiteVersionDigest } from "./suites.js";
import type {
  Suite,
  SuiteVersion,
  AdversarialTest,
  CreateSuiteInput,
  CreateSuiteVersionInput,
  CreateAdversarialTestInput,
  SuiteVisibility,
  SuiteStatus,
  Difficulty,
  EvaluationProtocol,
  AdversarialTestCategory,
  AdversarialTestSeverity,
} from "./suites.js";

/* ------------------------------------------------------------------ */
/* Row converters                                                     */
/* ------------------------------------------------------------------ */

function rowToSuite(r: Record<string, unknown>): Suite {
  return {
    id: r.id as string,
    orgId: (r.org_id as string) ?? null,
    name: r.name as string,
    slug: r.slug as string,
    description: r.description as string,
    maintainer: r.maintainer as string,
    visibility: r.visibility as SuiteVisibility,
    status: r.status as SuiteStatus,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function rowToSuiteVersion(r: Record<string, unknown>): SuiteVersion {
  return {
    id: r.id as string,
    suiteId: r.suite_id as string,
    version: r.version as string,
    schemaVersion: Number(r.schema_version),
    taskFamilies: (r.task_families as string[]) ?? [],
    capabilityDomains: (r.capability_domains as string[]) ?? [],
    difficulty: r.difficulty as Difficulty,
    evaluationProtocol: r.evaluation_protocol as EvaluationProtocol,
    scoringRules: typeof r.scoring_rules === "string" ? JSON.parse(r.scoring_rules as string) : (r.scoring_rules as Record<string, unknown>),
    testFixtures: typeof r.test_fixtures === "string" ? JSON.parse(r.test_fixtures as string) : (r.test_fixtures as Record<string, unknown>),
    requiredTools: typeof r.required_tools === "string" ? JSON.parse(r.required_tools as string) : (r.required_tools as unknown[]),
    runtimeConstraints: typeof r.runtime_constraints === "string" ? JSON.parse(r.runtime_constraints as string) : (r.runtime_constraints as Record<string, unknown>),
    safetyRequirements: typeof r.safety_requirements === "string" ? JSON.parse(r.safety_requirements as string) : (r.safety_requirements as Record<string, unknown>),
    expectedArtifacts: typeof r.expected_artifacts === "string" ? JSON.parse(r.expected_artifacts as string) : (r.expected_artifacts as unknown[]),
    validationRules: typeof r.validation_rules === "string" ? JSON.parse(r.validation_rules as string) : (r.validation_rules as Record<string, unknown>),
    knownLimitations: (r.known_limitations as string) ?? "",
    changelog: (r.changelog as string) ?? "",
    specDigest: (r.spec_digest as string) ?? "",
    publishedAt: r.published_at != null ? Number(r.published_at) : null,
    createdAt: Number(r.created_at),
  };
}

function rowToAdversarialTest(r: Record<string, unknown>): AdversarialTest {
  return {
    id: r.id as string,
    suiteVersionId: r.suite_version_id as string,
    name: r.name as string,
    category: r.category as AdversarialTestCategory,
    objective: r.objective as string,
    threatModel: r.threat_model as string,
    expectedBehavior: r.expected_behavior as string,
    detectionCriteria: typeof r.detection_criteria === "string" ? JSON.parse(r.detection_criteria as string) : (r.detection_criteria as Record<string, unknown>),
    evidenceRequirements: typeof r.evidence_requirements === "string" ? JSON.parse(r.evidence_requirements as string) : (r.evidence_requirements as Record<string, unknown>),
    testConfig: typeof r.test_config === "string" ? JSON.parse(r.test_config as string) : (r.test_config as Record<string, unknown>),
    severity: r.severity as AdversarialTestSeverity,
    createdAt: Number(r.created_at),
  };
}

/* ------------------------------------------------------------------ */
/* Suite operations                                                    */
/* ------------------------------------------------------------------ */

export async function pgCreateSuite(
  input: CreateSuiteInput,
  principal: { principalId: string; orgId?: string | null },
): Promise<Suite> {
  const pool = getPool();
  const now = Date.now();
  const id = `suite_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const slug = input.slug || input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const result = await pool.query(
    `INSERT INTO suites (id, org_id, name, slug, description, maintainer, visibility, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (org_id, slug) DO NOTHING
     RETURNING *`,
    [
      id,
      input.orgId ?? principal.orgId ?? null,
      input.name.trim(),
      slug.toLowerCase(),
      input.description?.trim() ?? "",
      input.maintainer ?? principal.principalId,
      input.visibility ?? "public",
      "DRAFT",
      now,
      now,
    ],
  );

  if (result.rows.length === 0) {
    throw new Error(`Suite slug "${slug}" already exists for this organization`);
  }

  return rowToSuite(result.rows[0]);
}

export async function pgGetSuite(id: string): Promise<Suite | null> {
  const pool = getPool();
  const r = await pool.query(`SELECT * FROM suites WHERE id = $1`, [id]);
  return r.rows.length > 0 ? rowToSuite(r.rows[0]) : null;
}

export async function pgListSuites(filters: {
  status?: SuiteStatus;
  visibility?: SuiteVisibility;
  orgId?: string;
  search?: string;
} = {}): Promise<Suite[]> {
  const pool = getPool();
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  let idx = 1;

  if (filters.status) {
    conditions.push(`status = $${idx++}`);
    params.push(filters.status);
  }
  if (filters.visibility) {
    conditions.push(`visibility = $${idx++}`);
    params.push(filters.visibility);
  }
  if (filters.orgId) {
    conditions.push(`org_id = $${idx++}`);
    params.push(filters.orgId);
  }
  if (filters.search) {
    conditions.push(`(name ILIKE $${idx} OR description ILIKE $${idx})`);
    params.push(`%${filters.search}%`);
    idx++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const r = await pool.query(`SELECT * FROM suites ${where} ORDER BY created_at DESC`, params);
  return r.rows.map(rowToSuite);
}

export async function pgUpdateSuiteStatus(id: string, status: SuiteStatus): Promise<Suite | null> {
  const pool = getPool();
  const now = Date.now();
  const r = await pool.query(
    `UPDATE suites SET status = $1, updated_at = $2 WHERE id = $3 RETURNING *`,
    [status, now, id],
  );
  return r.rows.length > 0 ? rowToSuite(r.rows[0]) : null;
}

/* ------------------------------------------------------------------ */
/* Suite version operations                                           */
/* ------------------------------------------------------------------ */

export async function pgCreateSuiteVersion(
  input: CreateSuiteVersionInput,
): Promise<SuiteVersion> {
  const pool = getPool();
  const now = Date.now();
  const id = `sv_${now}_${Math.random().toString(36).slice(2, 8)}`;

  // The digest is written, not defaulted. `spec_digest` is NOT NULL with no
  // default, so an insert that omits it fails — and a suite version whose
  // digest is missing cannot be compared with anything, because the digest
  // is what says two versions measured the same thing.
  const digest = computeSuiteVersionDigest(input);

  const r = await pool.query(
    `INSERT INTO suite_versions (
      id, suite_id, version, schema_version, task_families, capability_domains,
      difficulty, evaluation_protocol, scoring_rules, test_fixtures, required_tools,
      runtime_constraints, safety_requirements, expected_artifacts, validation_rules,
      known_limitations, changelog, spec_digest, status, created_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
    )
     ON CONFLICT (suite_id, version) DO NOTHING
     RETURNING *`,
    [
      id,
      input.suiteId,
      input.version,
      input.schemaVersion ?? 1,
      input.taskFamilies ?? [],
      input.capabilityDomains ?? [],
      input.difficulty ?? "unknown",
      input.evaluationProtocol ?? "deterministic",
      JSON.stringify(input.scoringRules ?? {}),
      JSON.stringify(input.testFixtures ?? {}),
      JSON.stringify(input.requiredTools ?? []),
      JSON.stringify(input.runtimeConstraints ?? {}),
      JSON.stringify(input.safetyRequirements ?? {}),
      JSON.stringify(input.expectedArtifacts ?? []),
      JSON.stringify(input.validationRules ?? {}),
      input.knownLimitations ?? "",
      input.changelog ?? "",
      digest,
      "ACTIVE",
      now,
    ],
  );

  if (r.rows.length === 0) {
    throw new Error(`Version "${input.version}" already exists for suite "${input.suiteId}"`);
  }

  return rowToSuiteVersion(r.rows[0]);
}

export async function pgGetSuiteVersion(id: string): Promise<SuiteVersion | null> {
  const pool = getPool();
  const r = await pool.query(`SELECT * FROM suite_versions WHERE id = $1`, [id]);
  return r.rows.length > 0 ? rowToSuiteVersion(r.rows[0]) : null;
}

export async function pgListSuiteVersions(
  suiteId: string,
  filters: { status?: string } = {},
): Promise<SuiteVersion[]> {
  const pool = getPool();
  const conditions: string[] = [`suite_id = $1`];
  const params: (string | number)[] = [suiteId];
  let idx = 2;

  if (filters.status) {
    conditions.push(`status = $${idx++}`);
    params.push(filters.status);
  }

  const r = await pool.query(
    `SELECT * FROM suite_versions WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
    params,
  );
  return r.rows.map(rowToSuiteVersion);
}

/* ------------------------------------------------------------------ */
/* Adversarial test operations                                        */
/* ------------------------------------------------------------------ */

export async function pgCreateAdversarialTest(
  input: CreateAdversarialTestInput,
): Promise<AdversarialTest> {
  const pool = getPool();
  const now = Date.now();
  const id = `adv_${now}_${Math.random().toString(36).slice(2, 8)}`;

  const r = await pool.query(
    `INSERT INTO adversarial_tests (
      id, suite_version_id, category, name, objective, severity,
      threat_model, expected_behavior, detection_criteria, evidence_requirements,
      status, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      id,
      input.suiteVersionId,
      input.category,
      input.name.trim(),
      input.objective ?? "",
      input.severity ?? "medium",
      input.threatModel ?? "",
      input.expectedBehavior ?? "",
      JSON.stringify(input.detectionCriteria ?? {}),
      JSON.stringify(input.evidenceRequirements ?? {}),
      "ACTIVE",
      now,
    ],
  );

  return rowToAdversarialTest(r.rows[0]);
}

export async function pgGetAdversarialTest(id: string): Promise<AdversarialTest | null> {
  const pool = getPool();
  const r = await pool.query(`SELECT * FROM adversarial_tests WHERE id = $1`, [id]);
  return r.rows.length > 0 ? rowToAdversarialTest(r.rows[0]) : null;
}

export async function pgListAdversarialTests(
  suiteVersionId: string,
  filters: { category?: AdversarialTestCategory; severity?: AdversarialTestSeverity } = {},
): Promise<AdversarialTest[]> {
  const pool = getPool();
  const conditions: string[] = [`suite_version_id = $1`];
  const params: (string | number)[] = [suiteVersionId];
  let idx = 2;

  if (filters.category) {
    conditions.push(`category = $${idx++}`);
    params.push(filters.category);
  }
  if (filters.severity) {
    conditions.push(`severity = $${idx++}`);
    params.push(filters.severity);
  }

  const r = await pool.query(
    `SELECT * FROM adversarial_tests WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
    params,
  );
  return r.rows.map(rowToAdversarialTest);
}
