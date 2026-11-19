/**
 * @file lineage.ts — lineage events an inspector can read without this repo.
 *
 * Lineage is what lets a reviewer answer "where did this number come from?"
 * without trusting the pipeline that produced it. That only works if the shape
 * is a published one, so the event model below follows OpenLineage's object
 * model — `RunEvent` wrapping a `Run` and a `Job`, with input and output
 * `Dataset`s and named facets — rather than inventing a private vocabulary that
 * nothing else can read.
 *
 * The rule that makes lineage evidence rather than decoration: **a missing
 * input snapshot, transform digest or output digest is `LINEAGE_INCOMPLETE`**,
 * and an incomplete lineage fails the run. It is not a warning, because a
 * pipeline whose provenance is unknown cannot be reconciled, and an unreconciled
 * pipeline is exactly what the reconciliation checks exist to catch.
 */

import { createHash } from "node:crypto";

export type RunEventType = "START" | "RUNNING" | "COMPLETE" | "ABORT" | "FAIL";

export interface DatasetFacet {
  _producer: string;
  _schemaURL: string;
  [key: string]: unknown;
}

export interface DatasetIdentifier {
  namespace: string;
  name: string;
  facets?: Record<string, DatasetFacet>;
}

export interface JobFacet {
  _producer: string;
  _schemaURL: string;
  [key: string]: unknown;
}

export interface RunFacet {
  _producer: string;
  _schemaURL: string;
  [key: string]: unknown;
}

export interface RunEvent {
  eventType: RunEventType;
  eventTime: string;
  run: {
    runId: string;
    facets?: Record<string, RunFacet>;
  };
  job: {
    namespace: string;
    name: string;
    facets?: Record<string, JobFacet>;
  };
  inputs?: DatasetIdentifier[];
  outputs?: DatasetIdentifier[];
  producer: string;
  schemaURL: string;
}

/** The facets this repository publishes, and the producer string they carry. */
export const LINEAGE_PRODUCER = "https://crucible.local/lineage";
export const LINEAGE_SCHEMA_URL = "https://openlineage.io/spec/2-0-2/OpenLineage.json";

/**
 * The provenance a data run must record.
 *
 * These are the four facts the reconciliation and the data-quality report both
 * depend on: which snapshot was read, which transform ran, which digest was
 * written and which watermark the source had reached.
 */
