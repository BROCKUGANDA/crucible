import { describe, expect, it } from "vitest";
import { runPipeline, type PipelineOptions, type PipelineResult } from "../src/pipeline.js";
import {
  type Connector,
  ConnectorResult,
  DatasetRef,
  type ConnectorConfig,
} from "../src/connectors/base.js";
import { makeBatch, type CanonicalRow } from "../src/canonical.js";

function row(id: string, fields: Record<string, unknown> = {}): CanonicalRow {
  return { rowId: id, fields, modality: [] };
}

class MockConnector implements Connector {
  readonly name = "mock";
  readonly version = "0.1.0";
  private batches: Map<string, ConnectorResult> = new Map();

  setBatch(ref: DatasetRef, rows: CanonicalRow[], schema = "s", modality = "text") {
    this.batches.set(ref.identifier, {
      ref,
      batch: makeBatch(rows, schema, modality),
    });
  }

  async connect(_config: ConnectorConfig): Promise<void> {
    // no-op
  }
  async list(): Promise<DatasetRef[]> {
    return Array.from(this.batches.values()).map((r) => r.ref);
  }
  async fetch(ref: DatasetRef): Promise<ConnectorResult> {
    const result = this.batches.get(ref.identifier);
    if (!result) throw new Error(`mock: no batch for ${ref.identifier}`);
    return result;
  }
  async disconnect(): Promise<void> {
    // no-op
  }
}

const options: PipelineOptions = {
  publisher: "0x" + "11".repeat(20),
  license: "MIT",
  provenance: "test-pipeline",
};

describe("pipeline (gate 750)", () => {
  it("registers a dataset and creates shards", async () => {
    const connector = new MockConnector();
    connector.setBatch(
      { source: "mock", identifier: "ds-1" },
      [row("r1", { v: 1 }), row("r2", { v: 2 }), row("r3", { v: 3 })],
    );

    const result = await runPipeline(connector, { source: "mock", identifier: "ds-1" }, options);

    expect(result.dataset.datasetId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.dataset.manifest.name).toBe("ds-1");
    expect(result.dataset.manifest.publisher).toBe(options.publisher);
    expect(result.dataset.manifest.shards.length).toBe(1);
    expect(result.dataset.manifest.shards[0].size).toBe(3);
    expect(result.dataset.manifest.shards[0].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(result.batch.rowCount).toBe(3);
    expect(result.batch.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("splits into multiple shards when rows exceed maxRowsPerShard", async () => {
    const connector = new MockConnector();
    const rows = Array.from({ length: 25 }, (_, i) => row(`r${i}`, { v: i }));
    connector.setBatch({ source: "mock", identifier: "ds-big" }, rows);

    const result = await runPipeline(connector, { source: "mock", identifier: "ds-big" }, {
      ...options,
      maxRowsPerShard: 10,
    });

    expect(result.dataset.manifest.shards.length).toBe(3);
    expect(result.dataset.manifest.shards[0].size).toBe(10);
    expect(result.dataset.manifest.shards[1].size).toBe(10);
    expect(result.dataset.manifest.shards[2].size).toBe(5);
    // Shard IDs are unique.
    const ids = result.dataset.manifest.shards.map((s) => s.shardId);
    expect(new Set(ids).size).toBe(3);
  });

  it("uses shardUriTemplate when provided", async () => {
    const connector = new MockConnector();
    connector.setBatch({ source: "mock", identifier: "ds-uri" }, [row("r1")]);

    const result = await runPipeline(connector, { source: "mock", identifier: "ds-uri" }, {
      ...options,
      shardUriTemplate: "s3://bucket/shards/{shardIndex}",
    });

    expect(result.dataset.manifest.shards[0].uri).toBe("s3://bucket/shards/0");
  });

  it("verifyDatasetId passes for the registered dataset", async () => {
    const { verifyDatasetId } = await import("../src/registry.js");
    const connector = new MockConnector();
    connector.setBatch({ source: "mock", identifier: "ds-verify" }, [row("r1")]);
    const result = await runPipeline(connector, { source: "mock", identifier: "ds-verify" }, options);
    expect(verifyDatasetId(result.dataset)).toBe(true);
  });

  it("runPipeline propagates connector fetch errors", async () => {
    const connector = new MockConnector();
    await expect(
      runPipeline(connector, { source: "mock", identifier: "missing" }, options),
    ).rejects.toThrow(/no batch for missing/);
  });
});
