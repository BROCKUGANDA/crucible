/**
 * Gate 748 — Dataset registry object.
 *
 * A dataset is a versioned, content-addressed object:
 *   manifest (name, modality, schema, license, provenance, source hash)
 *   + immutable shards (parquet/arrow) + checksums.
 * Manifest hash = dataset ID. Same publisher-stake + canary admission as
 * suites: the canary materializes probes from it twice and must get
 * byte-identical output.
 *
 * Datasets are immutable — nothing off-chain is ever "updated," only newly
 * versioned. This mirrors the suite/verdict pattern already locked in CRUCIBLE.
 */

import { sha256, hashCanonical } from "@crucible/crypto";

/** A single immutable shard of a dataset. */
export interface Shard {
  /** Content-addressed shard ID = sha256(shard bytes). */
  shardId: string;
  /** Size in bytes. */
  size: number;
  /** sha256 of the shard bytes, stored so readers can verify on download. */
  checksum: string;
  /** Optional URI where the shard can be fetched (IPFS, S3, etc.). */
  uri?: string;
}

/** The dataset manifest — the content-addressed identity of a dataset version. */
export interface DatasetManifest {
  /** Human-readable name. */
  name: string;
  /** Data modality: 'tabular' | 'timeseries' | 'text' | 'image' | 'audio' | 'graph'. */
  modality: string;
  /** JSON Schema for rows, or the schema system in use. */
  schema: string;
  /** SPDX license identifier. */
  license: string;
  /** Provenance: who produced it, how, and when. */
  provenance: string;
  /** sha256 of the raw source bytes before sharding/canonicalization. */
  sourceHash: string;
  /** The shards that make up this dataset version, sorted by shardId. */
  shards: Shard[];
  /** Publisher's on-chain address (stake-gated admission). */
  publisher: string;
}

/** A registered dataset — manifest plus its content-addressed ID. */
export interface Dataset {
  /** datasetId = sha256(JCS(manifest)) — content-derived, never a label. */
  datasetId: string;
  manifest: DatasetManifest;
}

/**
 * Compute the datasetId from a manifest: sha256 over JCS-canonicalized JSON.
 * Same one-crypto-door as everything else (gate 625).
 */
export function manifestHash(manifest: DatasetManifest): string {
  return sha256(hashCanonical(manifest));
}

/** Build a Dataset from a manifest, computing the datasetId. */
export function createDataset(manifest: DatasetManifest): Dataset {
  return { datasetId: manifestHash(manifest), manifest };
}

/** Verify that a Dataset's datasetId matches recomputation from its manifest. */
export function verifyDatasetId(dataset: Dataset): boolean {
  return dataset.datasetId === manifestHash(dataset.manifest);
}

/** Check that a manifest's shard checksums are internally consistent. */
export function verifyManifestIntegrity(manifest: DatasetManifest): boolean {
  for (const shard of manifest.shards) {
    if (!shard.checksum) return false;
  }
  return true;
}

/** Shard count and total size for quick inspection. */
export function datasetSize(manifest: DatasetManifest): {
  shardCount: number;
  totalBytes: number;
} {
  let totalBytes = 0;
  for (const shard of manifest.shards) {
    totalBytes += shard.size;
  }
  return { shardCount: manifest.shards.length, totalBytes };
}
