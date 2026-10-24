/**
 * Gate 629 — JCS everywhere a hash is computed.
 *
 * Every hashed JSON object (claims, verdicts, span envelopes, model rows) is
 * canonicalized via RFC 8785 (JCS) first. The Arena canonicalization suite
 * tests the implementation that ships.
 */

import { createHash } from "node:crypto";

/**
 * Canonicalize a JSON value using JCS (RFC 8785).
 *
 * JCS rules:
 * - Objects: keys sorted lexicographically by Unicode code point
 * - Numbers: IEEE 754 double, serialized with minimal significant digits
 * - Strings: UTF-8, escaped per JSON
 * - Booleans: true/false
 * - null: null
 * - Arrays: order preserved
 *
 * This is a simplified implementation covering the subset CRUCIBLE uses.
 * For production, swap in a vetted JCS library (FIPS-vetted only, gate 638).
 */
export function jcsCanonicalize(value: unknown): string {
  return JSON.stringify(jcsTransform(value));
}

/** Hash a value canonically via JCS + SHA-256. */
export function jcsHash(value: unknown): string {
  const canonical = jcsCanonicalize(value);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function jcsTransform(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(jcsTransform);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = jcsTransform(obj[key]);
    }
    return result;
  }
  return value;
}

/** Canonicalize and hash a claim/verdict/span envelope. */
export function hashEnvelope(envelope: Record<string, unknown>): string {
  return jcsHash(envelope);
}
