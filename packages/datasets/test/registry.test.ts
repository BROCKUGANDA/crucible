import { describe, expect, it } from "vitest";
import {
  createDataset,
  verifyDatasetId,
  verifyManifestIntegrity,
  datasetSize,
} from "../src/registry.js";

function baseManifest(overrides: Partial<import("../src/registry.js").DatasetManifest> = {}) {
  return {
    name: "demo-dataset",
    modality: "tabular",
    schema: "ipfs://schema-cid",
    license: "MIT",
    provenance: "publisher-v1",
    sourceHash: "0x" + "aa".repeat(32),
    shards: [
      { shardId: "shard-1", size: 1000, checksum: "0x" + "11".repeat(32), uri: "ipfs://shard1" },
      { shardId: "shard-2", size: 2000, checksum: "0x" + "22".repeat(32), uri: "ipfs://shard2" },
    ],
    publisher: "0x" + "33".repeat(20),
    ...overrides,
  } as import("../src/registry.js").DatasetManifest;
}

describe("dataset registry (gate 748)", () => {
  it("computes a deterministic datasetId from the manifest", () => {
    const manifest = baseManifest();
    const ds1 = createDataset(manifest);
    const ds2 = createDataset(manifest);
    expect(ds1.datasetId).toBe(ds2.datasetId);
    expect(ds1.datasetId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("datasetId is content-derived — any manifest change changes the id", () => {
    const a = createDataset(baseManifest());
    const b = createDataset(baseManifest({ name: "changed" }));
    expect(a.datasetId).not.toBe(b.datasetId);
  });

  it("verifyDatasetId accepts valid and rejects tampered", () => {
    const ds = createDataset(baseManifest());
    expect(verifyDatasetId(ds)).toBe(true);
    const tampered = { ...ds, datasetId: "0x" + "00".repeat(32) };
    expect(verifyDatasetId(tampered)).toBe(false);
  });

  it("verifyManifestIntegrity rejects missing checksums", () => {
    const manifest = baseManifest({ shards: [{ shardId: "s1", size: 10 }] as never });
    expect(verifyManifestIntegrity(manifest)).toBe(false);
  });

  it("datasetSize reports shard count and total bytes", () => {
    const manifest = baseManifest();
    const size = datasetSize(manifest);
    expect(size.shardCount).toBe(2);
    expect(size.totalBytes).toBe(3000);
  });
});
