import { describe, expect, it } from "vitest";
import { batchChecksum, makeBatch, type CanonicalRow, type ModalityType } from "../src/canonical.js";

function row(id: string, fields: Record<string, unknown> = {}): CanonicalRow {
  return { rowId: id, fields, modality: [] };
}

describe("canonical format (gate 750)", () => {
  it("makeBatch produces a deterministic checksum", () => {
    const rows = [row("a", { x: 1 }), row("b", { x: 2 })];
    const b1 = makeBatch(rows, "schema-1", "text");
    const b2 = makeBatch(rows, "schema-1", "text");
    expect(b1.checksum).toBe(b2.checksum);
    expect(b1.rowCount).toBe(2);
    expect(b1.modality).toBe("text");
  });

  it("batchChecksum is sensitive to row content", () => {
    const a = makeBatch([row("a", { x: 1 })], "s", "text");
    const b = makeBatch([row("a", { x: 2 })], "s", "text");
    expect(a.checksum).not.toBe(b.checksum);
  });

  it("batchChecksum is sensitive to row order", () => {
    const a = makeBatch([row("a", { x: 1 }), row("b", { x: 2 })], "s", "text");
    const b = makeBatch([row("b", { x: 2 }), row("a", { x: 1 })], "s", "text");
    expect(a.checksum).not.toBe(b.checksum);
  });

  it("modality payloads are preserved in the batch", () => {
    const rows: CanonicalRow[] = [
      {
        rowId: "img-1",
        fields: { label: "cat" },
        modality: [
          {
            type: "image",
            uri: "ipfs://QmCat",
            checksum: "0x" + "aa".repeat(32),
            metadata: { width: 224, height: 224 },
          },
        ],
        metadata: { source: "dataset-v1" },
      },
    ];
    const batch = makeBatch(rows, "schema-img", "image");
    expect(batch.rows[0].modality).toHaveLength(1);
    expect(batch.rows[0].modality![0].type).toBe("image");
    expect(batch.modality).toBe("image");
  });

  it("empty batch is valid", () => {
    const batch = makeBatch([], "schema-empty", "text");
    expect(batch.rowCount).toBe(0);
    expect(batch.rows).toEqual([]);
    expect(batch.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("batchChecksum matches makeBatch.internal checksum", () => {
    const rows = [row("a", { x: 1 })];
    const batch = makeBatch(rows, "s", "text");
    expect(batch.checksum).toBe(batchChecksum({ rows, schema: "s", modality: "text", rowCount: 1 }));
  });

  it("ModalityType values are valid", () => {
    const valid: ModalityType[] = ["text", "image", "audio", "graph", "timeseries"];
    expect(valid.length).toBe(5);
  });
});
