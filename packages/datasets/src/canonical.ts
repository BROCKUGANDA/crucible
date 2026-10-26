// SPDX-License-Identifier: UNLICENSED
/**
 * Gate 750 — Canonical dataset format.
 *
 * Every connector emits one canonical internal format: tables (rows) +
 * modality payloads + metadata. Connectors never touch scoring logic;
 * they only normalize external sources into this shape so the registry
 * (gate 748) and split engine (gate 749) can consume them uniformly.
 */

import { sha256, hashCanonical } from "@crucible/crypto";

export type ModalityType = "text" | "image" | "audio" | "graph" | "timeseries";

/** A single modality payload attached to a row. */
export interface ModalityPayload {
  type: ModalityType;
  /** Content-addressed URI (ipfs://, s3://, etc.) when stored off-row. */
  uri?: string;
  /** Inline bytes for small payloads. */
  bytes?: Uint8Array;
  /** sha256 of the payload bytes, for verification on download. */
  checksum: string;
  /** Modality-specific metadata (dimensions, sample rate, etc.). */
  metadata?: Record<string, unknown>;
}

/** A single canonical row: the data fields plus optional modality payloads. */
export interface CanonicalRow {
  /** Content-derived or provided row identifier, unique within the batch. */
  rowId: string;
  /** The actual data columns. */
  fields: Record<string, unknown>;
  /** Modality payloads attached to this row (e.g. an image the row references). */
  modality: ModalityPayload[];
  /** Row-level metadata (source line, provenance, etc.). */
  metadata?: Record<string, unknown>;
}

/** A canonical batch of rows ready to be sharded and registered. */
export interface DatasetBatch {
  rows: CanonicalRow[];
  /** JSON Schema URI or inline schema for the row fields. */
  schema: string;
  /** Dominant modality of the batch. */
  modality: ModalityType;
  rowCount: number;
  /** sha256 over JCS-canonicalized rows, so the batch is content-addressed. */
  checksum: string;
}

/** Hash a batch canonically (JCS + sha256 via the one crypto door). */
export function batchChecksum(batch: Omit<DatasetBatch, "checksum">): string {
  return sha256(hashCanonical(batch));
}

export function makeBatch(
  rows: CanonicalRow[],
  schema: string,
  modality: ModalityType,
): DatasetBatch {
  const batch = { rows, schema, modality, rowCount: rows.length };
  return { ...batch, checksum: batchChecksum(batch) };
}
