/**
 * Memory integrity: a seal over the agent's memory state.
 *
 * The MemoryStore refuses *writes* that would spoof the record — chain facts are
 * immutable, untrusted provenance cannot overwrite them, and poisoned content is
 * dropped from context. What no write-guard can catch is a tampered store: memory that
 * is serialized, altered out-of-band, and replayed. A seal over the ordered record set
 * makes that forgery detectable — the agent seals its memory at checkpoints, and any
 * verification that fails means the past being remembered was edited.
 *
 * The chain order is (at, id): insertion order by wall clock, tie-broken by the store's
 * own monotonic id, so re-serializing the same state always seals identically.
 */

import { createHash } from "node:crypto";
import type { MemoryRecord } from "./injection.js";

/** Deterministic JSON: sorted object keys, arrays in order. Good enough to hash. */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

function ordered(records: readonly MemoryRecord[]): MemoryRecord[] {
  return [...records].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/**
 * Seal the memory state. O(n) over records; the digest commits to every field of
 * every record, so changing a value, a provenance, a timestamp, or the ORDER of
 * memories yields a different seal.
 */
export function sealMemory(records: readonly MemoryRecord[]): string {
  let chain = "0".repeat(64);
  for (const r of ordered(records)) {
    chain = createHash("sha256")
      .update(
        `${chain}|${r.id}|${r.key}|${r.provenance}|${r.source ?? ""}|${r.at}|${r.immutable ? 1 : 0}|${canonical(r.value)}`,
      )
      .digest("hex");
  }
  return chain;
}

/** True when the records still hash to the seal they were checkpointed with. */
export function verifyMemorySeal(records: readonly MemoryRecord[], seal: string): boolean {
  return sealMemory(records) === seal;
}
