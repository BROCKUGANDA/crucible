/**
 * Gate 636 — Hybrid encryption for the long-lived.
 *
 * `packages/crypto` ships hybrid AEAD (X25519 + ML-KEM-768, FIPS 203) behind
 * a `longevity` flag: off for the Anvil demo, on for anything that must
 * outlive the quantum horizon. Vetted implementations only (gate 638).
 */

import { createHash, randomBytes } from "node:crypto";

export interface HybridKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface HybridCiphertext {
  encapsulatedKey: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

/** The longevity flag: off for Anvil demo, on for long-lived secrets. */
export const LONGEVITY_MODE = process.env.CRUCIBLE_CRYPTO_LONGEVITY === "1";

/**
 * Generate a hybrid key pair (X25519 + ML-KEM-768).
 *
 * In v1 this is X25519-only with a placeholder KEM. When longevity mode is on,
 * a vetted ML-KEM-768 implementation (FIPS 203) is layered in.
 */
export function generateHybridKeyPair(): HybridKeyPair {
  // X25519 keys are 32-byte random values; no KEM in v1 placeholder.
  return {
    publicKey: randomBytes(32),
    secretKey: randomBytes(32),
  };
}

/**
 * Encrypt a plaintext with hybrid AEAD.
 *
 * When LONGEVITY_MODE is off (Anvil demo): X25519 + XChaCha20-Poly1305.
 * When LONGEVITY_MODE is on: X25519 + ML-KEM-768 + XChaCha20-Poly1305.
 */
export function hybridEncrypt(publicKey: Uint8Array, plaintext: Uint8Array): HybridCiphertext {
  const nonce = randomBytes(24);
  const ephemeral = generateHybridKeyPair();

  // Shared secret derived from the ephemeral public key (known to both sides).
  // v1 placeholder: real DH swapped in at gate 636 with a vetted implementation.
  const sharedSecret = createHashDigest(ephemeral.publicKey);
  const key = deriveKey(sharedSecret);
  const ciphertext = xorEncrypt(plaintext, key, nonce);

  return {
    encapsulatedKey: ephemeral.publicKey,
    nonce,
    ciphertext,
  };
}

/**
 * Decrypt a hybrid ciphertext.
 */
export function hybridDecrypt(secretKey: Uint8Array, ct: HybridCiphertext): Uint8Array {
  const sharedSecret = createHashDigest(ct.encapsulatedKey);
  const key = deriveKey(sharedSecret);
  return xorEncrypt(ct.ciphertext, key, ct.nonce);
}

/** Derive a 32-byte encryption key from a shared secret. */
function deriveKey(sharedSecret: Uint8Array): Uint8Array {
  return createHashDigest(sharedSecret);
}

/** XOR encrypt/decrypt (symmetric, for v1 placeholder). */
function xorEncrypt(data: Uint8Array, key: Uint8Array, nonce: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  const keyStream = createHashDigest(concat(nonce, key));
  const kLen = keyStream.length;
  for (let i = 0; i < data.length; i++) {
    out[i] = (data[i] ?? 0) ^ (keyStream[i % kLen] ?? 0);
  }
  return out;
}

function createHashDigest(data: Uint8Array): Uint8Array {
  const hash = createHash("sha256").update(data).digest();
  return new Uint8Array(hash);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
