/**
 * @file workload-data.ts — Phase 2 Structured Data & ETL adapter (WP5-WP7).
 * Data contract = structural + quality + operational + security + compatibility.
 * Deterministic checks: schema, quality, reconciliation, idempotency, lineage.
 */

import type {
  CheckResult,
  ExecutionResult,
  PreparedTask,
  RunContext,
  Scorecard,
  ValidationReport,
  VerificationReport,
  VersionedRubric,
  WorkloadAdapter,
} from "./workload-contracts.js";

export interface DataContract {
  name: string;
  version: string;
  schema: {
    type: "object";
    required: string[];
    properties: Record<string, { type: string; enum?: string[]; minimum?: number }>;
  };
  quality: {
    unique: string[];
    nullRateMax?: Record<string, number>;
  };
  reconciliation?: { id: string; tolerance: number }[];
  security: { classification: "public" | "confidential"; piiRedactionRequired: boolean };
}

export const DATA_RUBRIC: VersionedRubric = {
  id: "data-etl",
  version: "v1",
  dimensions: [
    { id: "schema_correctness", weight: 0.20 },
    { id: "data_quality", weight: 0.25 },
    { id: "reconciliation", weight: 0.20 },
    { id: "reliability_idempotency", weight: 0.15 },
    { id: "lineage", weight: 0.10 },
    { id: "performance", weight: 0.10 },
  ],
};

export function validateDataContract(c: unknown): ValidationReport {
  const errors: string[] = [];
  const dc = c as Partial<DataContract>;
  if (!dc.name) errors.push("name required");
  if (!dc.version) errors.push("version required");
  if (!dc.schema?.required?.length) errors.push("schema.required non-empty");
  if (!dc.quality?.unique?.length) errors.push("quality.unique non-empty");
  if (!dc.security) errors.push("security contract required");
  return { valid: errors.length === 0, errors, warnings: [] };
}

export function checkRows(contract: DataContract, rows: Record<string, unknown>[]): CheckResult[] {
  const checks: CheckResult[] = [];
  // Structural: required fields + types.
  const missing = rows.filter((r) => contract.schema.required.some((f) => r[f] === undefined));
  checks.push({
    id: "structural_schema",
    passed: missing.length === 0,
    required: true,
    detail: `${missing.length} rows missing required fields`,
  });
  // Quality: uniqueness.
  const seen = new Set<string>();
  let dup = 0;
  for (const r of rows) {
    const key = contract.quality.unique.map((f) => String(r[f])).join("|");
    if (seen.has(key)) dup++;
    seen.add(key);
  }
  checks.push({
    id: "quality_uniqueness",
    passed: dup === 0,
    required: true,
    detail: `${dup} duplicate key(s)`,
  });
  // PII: confidential + redaction required but rows carry PII fields.
  const piiKeys = ["email", "ssn", "phone", "passport"];
  const hasPii = contract.security.piiRedactionRequired && rows.some((r) => piiKeys.some((k) => k in r));
  checks.push({
    id: "pii_policy",
    passed: !hasPii,
    required: true,
    detail: hasPii ? "PII present but redaction required" : "PII policy satisfied",
  });
  // Reconciliation: row count > 0 (real sum check needs input snapshot).
  checks.push({
    id: "reconciliation_counts",
    passed: rows.length > 0,
    required: true,
    detail: `${rows.length} rows produced`,
  });
  return checks;
}

export class StructuredDataAdapter implements WorkloadAdapter<DataContract, Record<string, unknown>[]> {
  profile = "STRUCTURED_DATA" as const;
  version = "structured-data/1.0.0";

  async validateTask(task: unknown): Promise<ValidationReport> {
    return validateDataContract(task);
  }

  async prepare(input: DataContract, context: RunContext): Promise<PreparedTask> {
    const v = validateDataContract(input);
    if (!v.valid) throw new Error(`invalid contract: ${v.errors.join("; ")}`);
    return {
      taskDigest: `${input.name}@${input.version}`,
      manifest: {
        runId: context.runId,
        attemptId: context.attemptId,
        tenantId: context.tenantId,
        trialId: context.trialId,
        trialRevisionId: context.trialRevisionId,
        workloadProfile: this.profile,
        adapterVersion: this.version,
        taskDigest: `${input.name}@${input.version}`,
        runnerImageDigest: context.environmentDigest,
        evaluatorVersion: "data-evaluator/1.0.0",
        rubricVersion: `${DATA_RUBRIC.id}/${DATA_RUBRIC.version}`,
        startedAt: Date.now(),
        artifactDigests: [],
      },
    };
  }

  async execute(prepared: PreparedTask, _context: RunContext): Promise<ExecutionResult> {
    // ETL runs in ForgeRunner sandbox against a pinned source snapshot.
    return { artifacts: [], logs: ["adapter:delegated-to-forge-runner"], outcome: "completed" };
  }

  async verify(result: ExecutionResult, _context: RunContext): Promise<VerificationReport> {
    // Real verification runs checkRows() against the output artifact rows.
    return {
      status: "INCOMPLETE",
      checks: [
        { id: "structural_schema", passed: false, required: true, detail: "rows not yet attached" },
        { id: "quality_uniqueness", passed: false, required: true, detail: "rows not yet attached" },
        { id: "pii_policy", passed: false, required: true, detail: "rows not yet attached" },
        { id: "reconciliation_counts", passed: false, required: true, detail: "rows not yet attached" },
      ],
      reportDigest: "sha256:placeholder",
      verifierVersion: this.version,
    };
  }

  async score(report: VerificationReport, rubric: VersionedRubric): Promise<Scorecard> {
    const passed = report.checks.filter((c) => c.passed).length;
    return {
      scorecardId: `sc-${Date.now().toString(36)}`,
      rubricVersion: `${rubric.id}/${rubric.version}`,
      metrics: {},
      aggregate: passed / Math.max(1, report.checks.length),
      createdAt: Date.now(),
    };
  }

  async cleanup(_context: RunContext): Promise<void> {}
}

export const structuredDataAdapter = new StructuredDataAdapter();
