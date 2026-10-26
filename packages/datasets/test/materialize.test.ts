import { describe, expect, it } from "vitest";
import {
  probeSpecHash,
  materializeProbe,
  evaluateSymbolic,
  safeEval,
  type ProbeSpec,
  type DerivationSpec,
  type MaterializedProbe,
} from "../src/materialize.js";
import {
  createSplitEngine,
  type SplitRole,
} from "../src/splits.js";
import { createDataset, type Dataset } from "../src/registry.js";
import type { CanonicalRow } from "../src/canonical.js";

function row(id: string, fields: Record<string, unknown>): CanonicalRow {
  return { rowId: id, fields, modality: [] };
}

function makeSpec(
  datasetId: string,
  split: SplitRole,
  derivation: DerivationSpec,
  rowKeys?: string[],
): ProbeSpec {
  return {
    datasetId,
    datasetVersion: "v1",
    split,
    derivation,
    rowKeys,
  };
}

describe("probe materializer (gate 752)", () => {
  const dataset: Dataset = createDataset({
    name: "symbolic-regression",
    modality: "text",
    schema: "x,y",
    license: "MIT",
    provenance: "test",
    sourceHash: "0x" + "aa".repeat(32),
    shards: [
      { shardId: "s1", size: 6, checksum: "0x" + "11".repeat(32) },
    ],
    publisher: "0x" + "22".repeat(20),
  });

  const rows = [
    row("r1", { x: "1", y: "2" }),
    row("r2", { x: "2", y: "4" }),
    row("r3", { x: "3", y: "6" }),
    row("r4", { x: "4", y: "8" }),
    row("r5", { x: "5", y: "10" }),
    row("r6", { x: "6", y: "12" }),
  ];

  const splitEngine = createSplitEngine(dataset.datasetId, {
    splitKey: "rowId",
    seed: "test-seed",
  });

  // Determine which rows are in each split
  const trainRowIds = rows.filter((r) => splitEngine.roleFor(r.rowId) === "train").map((r) => r.rowId);

  it("probeSpecHash is deterministic", () => {
    const spec = makeSpec(dataset.datasetId, "train", {
      inputColumn: "x",
      outputColumn: "y",
      kind: "symbolic",
    });
    const h1 = probeSpecHash(spec);
    const h2 = probeSpecHash(spec);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("materializes train-split probes only", () => {
    const spec = makeSpec(dataset.datasetId, "train", {
      inputColumn: "x",
      outputColumn: "y",
      template: "{{inputColumn}}",
      kind: "symbolic",
    });
    const probes = materializeProbe(spec, rows, splitEngine);
    expect(probes.length).toBeGreaterThan(0);
    for (const p of probes) {
      expect(p.split).toBe("train");
      expect(p.input).toMatch(/^-?\d+$/);
    }
  });

  it("materializes holdout-split probes only", () => {
    const trainSpec = makeSpec(dataset.datasetId, "train", {
      inputColumn: "x",
      outputColumn: "y",
      template: "{{inputColumn}}",
      kind: "symbolic",
    });
    const holdoutSpec = makeSpec(dataset.datasetId, "holdout", {
      inputColumn: "x",
      outputColumn: "y",
      template: "{{inputColumn}}",
      kind: "symbolic",
    });
    const trainProbes = materializeProbe(trainSpec, rows, splitEngine);
    const holdoutProbes = materializeProbe(holdoutSpec, rows, splitEngine);
    const trainIds = new Set(trainProbes.map((p) => p.sourceRowId));
    const holdoutIds = new Set(holdoutProbes.map((p) => p.sourceRowId));
    for (const id of trainIds) {
      expect(holdoutIds.has(id)).toBe(false);
    }
    const devSpec = makeSpec(dataset.datasetId, "dev", {
      inputColumn: "x",
      outputColumn: "y",
      template: "{{inputColumn}}",
      kind: "symbolic",
    });
    const devProbes = materializeProbe(devSpec, rows, splitEngine);
    const devIds = new Set(devProbes.map((p) => p.sourceRowId));
    expect(new Set([...trainIds, ...holdoutIds, ...devIds]).size).toBe(
      rows.length,
    );
  });

  it("honors rowKeys allowlist", () => {
    const spec = makeSpec(dataset.datasetId, "train", {
      inputColumn: "x",
      outputColumn: "y",
      template: "{{inputColumn}}",
      kind: "symbolic",
    }, ["r2"]);
    const probes = materializeProbe(spec, rows, splitEngine);
    const rowIds = new Set(probes.map((p) => p.sourceRowId));
    expect(rowIds.has("r2")).toBe(true);
    expect(rowIds.size).toBe(1);
  });

  it("throws on missing input column", () => {
    const spec = makeSpec(dataset.datasetId, "train", {
      inputColumn: "nonexistent",
      kind: "symbolic",
    });
    expect(() => materializeProbe(spec, rows, splitEngine)).toThrow(
      /not found in row/,
    );
  });

  it("safeEval evaluates basic arithmetic", () => {
    expect(safeEval("x + 1", 5)).toBe(6);
    expect(safeEval("2 * x", 3)).toBe(6);
    expect(safeEval("x ^ 2", 4)).toBe(16);
    expect(safeEval("(x + 1) / 2", 3)).toBe(2);
  });

  it("safeEval returns NaN for invalid expressions", () => {
    expect(safeEval("", 5)).toBe(NaN);
    expect(safeEval("foo()", 5)).toBe(NaN);
  });

  it("evaluateSymbolic scores correct expression perfectly", () => {
    const trainRowIds = rows.filter((r) => splitEngine.roleFor(r.rowId) === "train").map((r) => r.rowId);
    if (trainRowIds.length < 2) return;
    const holdoutProbes: MaterializedProbe[] = trainRowIds.slice(0, 2).map((id, i) => ({
      probeId: `p${i}`,
      input: id,
      expectedOutput: `${Number(id.replace("r", "")) + 1}`,
      derivation: { inputColumn: "x", outputColumn: "y", kind: "symbolic" },
      sourceRowId: id,
      split: "train",
    }));
    const result = evaluateSymbolic("x + 1", holdoutProbes);
    expect(result.passRate).toBe(1);
    expect(result.mse).toBe(0);
    expect(result.total).toBe(2);
  });

  it("evaluateSymbolic penalizes wrong expression", () => {
    const trainRowIds = rows.filter((r) => splitEngine.roleFor(r.rowId) === "train").map((r) => r.rowId);
    if (trainRowIds.length === 0) return;
    const holdoutProbes: MaterializedProbe[] = [
      {
        probeId: "p1",
        input: trainRowIds[0],
        expectedOutput: "2",
        derivation: { inputColumn: "x", outputColumn: "y", kind: "symbolic" },
        sourceRowId: trainRowIds[0],
        split: "train",
      },
    ];
    const result = evaluateSymbolic("x * 10", holdoutProbes);
    expect(result.passRate).toBe(0);
    expect(result.mse).toBeGreaterThan(0);
    expect(result.total).toBe(1);
  });
});
