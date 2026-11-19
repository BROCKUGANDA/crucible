/**
 * @file hash.ts — canonical JSON + SHA-256.
 *
 * Allocation and vesting snapshots carry a `calculation_input_hash`, which is the
 * hash of the *inputs* the calculation consumed. That hash is only meaningful if
 * the same logical input always serialises to the same bytes: `JSON.stringify`
 * orders object keys by insertion, so two callers that build the same input in a
 * different order produce two different hashes for one calculation. Every
 * immutable snapshot would then look like a different calculation.
 *
 * So the canonical form sorts object keys recursively and renders numbers as
 * JSON numbers. Money never passes through here — amounts are integer strings or
 * bigints elsewhere — but a float in an input hash is a warning sign, not a
 * crash.
 */

import { createHash } from "node:crypto";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Deterministic JSON: object keys sorted, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
    return value;
  }
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry === undefined) continue;
      out[key] = canonicalise(entry);
    }
    return out;
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sha256Bytes(input: string | Uint8Array): Buffer {
  return createHash("sha256").update(input).digest();
}

/** The hash a calculation snapshot stores: hex SHA-256 over the canonical input. */
export function calculationInputHash(input: unknown): string {
  return sha256Hex(canonicalJson(input));
}