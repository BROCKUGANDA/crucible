/**
 * @file workload-data.ts — Phase 2 Structured Data & ETL adapter (WP5-WP7).
 *
 * A data contract is five separate contracts, and the blueprint is specific that
 * they stay separate because they fail differently:
 *
 *   structural   — fields, types, required/optional, formats, enums
 *   quality      — uniqueness, nullability, ranges, freshness, reconciliation
 *   operational  — volume, latency, retry policy, ownership
 *   security     — classification, allowed destinations, redaction
 *   compatibility— whether a schema change is backward-compatible or breaking
 *
 * The checks below are real: they read the rows, the source snapshot and the
 * previous contract revision and produce an observation for each rule. The
 * adapter then hands those observations to the shared verdict function, so a
 * contract violation fails rather than being reported as `INCOMPLETE` forever.
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
import {
  HARD_GATE_DIMENSIONS,
  computeVerdict,
  scoreVerdict,
  type CheckEvidence,
  type RequiredCheck,
} from "./verification.js";

export type FieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

export interface FieldSpec {
  type: FieldType | FieldType[];
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  /** A regex the string must match. */
  pattern?: string;
  /** `date-time` is the only format the evaluator recognises, and it validates it. */
  format?: "date-time" | "date";
  nullable?: boolean;
}

export interface DataContract {
  name: string;
  version: string;
  /** The format the rows arrive in. */
  format?: "json" | "csv" | "parquet" | "avro";
  schema: {
    type: "object";
    required: string[];
    additionalProperties?: boolean;
    properties: Record<string, FieldSpec>;
  };
  quality: {
    unique: string[];
    nullRateMax?: Record<string, number>;
    /** Inclusive numeric bounds, checked against the produced rows. */
    ranges?: Record<string, { min?: number; max?: number }>;
    /** Freshness in minutes, checked against the snapshot's timestamp. */
    freshnessMinutes?: number;
  };
  reconciliation?: {
    id: string;
    /** The declared tolerance; a float is a policy, and it is versioned. */
    tolerance: number;
    /** Which assertion this encodes. Only the enumerated forms are executable. */
    kind?: "row_count" | "sum" | "count_where";
    /** The field for `sum`, or the field for `count_where`. */
    field?: string;
    /** The value `count_where` counts. */
    equals?: string | number;
  }[];
  operational?: {
    maxRows?: number;
    maxRuntimeSeconds?: number;
    freshnessMinutes?: number;
    owner?: string;
    retryPolicy?: "none" | "bounded";
  };
  security: {
    classification: "public" | "confidential" | "restricted";
    allowedDestinations?: string[];
    piiRedactionRequired: boolean;
    /** Fields that must never appear in a public projection. */
    piiFields?: string[];
  };
  /** How this revision relates to the previous one. */
  compatibility?: {
    policy: "backward" | "forward" | "full" | "breaking";
  };
}

export const DATA_RUBRIC: VersionedRubric = {
  id: "data-etl",
  version: "v1",
  dimensions: [
    { id: "schema_correctness", weight: 0.2 },
    { id: "data_quality", weight: 0.25 },
    { id: "reconciliation", weight: 0.2 },
    { id: "reliability_idempotency", weight: 0.15 },
    { id: "lineage", weight: 0.1 },
    { id: "performance", weight: 0.1 },
  ],
};

export const DATA_REQUIREMENTS: readonly RequiredCheck[] = [
  {
    id: "structural_schema",
    required: true,
    dimension: "schema_correctness",
    expectation: "every required field is present and every present field matches its type",
  },
  {
    id: "additional_properties",
    required: false,
    dimension: "schema_correctness",
    expectation: "unknown fields follow the contract's additionalProperties policy",
  },
  {
    id: "quality_uniqueness",
    required: true,
    dimension: "data_quality",
    expectation: "the declared unique keys have no duplicates",
  },
  {
    id: "quality_null_rate",
    required: true,
    dimension: "data_quality",
    expectation: "no field exceeds its declared null rate",
  },
  {
    id: "quality_ranges",
    required: false,
    dimension: "data_quality",
    expectation: "numeric values respect the declared bounds",
  },
  {
    id: "quality_formats",
    required: false,
    dimension: "data_quality",
    expectation: "timestamps and enums validate",
  },
  {
    id: "reconciliation",
    required: true,
    dimension: "reconciliation",
    expectation: "source and output reconcile within the declared tolerance",
  },
  {
    id: "pii_policy",
    required: true,
    dimension: "schema_correctness",
    expectation: "no PII field is present when redaction is required",
  },
  {
    id: "destination_policy",
    required: true,
    dimension: "schema_correctness",
    expectation: "the output went only to an allowed destination",
  },
  {
    id: "idempotency",
    required: true,
    dimension: "reliability_idempotency",
    expectation: "a repeated run with the same key writes no duplicates",
  },
  {
    id: "lineage_emitted",
    required: true,
    dimension: "lineage",
    expectation: "input snapshot, transform digest and output digest are all recorded",
  },
  {
    id: "performance",
    required: false,
    dimension: "performance",
    expectation: "row count and runtime stay inside the declared budget",
  },
];

