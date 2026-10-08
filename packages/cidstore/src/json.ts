/**
 * Canonical JSON, for content that is an object rather than an opaque payload.
 *
 * A CID commits to bytes, so two processes that serialize the same artifact
 * differently compute two different ids for it — the runner publishes one, Argus
 * looks up the other, and the claim reads as missing content. Sorted keys and no
 * insignificant whitespace is the cheapest way to make "same object" mean "same
 * bytes". This is deliberately *not* RFC 8785 JCS: `runHash` in `@crucible/smith`
 * is JCS because the contract recomputes it, whereas here the only requirement is
 * that every writer in this system agrees on one form, so the smaller rule set
 * (stringify leaves exactly as JSON does, objects in key order) is enough and has
 * no BigInt/number-formatting surface to get wrong.
 */

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

export function canonicalJson(value: unknown): string {
  return encode(value, new Set<object>());
}

function encode(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`not a JSON number: ${String(value)}`);
      }
      return JSON.stringify(value);
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw new CanonicalJsonError(`not JSON-representable: ${typeof value}`);
    default:
      break;
  }

  const object = value as object;
  if (seen.has(object)) throw new CanonicalJsonError("cyclic structure cannot be canonicalized");
  const nested = new Set(seen).add(object);

  if (Array.isArray(object)) return `[${object.map((item) => encode(item, nested)).join(",")}]`;
  if (object instanceof Uint8Array) {
    throw new CanonicalJsonError("bytes have no JSON form; put them with put() directly");
  }
  if (Object.getPrototypeOf(object) !== Object.prototype && Object.getPrototypeOf(object) !== null) {
    throw new CanonicalJsonError(`cannot canonicalize a ${Object.prototype.toString.call(object)}`);
  }

  const record = object as Record<string, unknown>;
  // An explicitly-undefined key is dropped, as JSON.stringify drops it: the alternative
  // is for a field an artifact does not carry to change its own content id.
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const body = keys.map((key) => `${JSON.stringify(key)}:${encode(record[key], nested)}`).join(",");
  return `{${body}}`;
}
