// SPDX-License-Identifier: UNLICENSED
/**
 * Gate 750 — Manual upload connector.
 *
 * Accepts in-memory files (CSV/JSON/JSONL), parses them into canonical rows,
 * and emits a DatasetBatch. Used for operator-uploaded datasets and as the
 * reference implementation for the connector interface.
 */

import { sha256 } from "@crucible/crypto";
import { makeBatch, type CanonicalRow, type ModalityType } from "../canonical.js";
import { ConnectorError } from "./base.js";
import type {
  Connector,
  ConnectorConfig,
  ConnectorResult,
  DatasetRef,
} from "./base.js";

export interface ManualFile {
  name: string;
  /** Raw file bytes. */
  bytes: Uint8Array;
  mimeType?: string;
}

/** Configuration for the manual connector. */
export interface ManualConfig extends ConnectorConfig {
  files: ManualFile[];
}

export class ManualConnector implements Connector {
  readonly name = "manual";
  readonly version = "0.1.0";
  private config?: ManualConfig;

  async connect(config: ConnectorConfig): Promise<void> {
    if (!("files" in config)) {
      throw new ConnectorError("manual", "connect", "manual connector requires a files array", config);
    }
    this.config = config as ManualConfig;
  }

  async list(): Promise<DatasetRef[]> {
    if (!this.config) throw new ConnectorError("manual", "list", "not connected");
    return this.config.files.map((f) => ({
      source: this.name,
      identifier: f.name,
      options: { mimeType: f.mimeType },
    }));
  }

  async fetch(ref: DatasetRef): Promise<ConnectorResult> {
    if (!this.config) throw new ConnectorError("manual", ref.identifier, "not connected");
    const file = this.config.files.find((f) => f.name === ref.identifier);
    if (!file) {
      throw new ConnectorError("manual", ref.identifier, "file not found");
    }

    const batch = parseFile(file, ref);
    return { ref, batch };
  }

  async disconnect(): Promise<void> {
    this.config = undefined;
  }
}

/** Parse a manual file into a canonical batch. */
export function parseFile(file: ManualFile, ref: DatasetRef): ConnectorResult["batch"] {
  const mime = file.mimeType ?? "";
  const name = file.name.toLowerCase();

  let text: string;
  try {
    text = new TextDecoder().decode(file.bytes);
  } catch (err) {
    throw new ConnectorError("manual", file.name, "failed to decode file bytes", err);
  }

  let rows: CanonicalRow[];
  let schema: string;
  let modality: ModalityType;

  if (name.endsWith(".jsonl") || mime === "application/jsonl+text") {
    const parsed = parseJsonl(text);
    rows = parsed.records;
    schema = parsed.schema;
    modality = detectModalityFromRecords(parsed.records);
  } else if (name.endsWith(".json") || mime === "application/json") {
    const parsed = parseJson(text);
    rows = parsed.records;
    schema = parsed.schema;
    modality = detectModalityFromRecords(parsed.records);
  } else if (name.endsWith(".csv") || mime === "text/csv") {
    const parsed = parseCsv(text);
    rows = parsed.records;
    schema = parsed.schema;
    modality = "text";
  } else {
    throw new ConnectorError(
      "manual",
      file.name,
      `unsupported file type: ${file.name} (${mime || "no mime"})`,
    );
  }

  return makeBatch(rows, schema, modality);
}

/** Parse JSONL: one JSON object per line. */
function parseJsonl(text: string): {
  records: CanonicalRow[];
  schema: string;
} {
  const records: CanonicalRow[] = [];
  let schema = "";
  let lineNo = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lineNo += 1;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch (err) {
      throw new ConnectorError("manual", `line ${lineNo}`, "invalid JSON", err);
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      throw new ConnectorError(
        "manual",
        `line ${lineNo}`,
        "expected a JSON object",
      );
    }
    const record = obj as Record<string, unknown>;
    const rowId = String(record.rowId ?? `row-${lineNo}`);
    const fields = { ...record };
    delete fields.rowId;
    if (lineNo === 1) schema = Object.keys(record).join(",");
    records.push({
      rowId,
      fields,
      modality: [],
      metadata: { lineNo },
    });
  }
  return { records, schema };
}

/** Parse JSON: array of objects or single object with "rows" key. */
function parseJson(text: string): {
  records: CanonicalRow[];
  schema: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConnectorError("manual", "root", "invalid JSON", err);
  }

  let arr: unknown[];
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (typeof parsed === "object" && parsed !== null && "rows" in parsed) {
    arr = (parsed as { rows: unknown[] }).rows;
    if (!Array.isArray(arr)) {
      throw new ConnectorError("manual", "rows", "rows must be an array");
    }
  } else {
    arr = [parsed];
  }

  const records: CanonicalRow[] = [];
  let schema = "";
  arr.forEach((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ConnectorError("manual", `row ${i}`, "expected a JSON object");
    }
    const record = item as Record<string, unknown>;
    const rowId = String(record.rowId ?? `row-${i}`);
    const fields = { ...record };
    delete fields.rowId;
    if (i === 0) schema = Object.keys(record).join(",");
    records.push({
      rowId,
      fields,
      modality: [],
      metadata: { lineNo: i + 1 },
    });
  });
  return { records, schema };
}

/** Parse CSV (simple, no quoted fields with embedded commas/newlines). */
function parseCsv(text: string): {
  records: CanonicalRow[];
  schema: string;
} {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { records: [], schema: "" };
  }
  const header = (lines[0] ?? "").split(",").map((h) => h.trim());
  const records: CanonicalRow[] = [];
  let schema = "";
  lines.slice(1).forEach((line, i) => {
    const values = line.split(",").map((v) => v.trim());
    const record: Record<string, unknown> = {};
    header.forEach((h, idx) => {
      record[h] = values[idx] ?? "";
    });
    const rowId = String(record.rowId ?? `row-${i + 1}`);
    const fields = { ...record };
    delete fields.rowId;
    if (i === 0) schema = header.join(",");
    records.push({
      rowId,
      fields,
      modality: [],
      metadata: { lineNo: i + 2 },
    });
  });
  return { records, schema };
}

/** Detect modality from record contents (heuristic). */
function detectModalityFromRecords(records: CanonicalRow[]): ModalityType {
  if (records.length === 0) return "text";
  // Sample first few records for modality hints.
  const sample = records.slice(0, Math.min(5, records.length));
  for (const rec of sample) {
    for (const [, value] of Object.entries(rec.fields)) {
      if (typeof value === "string") {
        const s = value as string;
        // Looks like a data URI or content address.
        if (/^(data:image|data:audio)/i.test(s)) return s.startsWith("data:image") ? "image" : "audio";
        if (/^(ipfs:\/\/|s3:\/\/|https?:\/\/.*\.(png|jpg|jpeg|gif|webp))$/i.test(s)) return "image";
        if (/^(ipfs:\/\/|s3:\/\/|https?:\/\/.*\.(mp3|wav|ogg|flac))$/i.test(s)) return "audio";
      }
    }
  }
  return "text";
}