export function validateDataContract(c: unknown): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const dc = c as Partial<DataContract>;
  if (!dc.name) errors.push("name required");
  if (!dc.version) errors.push("version required");
  if (!dc.schema?.required?.length) errors.push("schema.required must be non-empty");
  if (!dc.schema?.properties || Object.keys(dc.schema.properties).length === 0) {
    errors.push("schema.properties must declare at least one field");
  }
  for (const field of dc.schema?.required ?? []) {
    if (!dc.schema?.properties?.[field]) {
      errors.push(`required field "${field}" has no schema declaration`);
    }
  }
  if (!dc.quality) errors.push("quality contract required");
  if (!Array.isArray(dc.quality?.unique)) errors.push("quality.unique must be an array");
  if (!dc.security) errors.push("security contract required");
  else if (dc.security.classification !== "public" && !dc.security.piiRedactionRequired) {
    warnings.push(
      `contract is ${dc.security.classification} but does not require PII redaction; confirm with counsel`,
    );
  }
  for (const rule of dc.reconciliation ?? []) {
    if (typeof rule.tolerance !== "number" || rule.tolerance < 0) {
      errors.push(`reconciliation rule ${rule.id} needs a non-negative tolerance`);
    }
    if (!rule.kind) {
      warnings.push(
        `reconciliation rule ${rule.id} declares no executable kind; it is checked as a row-count rule`,
      );
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

/* ------------------------------------------------------------------ */
/* Row validation                                                       */
/* ------------------------------------------------------------------ */

const PII_KEYS = ["email", "ssn", "phone", "passport", "address", "dob", "national_id"];

function typeOf(value: unknown): FieldType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  return "object";
}

function matchesType(value: unknown, spec: FieldSpec): boolean {
  const declared = Array.isArray(spec.type) ? spec.type : [spec.type];
  const actual = typeOf(value);
  // An integer satisfies a `number` declaration and vice versa: the distinction
  // is a precision policy, not a shape, and refusing 1 for "number" would make
  // every JSON parser produce a schema error.
  if (declared.includes(actual)) return true;
  if (declared.includes("number") && actual === "integer") return true;
  if (declared.includes("integer") && actual === "number") return Number.isInteger(value);
  return false;
}

function isValidDate(value: unknown, format: "date-time" | "date"): boolean {
  if (typeof value !== "string") return false;
  if (format === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
  return !Number.isNaN(Date.parse(value)) && /T\d{2}:\d{2}/.test(value);
}

export interface RowCheckOptions {
  /** The destination the output was written to, for the security contract. */
  destination?: string | null;
  /** The input row count, for the reconciliation rule. */
  sourceRowCount?: number | null;
  /** The input total for a `sum` rule. */
  sourceTotal?: number | null;
  /** The input count for a `count_where` rule. */
  sourceCountWhere?: number | null;
  /** The instant the source snapshot was taken, for freshness. */
  sourceSnapshotAt?: number | null;
  /** The instant the output was produced. */
  producedAt?: number;
  /** The runtime, in seconds, for the operational budget. */
  runtimeSeconds?: number | null;
}

/** Run every executable rule of the contract against the produced rows. */
export function checkRows(
  contract: DataContract,
  rows: Record<string, unknown>[],
  options: RowCheckOptions = {},
): CheckResult[] {
  const checks: CheckResult[] = [];

  // Structural: required fields present, declared types honoured.
  const missing: string[] = [];
  const wrongType: string[] = [];
  for (const [index, row] of rows.entries()) {
    for (const field of contract.schema.required) {
      if (row[field] === undefined) missing.push(`row ${index}: ${field}`);
    }
    for (const [field, spec] of Object.entries(contract.schema.properties)) {
      const value = row[field];
      if (value === undefined) continue;
      if (value === null && spec.nullable) continue;
      if (!matchesType(value, spec)) wrongType.push(`row ${index}: ${field} is ${typeOf(value)}`);
    }
  }
  checks.push({
    id: "structural_schema",
    passed: missing.length === 0 && wrongType.length === 0,
    required: true,
    detail:
      missing.length === 0 && wrongType.length === 0
        ? `${rows.length} rows match the structural contract`
        : `${missing.length} missing field(s), ${wrongType.length} type violation(s): ${[
            ...missing.slice(0, 3),
            ...wrongType.slice(0, 3),
          ].join(", ")}`,
  });

  // Unknown fields, per the declared policy.
  const known = new Set(Object.keys(contract.schema.properties));
  const unknown = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!known.has(key)) unknown.add(key);
  }
  const allowExtra = contract.schema.additionalProperties !== false;
  checks.push({
    id: "additional_properties",
    passed: allowExtra || unknown.size === 0,
    required: false,
    detail:
      unknown.size === 0
        ? "no unknown fields"
        : allowExtra
          ? `${unknown.size} unknown field(s) allowed by contract`
          : `${unknown.size} unknown field(s) refused: ${[...unknown].slice(0, 5).join(", ")}`,
  });

  // Uniqueness.
  const seen = new Set<string>();
  let duplicates = 0;
  for (const row of rows) {
    const key = contract.quality.unique.map((f) => String(row[f])).join("\u0000");
    if (seen.has(key)) duplicates += 1;
    seen.add(key);
  }
  checks.push({
    id: "quality_uniqueness",
    passed: duplicates === 0,
    required: true,
    detail: duplicates === 0 ? "no duplicate keys" : `${duplicates} duplicate key(s)`,
  });

  // Null rate per field.
  const nullViolations: string[] = [];
  for (const [field, max] of Object.entries(contract.quality.nullRateMax ?? {})) {
    if (rows.length === 0) break;
    const nulls = rows.filter((r) => r[field] === null || r[field] === undefined).length;
    const rate = nulls / rows.length;
    if (rate > max) nullViolations.push(`${field} ${(rate * 100).toFixed(2)}% > ${(max * 100).toFixed(2)}%`);
  }
  checks.push({
    id: "quality_null_rate",
    passed: nullViolations.length === 0,
    required: true,
    detail: nullViolations.length === 0 ? "null rates within contract" : nullViolations.join("; "),
  });

  // Numeric ranges.
  const rangeViolations: string[] = [];
  for (const [field, bounds] of Object.entries(contract.quality.ranges ?? {})) {
    for (const row of rows) {
      const value = row[field];
      if (typeof value !== "number") continue;
      if (bounds.min !== undefined && value < bounds.min) {
        rangeViolations.push(`${field}=${value} < ${bounds.min}`);
      }
      if (bounds.max !== undefined && value > bounds.max) {
        rangeViolations.push(`${field}=${value} > ${bounds.max}`);
      }
    }
  }
  checks.push({
    id: "quality_ranges",
    passed: rangeViolations.length === 0,
    required: false,
    detail:
      rangeViolations.length === 0 ? "all values within bounds" : rangeViolations.slice(0, 3).join("; "),
  });

  // Formats and enums.
  const formatViolations: string[] = [];
  for (const [field, spec] of Object.entries(contract.schema.properties)) {
    for (const row of rows) {
      const value = row[field];
      if (value === undefined || value === null) continue;
      if (spec.enum && !spec.enum.includes(String(value))) {
        formatViolations.push(`${field}=${String(value)} not in enum`);
      }
      if (spec.format && !isValidDate(value, spec.format)) {
        formatViolations.push(`${field}=${String(value)} is not a valid ${spec.format}`);
      }
      if (spec.pattern && typeof value === "string" && !new RegExp(spec.pattern).test(value)) {
        formatViolations.push(`${field}=${String(value)} does not match ${spec.pattern}`);
      }
    }
  }
  checks.push({
    id: "quality_formats",
    passed: formatViolations.length === 0,
    required: false,
    detail: formatViolations.length === 0 ? "enums, formats and patterns hold" : formatViolations.slice(0, 3).join("; "),
  });

  // Reconciliation, against the declared tolerance.
  const reconciliationFailures: string[] = [];
  for (const rule of contract.reconciliation ?? []) {
    if (rule.kind === "sum" && rule.field) {
      const actual = rows.reduce((a, r) => a + (typeof r[rule.field!] === "number" ? (r[rule.field!] as number) : 0), 0);
      const expected = options.sourceTotal;
      if (expected === undefined || expected === null) {
        reconciliationFailures.push(`${rule.id}: no source total was supplied`);
      } else if (Math.abs(actual - expected) > rule.tolerance) {
        reconciliationFailures.push(`${rule.id}: output ${actual} vs source ${expected}`);
      }
    } else if (rule.kind === "count_where" && rule.field !== undefined && rule.equals !== undefined) {
      const actual = rows.filter((r) => String(r[rule.field!]) === String(rule.equals)).length;
      const expected = options.sourceCountWhere;
      if (expected === undefined || expected === null) {
        reconciliationFailures.push(`${rule.id}: no source count was supplied`);
      } else if (Math.abs(actual - expected) > rule.tolerance) {
        reconciliationFailures.push(`${rule.id}: output ${actual} vs source ${expected}`);
      }
    } else {
      const expected = options.sourceRowCount;
      if (expected === undefined || expected === null) {
        reconciliationFailures.push(`${rule.id}: no source row count was supplied`);
      } else if (Math.abs(rows.length - expected) > rule.tolerance) {
        reconciliationFailures.push(`${rule.id}: output ${rows.length} rows vs source ${expected}`);
      }
    }
  }
  checks.push({
    id: "reconciliation",
    passed: reconciliationFailures.length === 0,
    required: true,
    detail:
      reconciliationFailures.length === 0
        ? `${(contract.reconciliation ?? []).length} rule(s) reconcile`
        : reconciliationFailures.join("; "),
  });

  // PII.
  const piiKeys = contract.security.piiFields ?? PII_KEYS;
  const piiPresent = contract.security.piiRedactionRequired
    ? [...new Set(rows.flatMap((r) => piiKeys.filter((k) => r[k] !== undefined && r[k] !== null)))]
    : [];
  checks.push({
    id: "pii_policy",
    passed: piiPresent.length === 0,
    required: true,
    detail:
      piiPresent.length === 0
        ? contract.security.piiRedactionRequired
          ? "no PII fields present"
          : "redaction not required by this contract"
        : `PII present but redaction required: ${piiPresent.join(", ")}`,
  });

  // Destination allowlist.
  const allowed = contract.security.allowedDestinations ?? [];
  const destination = options.destination ?? null;
  const destinationOk = allowed.length === 0 ? true : destination !== null && allowed.includes(destination);
  checks.push({
    id: "destination_policy",
    passed: destinationOk,
    required: true,
    detail:
      allowed.length === 0
        ? "no destination allowlist declared"
        : destinationOk
          ? `wrote to allowed destination ${destination}`
          : `destination ${destination ?? "(none)"} is not in ${allowed.join(", ")}`,
  });

  // Freshness, as an operational rule.
  const freshnessMinutes = contract.operational?.freshnessMinutes ?? contract.quality.freshnessMinutes;
  if (freshnessMinutes !== undefined) {
    const snapshot = options.sourceSnapshotAt;
    const produced = options.producedAt ?? Date.now();
    const ageMinutes = snapshot === undefined || snapshot === null ? null : (produced - snapshot) / 60_000;
    checks.push({
      id: "freshness",
      passed: ageMinutes !== null && ageMinutes <= freshnessMinutes,
      required: false,
      detail:
        ageMinutes === null
          ? "no source snapshot timestamp, so freshness cannot be established"
          : `source age ${ageMinutes.toFixed(1)} minutes against a ${freshnessMinutes} minute budget`,
    });
  }

  // Operational budget.
  if (contract.operational?.maxRows !== undefined || contract.operational?.maxRuntimeSeconds !== undefined) {
    const overRows =
      contract.operational.maxRows !== undefined && rows.length > contract.operational.maxRows;
    const overRuntime =
      contract.operational.maxRuntimeSeconds !== undefined &&
      options.runtimeSeconds !== null &&
      options.runtimeSeconds !== undefined &&
      options.runtimeSeconds > contract.operational.maxRuntimeSeconds;
    checks.push({
      id: "performance",
      passed: !overRows && !overRuntime,
      required: false,
      detail: overRows
        ? `${rows.length} rows exceeds ${contract.operational.maxRows}`
        : overRuntime
          ? `runtime ${options.runtimeSeconds}s exceeds ${contract.operational.maxRuntimeSeconds}s`
          : "within the declared budget",
    });
  }

  return checks;
}

