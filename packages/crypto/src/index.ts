/**
 * Gate 625 — One crypto door.
 *
 * Every hash/encrypt/sign call site routes through this module. Grep-gate
 * bans direct `crypto.createHash`/keccak imports anywhere else. This module
 * is also the PQC migration seam: swap primitives in one file, not one hundred.
 */

import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import type { Primitive, PrimitiveEntry } from "./primitives.js";
import type { HybridKeyPair, HybridCiphertext } from "./hybrid.js";
import { PRIMITIVES, getPrimitive, assertPrimitivesComplete } from "./primitives.js";
import { jcsHash, hashEnvelope, jcsCanonicalize } from "./jcs.js";
import {
  generateHybridKeyPair,
  hybridEncrypt,
  hybridDecrypt,
  LONGEVITY_MODE,
} from "./hybrid.js";

/** Banned primitive imports — any direct use of node:crypto outside this module fails CI. */
export const BANNED_CRYPTO_CALLS = ["createHash", "createHmac", "createCipher", "createCipheriv", "createDecipher", "createDecipheriv", "randomBytes"];

/**
 * Hash a message with SHA-256. The one allowed hash entry point.
 * Use jcsHash for canonical JSON hashing.
 */
export function sha256(data: string | Uint8Array): string {
  const input = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Hash a message with keccak256.
 * In v1 this delegates to SHA-256 with a domain separator; production swaps
 * in a vetted keccak256 implementation here (one file, gate 625).
 */
export function keccak256(data: string | Uint8Array): string {
  const input = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return createHash("sha256").update(new TextEncoder().encode("keccak256-v1:")).update(input).digest("hex");
}

/**
 * Canonicalize + hash a JSON object via JCS + SHA-256 (gate 629).
 * Use this for claims, verdicts, span envelopes, model rows.
 */
export function hashCanonical(value: unknown): string {
  return jcsHash(value);
}

/** Generate cryptographically secure random bytes (CSPRNG only, gate 633). */
export function randomBytesN(n: number): Uint8Array {
  return randomBytes(n);
}

/** Generate a hybrid key pair (gate 636). */
export function createKeyPair(): HybridKeyPair {
  return generateHybridKeyPair();
}

/** Encrypt with hybrid AEAD (gate 636). */
export function encrypt(publicKey: Uint8Array, plaintext: Uint8Array): HybridCiphertext {
  return hybridEncrypt(publicKey, plaintext);
}

/** Decrypt with hybrid AEAD (gate 636). */
export function decrypt(secretKey: Uint8Array, ciphertext: HybridCiphertext): Uint8Array {
  return hybridDecrypt(secretKey, ciphertext);
}

/** Whether the longevity (PQC) flag is on (gate 636). */
export function isLongevityMode(): boolean {
  return LONGEVITY_MODE;
}

/** Assert the primitives table covers all used primitives (gate 624). */
export function assertPrimitivesCovered(used: Primitive[]): void {
  assertPrimitivesComplete(used);
}

/** List all primitives in the locked table (gate 624). */
export function listPrimitives(): typeof PRIMITIVES {
  return PRIMITIVES;
}

/** Look up a primitive entry (gate 624). */
export function getPrimitiveEntry(primitive: Primitive): PrimitiveEntry | undefined {
  return getPrimitive(primitive);
}

export type { Primitive, HybridKeyPair, HybridCiphertext };
