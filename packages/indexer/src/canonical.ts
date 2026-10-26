import { keccak256, toBytes } from "viem";
import type { EventLike } from "./model.js";

/**
 * The canonical form of a projection value.
 *
 * Two replicas are only comparable if their *bytes* are comparable, and `JSON.stringify` is not a
 * canonical form: an object's keys come out in insertion order, a `Map` comes out as `{}`, a `Set`
 * comes out as `{}`, and a `bigint` throws. Insertion order is the killer here — a row built by
 * `TrialCreated` and the same row rebuilt by a later pass can hold the same fields in a different
 * order, and two projections that agree on every fact would then print different bytes. So keys are
 * sorted, maps and sets are emitted as sorted arrays, and a bigint is tagged so `1n` cannot read as
 * `1` or as `"1"`.
 *
 * Acyclic by construction: the read model holds rows, maps and arrays that nothing points back
 * into. A value with a cycle is a bug in whatever built it, and this recurses until the stack gives
 * out rather than emitting a truncated digest — a digest of a partial state is the one answer
 * worse than no answer, because it looks like a measurement.
 */
export function canonicalJson(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return `"@@n${value.toString(10)}"`;
  if (typeof value === "number") {
    // `JSON.stringify(NaN)` is `null`, which would make an unread number read as an absent one.
    return Number.isFinite(value) ? String(value) : `"@@num:${String(value)}"`;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
  if (value instanceof Map) return `{"@@map":[${mapEntries(value as Map<unknown, unknown>).join(",")}]}`;
  if (value instanceof Set) {
    return `{"@@set":[${[...value].map(encode).sort(compareStrings).join(",")}]}`;
  }
  if (typeof value === "object") {
    const fields = Object.entries(value as Record<string, unknown>)
      // An absent field and an explicitly-undefined one are the same state; a `null` is not.
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => compareStrings(a, b));
    return `{${fields.map(([k, v]) => `${JSON.stringify(k)}:${encode(v)}`).join(",")}}`;
  }
  // A function or a symbol has no canonical bytes, and inventing some would be a measurement
  // reported as empty. Name the type that arrived so the bug is findable.
  throw new Error(`canonicalJson: a ${typeof value} has no canonical form; nothing in a read model should hold one`);
}

function mapEntries(map: Map<unknown, unknown>): string[] {
  const entries = [...map.entries()];
  const numeric = entries.every(([k]) => typeof k === "number" && Number.isFinite(k));
  // Ids sort as numbers so the serialised model reads in the order a reader looks for; a mixed or
  // non-numeric key set falls back to the canonical bytes, which are always a total order.
  if (numeric) entries.sort((a, b) => (a[0] as number) - (b[0] as number));
  else entries.sort((a, b) => compareStrings(encode(a[0]), encode(b[0])));
  return entries.map(([k, v]) => `[${encode(k)},${encode(v)}]`);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The chain's own hash of a canonical form — reproducible with any tool that speaks keccak256. */
export function digestOf(text: string): `0x${string}` {
  return keccak256(toBytes(text));
}

/**
 * The identity of one emitted log, as a digest.
 *
 * The position alone is not enough. `(blockNumber, transactionHash, logIndex)` is unique among logs
 * a node really returned, but this repository's fixtures — and the `toEventLike` path that survives
 * an undecodable log — routinely hold several events at one position, and folding the digest of the
 * *emission* (position, name and decoded arguments together) keeps a fixture artifact from being
 * mistaken for a replay. Genuine re-delivery always carries every part of that tuple, so nothing
 * about the dedupe gets weaker.
 *
 * `chainId` is part of it because a log read at height 100 on two chains is two different facts. It
 * is optional on `EventLike` (a caller that has no chain in hand — a fixture, a replay buffer — does
 * not invent one), so an absent id folds to 0 rather than to a plausible-looking `undefined`.
 */
export function logDigest(ev: EventLike): string {
  return digestOf(
    canonicalJson([
      ev.chainId ?? 0,
      ev.blockNumber,
      ev.transactionHash.toLowerCase(),
      ev.logIndex,
      ev.address.toLowerCase(),
      ev.eventName,
      addressCaseInsensitive(ev.args),
    ]),
  );
}

/**
 * String arguments compared without case.
 *
 * Two indexers of one chain do not necessarily read the same bytes back: viem hands a decoded
 * `address` back EIP-55 checksummed, while another gateway returns it lowercase, and `getLogs` over
 * two proxies can differ in nothing else. An identity that depends on that spelling is an identity
 * two replicas cannot agree on, which is the exact failure this digest exists to prevent — and it
 * cannot merge two real emissions, because the position beside it is already unique per log.
 */
function addressCaseInsensitive(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    out[name] = typeof value === "string" ? value.toLowerCase() : value;
  }
  return out;
}
