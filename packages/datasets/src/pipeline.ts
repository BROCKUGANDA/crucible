// SPDX-License-Identifier: UNLICENSED
/**
 * Gate 750 — Canonicalize → shard → register pipeline.
 *
 * Takes a connector's DatasetBatch, shards rows into content-addressed shards,
 * and registers via the gate-748 dataset registry (createDataset). Connectors
 * never touch scoring logic — this pipeline is the only place that writes
 * to the registry.
 */

import { sha256 } from "@crucible/crypto";
import { createDataset } from "./registry.js";
import type { Dataset } from "./registry.js";
import type { CanonicalRow, DatasetBatch, ModalityType } from "./canonical.js";
import type { Connector, ConnectorResult, DatasetRef } from "./connectors/base.js";
import type { Shard } from "./registry.js";

/** Result of running the pipeline. */
export interface PipelineResult {
  dataset: Dataset;
  shards: Shard[];
  batch: DatasetBatch;
}

/** Pipeline options. */
export interface PipelineOptions {
  /** Publisher address (stake-gated admission). */
  publisher: string;
  /** SPDX license identifier. */
  license: string;
  /** Provenance string. */
  provenance: string;
  /** Max rows per shard. Default 10_000. */
  maxRowsPerShard?: number;
  /** URI template for shard storage. {shardIndex} is replaced. */
  shardUriTemplate?: string;
}

/** Run the full pipeline: fetch → shard → register. */
export async function runPipeline(
  connector: Connector,
  ref: DatasetRef,
  options: PipelineOptions,
): Promise<PipelineResult> {
  const result: ConnectorResult = await connector.fetch(ref);
  const { batch } = result;

  // Shard rows into equal-sized chunks with content-addressed checksums.
  const maxRows = options.maxRowsPerShard ?? 10_000;
  const shards = shardRows(batch.rows, maxRows, options.shardUriTemplate);

  // Build manifest.
  const manifest: import("./registry.js").DatasetManifest = {
    name: ref.identifier,
    modality: batch.modality,
    schema: batch.schema,
    license: options.license,
    provenance: options.provenance,
    sourceHash: batch.checksum,
    shards,
    publisher: options.publisher,
  };

  const dataset = createDataset(manifest);

  return { dataset, shards, batch };
}

/** Shard rows into equal-sized chunks with content-addressed checksums. */
function shardRows(
  rows: CanonicalRow[],
  maxRowsPerShard: number,
  shardUriTemplate?: string,
): Shard[] {
  const shards: Shard[] = [];
  const total = rows.length;
  let index = 0;
  while (index < total) {
    const end = Math.min(index + maxRowsPerShard, total);
    const shardRows = rows.slice(index, end);
    const shardIndex = Math.floor(index / maxRowsPerShard);
    const shardId = sha256(
      JSON.stringify({
        shardIndex,
        rowCount: shardRows.length,
        firstRowId: shardRows[0]!.rowId,
        lastRowId: shardRows[shardRows.length - 1]!.rowId,
      }),
    );
    const checksum = sha256(
      JSON.stringify(shardRows.map((r) => r.rowId).join(",")),
    );
    const uri = shardUriTemplate
      ? shardUriTemplate.replace(/\{shardIndex\}/g, String(shardIndex))
      : undefined;
    shards.push({
      shardId,
      size: shardRows.length,
      checksum,
      uri,
    });
    index = end;
  }
  return shards;
}