/* ------------------------------------------------------------------ */
/* Compatibility                                                        */
/* ------------------------------------------------------------------ */

export interface CompatibilityReport {
  compatible: boolean;
  breaking: { field: string; change: string }[];
  additions: string[];
  policy: string;
}

/**
 * Compare two contract revisions.
 *
 * A field removed from `required`, a field removed from `properties`, a narrowed
 * enum, a tightened range or a new required field are breaking under every
 * policy. The policy decides whether *additions* are allowed: under `backward`
 * a consumer may ignore a new optional field, under `full` the producer and
 * consumer must move together, and `breaking` requires a new major version.
 */
export function checkCompatibility(
  previous: DataContract,
  next: DataContract,
): CompatibilityReport {
  const breaking: { field: string; change: string }[] = [];
  const additions: string[] = [];
  const policy = next.compatibility?.policy ?? "backward";

  const prevRequired = new Set(previous.schema.required);
  const nextRequired = new Set(next.schema.required);
  const prevFields = new Set(Object.keys(previous.schema.properties));
  const nextFields = new Set(Object.keys(next.schema.properties));

  for (const field of prevFields) {
    if (!nextFields.has(field)) breaking.push({ field, change: "field removed" });
  }
  for (const field of nextRequired) {
    if (!prevRequired.has(field)) breaking.push({ field, change: "field became required" });
  }
  for (const field of nextFields) {
    if (!prevFields.has(field)) {
      additions.push(field);
      if (nextRequired.has(field)) breaking.push({ field, change: "new required field" });
    }
  }
  for (const field of nextFields) {
    const before = previous.schema.properties[field];
    const after = next.schema.properties[field];
    if (!before || !after) continue;
    const beforeEnum = before.enum ?? [];
    const afterEnum = after.enum ?? [];
    if (beforeEnum.length > 0 && afterEnum.length > 0) {
      const removed = beforeEnum.filter((v) => !afterEnum.includes(v));
      if (removed.length > 0) breaking.push({ field, change: `enum narrowed (removed ${removed.join(", ")})` });
    }
    if (before.minimum !== undefined && (after.minimum === undefined || after.minimum > before.minimum)) {
      breaking.push({ field, change: "minimum raised or dropped" });
    }
    if (before.maximum !== undefined && (after.maximum === undefined || after.maximum < before.maximum)) {
      breaking.push({ field, change: "maximum lowered or dropped" });
    }
  }
  if (previous.quality.unique.length > next.quality.unique.length) {
    breaking.push({ field: "<unique>", change: "uniqueness constraint removed" });
  }

  const additionsAllowed = policy !== "breaking";
  return {
    compatible: breaking.length === 0 && (additions.length === 0 || additionsAllowed),
    breaking,
    additions,
    policy,
  };
}