export interface ProvenanceInput {
  /** The pipeline/run identity. */
  runId: string;
  jobNamespace: string;
  jobName: string;
  /** The input dataset snapshot digest. */
  sourceSnapshot: string | null;
  /** The digest of the transformation code/config that ran. */
  transformDigest: string | null;
  /** The digest of the bytes written. */
  outputDigest: string | null;
  /** The source's own watermark, when it has one. */
  sourceWatermark?: string | null;
  /** The row count read and written, for the reconciliation facet. */
  rowsRead?: number | null;
  rowsWritten?: number | null;
  /** The contract revision the output claims to satisfy. */
  contractVersion?: string | null;
  /** When the run started and finished. */
  startedAt: string;
  finishedAt?: string | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The completeness verdict.
 *
 * `missing` names every absent fact, so an operator sees all of them at once
 * instead of fixing one and rediscovering the next.
 */
export function lineageGaps(input: ProvenanceInput): {
  complete: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  if (!input.sourceSnapshot) missing.push("sourceSnapshot");
  if (!input.transformDigest) missing.push("transformDigest");
  if (!input.outputDigest) missing.push("outputDigest");
  if (!input.runId) missing.push("runId");
  if (!input.jobName) missing.push("jobName");
  if (!input.startedAt) missing.push("startedAt");
  return { complete: missing.length === 0, missing };
}

/** The START event: the run exists and knows what it will read. */
export function startEvent(input: ProvenanceInput): RunEvent {
  return {
    eventType: "START",
    eventTime: input.startedAt,
    run: {
      runId: input.runId,
      facets: {
        // OpenLineage's own naming for "the code that ran".
        sourceCode: {
          _producer: LINEAGE_PRODUCER,
          _schemaURL: `${LINEAGE_SCHEMA_URL}#/definitions/SourceCodeJobFacet`,
          language: "typescript",
          sourceCode: input.transformDigest ?? "unknown",
        },
        crucible_provenance: {
          _producer: LINEAGE_PRODUCER,
          _schemaURL: `${LINEAGE_SCHEMA_URL}#/definitions/CrucibleProvenanceFacet`,
          sourceSnapshot: input.sourceSnapshot,
          transformDigest: input.transformDigest,
          contractVersion: input.contractVersion ?? null,
          sourceWatermark: input.sourceWatermark ?? null,
        },
      },
    },
    job: { namespace: input.jobNamespace, name: input.jobName },
    inputs: input.sourceSnapshot
      ? [
          {
            namespace: input.jobNamespace,
            name: `${input.jobName}/source`,
            facets: {
              version: {
                _producer: LINEAGE_PRODUCER,
                _schemaURL: `${LINEAGE_SCHEMA_URL}#/definitions/DatasetVersionDatasetFacet`,
                datasetVersion: input.sourceSnapshot,
              },
            },
          },
        ]
      : [],
    producer: LINEAGE_PRODUCER,
    schemaURL: LINEAGE_SCHEMA_URL,
  };
}

/** The COMPLETE event: what was written, and the counts that reconcile it. */
export function completeEvent(input: ProvenanceInput): RunEvent {
  const gaps = lineageGaps(input);
  return {
    eventType: gaps.complete ? "COMPLETE" : "FAIL",
    eventTime: input.finishedAt ?? new Date().toISOString(),
    run: {
      runId: input.runId,
      facets: {
        crucible_provenance: {
          _producer: LINEAGE_PRODUCER,
          _schemaURL: `${LINEAGE_SCHEMA_URL}#/definitions/CrucibleProvenanceFacet`,
          sourceSnapshot: input.sourceSnapshot,
          transformDigest: input.transformDigest,
          outputDigest: input.outputDigest,
          contractVersion: input.contractVersion ?? null,
          sourceWatermark: input.sourceWatermark ?? null,
          lineageComplete: gaps.complete,
          lineageMissing: gaps.missing,
        },
        crucible_reconciliation: {
          _producer: LINEAGE_PRODUCER,
          _schemaURL: `${LINEAGE_SCHEMA_URL}#/definitions/CrucibleReconciliationFacet`,
          rowsRead: input.rowsRead ?? null,
          rowsWritten: input.rowsWritten ?? null,
          // Reported as null when either count is unknown, never as 0: an
          // unknown count and an empty result are different facts.
          reconciled:
            input.rowsRead === null || input.rowsRead === undefined || input.rowsWritten === null || input.rowsWritten === undefined
              ? null
              : input.rowsRead === input.rowsWritten,
        },
      },
    },
    job: { namespace: input.jobNamespace, name: input.jobName },
    outputs: input.outputDigest
      ? [
          {
            namespace: input.jobNamespace,
            name: `${input.jobName}/output`,
            facets: {
              version: {
                _producer: LINEAGE_PRODUCER,
                _schemaURL: `${LINEAGE_SCHEMA_URL}#/definitions/DatasetVersionDatasetFacet`,
                datasetVersion: input.outputDigest,
              },
            },
          },
        ]
      : [],
    producer: LINEAGE_PRODUCER,
    schemaURL: LINEAGE_SCHEMA_URL,
  };
}

/**
 * Validate an event before it is stored or published.
 *
 * A lineage event with no producer, no schema URL and no run id is not
 * interoperable; storing it would put a row in the lineage table that no
 * consumer can interpret, which is worse than a gap because it looks like
 * coverage.
 */
export function validateRunEvent(event: RunEvent): string[] {
  const problems: string[] = [];
  if (!event.producer) problems.push("producer is required");
  if (!event.schemaURL) problems.push("schemaURL is required");
  if (!event.run?.runId) problems.push("run.runId is required");
  if (!event.job?.namespace) problems.push("job.namespace is required");
  if (!event.job?.name) problems.push("job.name is required");
  if (!event.eventTime || Number.isNaN(Date.parse(event.eventTime))) {
    problems.push("eventTime must be an ISO timestamp");
  }
  for (const [label, list] of [
    ["inputs", event.inputs ?? []],
    ["outputs", event.outputs ?? []],
  ] as const) {
    for (const dataset of list) {
      if (!dataset.namespace) problems.push(`${label} entry has no namespace`);
      if (!dataset.name) problems.push(`${label} entry has no name`);
    }
  }
  return problems;
}

/**
 * The digest an inspector can quote.
 *
 * Computed over the event with its key order normalised, so two stores that
 * receive the same event quote the same digest.
 */
export function eventDigest(event: RunEvent): string {
  return `sha256:${sha256(canonicalJson(event))}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}