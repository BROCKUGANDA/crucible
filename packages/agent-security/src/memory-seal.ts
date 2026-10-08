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
 * One link of the seal chain.
 *
 * Exposed because a bounded store has to fold the records it evicts into something it
 * keeps. Without that, dropping an old memory would silently change the seal of the
 * state that remains, and "the seal moved" would stop meaning "someone edited my past".
 */
export function chainStep(prev: string, r: MemoryRecord): string {
  return createHash("sha256")
    .update(
      `${prev}|${r.id}|${r.key}|${r.provenance}|${r.source ?? ""}|${r.at}|${r.immutable ? 1 : 0}|${canonical(r.value)}`,
    )
    .digest("hex");
}

export const SEAL_IV = "0".repeat(64);

/**
 * Seal the memory state. O(n) over records; the digest commits to every field of
 * every record, so changing a value, a provenance, a timestamp, or the ORDER of
 * memories yields a different seal.
 *
 * `from` lets a bounded store continue a chain it started before an eviction; callers
 * holding a complete record set never pass it.
 */
export function sealMemory(records: readonly MemoryRecord[], from = SEAL_IV): string {
  let chain = from;
  for (const r of ordered(records)) chain = chainStep(chain, r);
  return chain;
}

/** True when the records still hash to the seal they were checkpointed with. */
export function verifyMemorySeal(
  records: readonly MemoryRecord[],
  seal: string,
  from = SEAL_IV,
): boolean {
  return sealMemory(records, from) === seal;
}