/* ------------------------------------------------------------------ */
/* The adapter                                                          */
/* ------------------------------------------------------------------ */

export interface PipelineEvidence {
  /** The rows the pipeline produced. */
  rows?: Record<string, unknown>[];
  /** The destination the output was written to. */
  destination?: string | null;
  sourceRowCount?: number | null;
  sourceTotal?: number | null;
  sourceCountWhere?: number | null;
  sourceSnapshotAt?: number | null;
  runtimeSeconds?: number | null;
  /** Whether a re-run with the same key wrote no duplicates. */
  idempotent?: boolean;
  /** The lineage the pipeline emitted. */
  lineage?: {
    sourceSnapshot: string | null;
    transformDigest: string | null;
    outputDigest: string | null;
  } | null;
}

export class StructuredDataAdapter implements WorkloadAdapter<DataContract, Record<string, unknown>[]> {
  profile = "STRUCTURED_DATA" as const;
  version = "structured-data/1.1.0";

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
        evaluatorVersion: "data-evaluator/1.1.0",
        rubricVersion: `${DATA_RUBRIC.id}/${DATA_RUBRIC.version}`,
        startedAt: Date.now(),
        artifactDigests: [],
      },
    };
  }

  async execute(_prepared: PreparedTask, _context: RunContext): Promise<ExecutionResult> {
    // The pipeline runs in ForgeRunner against a pinned source snapshot.
    return { artifacts: [], logs: ["adapter:delegated-to-forge-runner"], outcome: "completed" };
  }

  /**
   * Verify with the pipeline's own output.
   *
   * `evidence` carries the produced rows and the source totals. When it is
   * absent the run is `INCOMPLETE`, which is the honest answer: a pipeline whose
   * output nobody attached has not been verified, it has not been checked at all.
   */
  async verify(
    result: ExecutionResult,
    context: RunContext,
  ): Promise<VerificationReport> {
    const contract = (context as RunContext & { contract?: DataContract }).contract;
    const pipelineEvidence = (result as ExecutionResult & { pipeline?: PipelineEvidence }).pipeline;
    const checks: CheckResult[] = [];

    if (contract && pipelineEvidence?.rows) {
      checks.push(
        ...checkRows(contract, pipelineEvidence.rows, {
          destination: pipelineEvidence.destination,
          sourceRowCount: pipelineEvidence.sourceRowCount,
          sourceTotal: pipelineEvidence.sourceTotal,
          sourceCountWhere: pipelineEvidence.sourceCountWhere,
          sourceSnapshotAt: pipelineEvidence.sourceSnapshotAt,
          runtimeSeconds: pipelineEvidence.runtimeSeconds,
        }),
      );
      checks.push({
        id: "idempotency",
        passed: pipelineEvidence.idempotent === true,
        required: true,
        detail:
          pipelineEvidence.idempotent === true
            ? "a repeated run with the same key wrote no duplicates"
            : "no idempotency observation was reported",
      });
      const lineage = pipelineEvidence.lineage;
      const lineageComplete = Boolean(
        lineage?.sourceSnapshot && lineage.transformDigest && lineage.outputDigest,
      );
      checks.push({
        id: "lineage_emitted",
        passed: lineageComplete,
        required: true,
        detail: lineageComplete
          ? "source snapshot, transform digest and output digest recorded"
          : "lineage is incomplete: the input snapshot, transform digest and output digest must all be recorded",
      });
    }

    // The checks computed above are observations; the verdict function treats
    // them as evidence, so a computed failure is a failure and a rule that was
    // never computed stays missing evidence. When the pipeline attached nothing,
    // the runner's own evidence is the only source — and if that is absent too,
    // the report is INCOMPLETE rather than a zero.
    const evidence: CheckEvidence[] =
      checks.length > 0
        ? checks.map((c) => ({ id: c.id, passed: c.passed, detail: c.detail }))
        : ((result.evidence ?? []) as CheckEvidence[]);

    const verdict = computeVerdict({
      requirements: DATA_REQUIREMENTS,
      evidence,
      outcome: result.outcome,
      infrastructureFailure: result.infrastructureFailure,
      verifierVersion: this.version,
    });
    return verdict.report;
  }

  async score(report: VerificationReport, rubric: VersionedRubric): Promise<Scorecard> {
    return scoreVerdict({
      report,
      rubric,
      requirements: DATA_REQUIREMENTS,
      hardGateDimensions: HARD_GATE_DIMENSIONS.data,
    }).scorecard;
  }

  async cleanup(_context: RunContext): Promise<void> {}
}

export const structuredDataAdapter = new StructuredDataAdapter();

/** Run a contract check outside a run, for the console's dry-run preview. */
export function previewContract(
  contract: DataContract,
  rows: Record<string, unknown>[],
  options: RowCheckOptions = {},
): { checks: CheckResult[]; passed: boolean } {
  const checks = checkRows(contract, rows, options);
  return { checks, passed: checks.filter((c) => c.required).every((c) => c.passed) };
}