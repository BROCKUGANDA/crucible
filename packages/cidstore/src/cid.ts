/**
 * Content ids, computed the way IPFS computes them.
 *
 * The rest of Crucible accepts exactly two shapes as a CID — the two regexes in
 * `@crucible/smith`'s `types.ts`. Anyone can emit a string of that shape, which is why
 * they are worthless as a claim: a skeptic cannot tell a real id from a random one, and
 * Argus cannot fetch content it has no id for. So these functions are the real thing:
 * a sha2-256 multihash (`0x12 0x20 ‖ digest`) under CIDv0's bare base58btc, and the same
 * multihash under CIDv1's `version ‖ codec ‖ multihash` framing, base32-encoded with the
 * multibase `b` prefix. Feed them bytes, and any IPFS node in the world will resolve the
 * result to those same bytes.
 */

import { createHash } from "node:crypto";
import { base32Decode, base32Encode, base58Decode, base58Encode } from "./base.js";

/** multihash code for sha2-256, and the width of its digest. */
const SHA2_256_CODE = 0x12;
const SHA2_256_WIDTH = 0x20;
/** multicodec for raw bytes: what we store, since an artifact is an opaque payload. */
const CODEC_RAW = 0x55;
/** multicodec CIDv0 implies. v0 text carries no codec byte, but the spec says dag-pb. */
const CODEC_DAG_PB = 0x70;
const CID_V1_VERSION = 0x01;

/** The same two shapes `@crucible/smith` will sign and the chain will accept. */
const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1 = /^b[a-z2-7]{58}$/;

export type CidVersion = "v0" | "v1";

/** Everything the store and the CIDs are computed from: text, or the bytes behind it. */
export type Content = string | Uint8Array;

export class CidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CidError";
  }
}

export function toBytes(content: Content): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

export function sha256(content: Content): Uint8Array {
  return new Uint8Array(createHash("sha256").update(toBytes(content)).digest());
}

/** `code ‖ digest-length ‖ digest`, the multihash every CID ends with. */
export function multihash(content: Content): Uint8Array {
  const digest = sha256(content);
  const out = new Uint8Array(2 + digest.length);
  out[0] = SHA2_256_CODE;
  out[1] = digest.length;
  out.set(digest, 2);
  return out;
}

/** CIDv0: the multihash alone, base58btc. Always 46 characters starting "Qm". */
export function cidV0(content: Content): string {
  return cidV0FromMultihash(multihash(content));
}

/**
 * CIDv1 over the raw codec: `01 ‖ 55 ‖ multihash`, base32-lower, prefixed with the
 * multibase `b`. Always 59 characters starting "bafkrei".
 */
export function cidV1Raw(content: Content): string {
  return cidV1FromMultihash(multihash(content));
}

export function cid(content: Content, version: CidVersion = "v1"): string {
  return version === "v0" ? cidV0(content) : cidV1Raw(content);
}

/**
 * The id for bytes that are already hashed — how a multihash-only index recovers the
 * text form, and how the store turns its content key back into the id a caller wants.
 */
export function cidFromDigest(digest: Uint8Array | string, version: CidVersion = "v1"): string {
  const mh = multihashOf(typeof digest === "string" ? hexToBytes(digest) : digest);
  return version === "v0" ? cidV0FromMultihash(mh) : cidV1FromMultihash(mh);
}

function multihashOf(digest: Uint8Array): Uint8Array {
  if (digest.length !== SHA2_256_WIDTH) {
    throw new CidError(`sha2-256 digest must be ${SHA2_256_WIDTH} bytes, got ${digest.length}`);
  }
  const out = new Uint8Array(2 + digest.length);
  out[0] = SHA2_256_CODE;
  out[1] = SHA2_256_WIDTH;
  out.set(digest, 2);
  return out;
}

function cidV0FromMultihash(mh: Uint8Array): string {
  return base58Encode(mh);
}

function cidV1FromMultihash(mh: Uint8Array): string {
  const bytes = new Uint8Array(2 + mh.length);
  bytes[0] = CID_V1_VERSION;
  bytes[1] = CODEC_RAW;
  bytes.set(mh, 2);
  return `b${base32Encode(bytes)}`;
}

export interface CidParts {
  version: 0 | 1;
  /** the codec the id claims. v0 has no codec byte, so it is the one v0 means. */
  codec: number;
  /** the sha2-256 digest, without the multihash header. */
  digest: Uint8Array;
}

/**
 * Split a CID into version, codec and digest. `null` for anything that is not a
 * sha2-256 CID of the two shapes the system accepts — including a syntactically pretty
 * string whose bytes do not decode to a sha2-256 multihash, which is the part a regex
 * cannot check and a verifier must.
 */
export function tryDecodeCid(cid: string): CidParts | null {
  if (CID_V0.test(cid)) return decodeMultihash(base58DecodeSafe(cid), 0, CODEC_DAG_PB);
  if (!CID_V1.test(cid)) return null;
  const bytes = base32DecodeSafe(cid.slice(1));
  if (bytes === null || bytes.length < 4) return null;
  if (bytes[0] !== CID_V1_VERSION) return null;
  return decodeMultihash(bytes.subarray(2), 1, bytes[1]!);
}

export function decodeCid(cid: string): CidParts {
  const parts = tryDecodeCid(cid);
  if (parts === null) throw new CidError(`not a sha2-256 CID: ${cid}`);
  return parts;
}

function base58DecodeSafe(text: string): Uint8Array | null {
  try {
    return base58Decode(text);
  } catch {
    return null;
  }
}

function base32DecodeSafe(text: string): Uint8Array | null {
  try {
    return base32Decode(text);
  } catch {
    return null;
  }
}

function decodeMultihash(
  bytes: Uint8Array | null,
  version: 0 | 1,
  codec: number,
): CidParts | null {
  if (bytes === null || bytes.length !== 2 + SHA2_256_WIDTH) return null;
  if (bytes[0] !== SHA2_256_CODE || bytes[1] !== SHA2_256_WIDTH) return null;
  return { version, codec, digest: bytes.subarray(2) };
}

export function isCid(value: string): boolean {
  return tryDecodeCid(value) !== null;
}

/**
 * True when `cid` is the id of exactly these bytes.
 *
 * The comparison is on the digest, deliberately: what Argus needs to know is whether
 * the content it was given is the content the claim names. A v0 id is dag-pb by
 * definition and a v1 id says which codec was used, but neither changes the sha2-256 of
 * the payload we hold, and rejecting one spelling of a valid id would fail an honest
 * runner.
 */
export function verifyCid(cid: string, content: Content): boolean {
  const parts = tryDecodeCid(cid);
  if (parts === null) return false;
  return bytesEqual(parts.digest, sha256(content));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^([0-9a-fA-F]{2})*$/.test(hex)) throw new CidError(`not hex: ${hex}`);
  return new Uint8Array(Buffer.from(hex, "hex"));
}
