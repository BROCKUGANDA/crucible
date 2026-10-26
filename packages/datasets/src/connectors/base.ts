// SPDX-License-Identifier: UNLICENSED
/**
 * Gate 750 — Connector base interface.
 *
 * Connectors are pure adapters: they normalize an external source into the
 * canonical DatasetBatch format. They never touch scoring logic, split
 * assignment, or registry admission — those are separate layers.
 */

import type { CanonicalRow, DatasetBatch, ModalityType } from "../canonical.js";

/** Reference to a dataset on an external source. */
export interface DatasetRef {
  /** The connector name that owns this ref (e.g. "huggingface", "s3", "ipfs", "manual"). */
  source: string;
  /** Identifier meaningful to that source (HF dataset name, S3 key, IPFS CID, etc.). */
  identifier: string;
  /** Connector-specific options (revision, subfolder, etc.). */
  options?: Record<string, unknown>;
}

/** Configuration passed to a connector on connect(). */
export interface ConnectorConfig {
  /** Optional bearer token or API key for the source. */
  token?: string;
  /** Optional base URL override (useful for HF hub mirrors, S3 endpoints, IPFS gateways). */
  baseUrl?: string;
  /** Request timeout in ms. Default 30_000. */
  timeoutMs?: number;
}

/** Result of connector.fetch(): a canonical batch plus the ref it came from. */
export interface ConnectorResult {
  ref: DatasetRef;
  batch: DatasetBatch;
}

/** Every connector implements this interface. */
export interface Connector {
  /** Connector name (must match DatasetRef.source). */
  readonly name: string;
  /** Connector version. */
  readonly version: string;
  /** Authenticate and validate configuration. */
  connect(config: ConnectorConfig): Promise<void>;
  /** List discoverable datasets on this source. */
  list(): Promise<DatasetRef[]>;
  /** Fetch one dataset as a canonical batch. */
  fetch(ref: DatasetRef): Promise<ConnectorResult>;
  /** Tear down connections. */
  disconnect(): Promise<void>;
}

/** Error thrown by connectors. */
export class ConnectorError extends Error {
  readonly source: string;
  readonly identifier: string;
  override readonly cause?: unknown;
  constructor(
    source: string,
    identifier: string,
    message: string,
    cause?: unknown,
  ) {
    super(`${source}:${identifier}: ${message}`);
    this.name = "ConnectorError";
    this.source = source;
    this.identifier = identifier;
    this.cause = cause;
  }
}

/** Check whether an error is a connector error. */
export function isConnectorError(err: unknown): err is ConnectorError {
  return err instanceof ConnectorError;
}

/** Modality detection heuristic: guess modality from a file name or mime type. */
export function detectModality(fileName: string, mimeType?: string): ModalityType {
  const mime = (mimeType ?? "").toLowerCase();
  const name = fileName.toLowerCase();
  if (mime.startsWith("image/") || /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(name))
    return "image";
  if (mime.startsWith("audio/") || /\.(mp3|wav|ogg|flac|m4a)$/i.test(name)) return "audio";
  if (mime === "text/csv" || mime === "application/json" || /\.(csv|json|jsonl)$/i.test(name))
    return "text";
  if (mime.startsWith("text/")) return "text";
  return "text";
}
