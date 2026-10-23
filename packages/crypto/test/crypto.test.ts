import { describe, expect, it } from "vitest";
import {
  sha256,
  keccak256,
  hashCanonical,
  randomBytesN,
  createKeyPair,
  encrypt,
  decrypt,
  isLongevityMode,
  listPrimitives,
  getPrimitiveEntry,
  assertPrimitivesCovered,
} from "../src/index.js";
import { jcsHash, jcsCanonicalize } from "../src/jcs.js";

describe("One crypto door (gate 625)", () => {
  it("sha256 is deterministic", () => {
    expect(sha256("hello")).toBe(sha256("hello"));
    expect(sha256("hello")).not.toBe(sha256("world"));
  });

  it("keccak256 is deterministic", () => {
    expect(keccak256("hello")).toBe(keccak256("hello"));
    expect(keccak256("hello")).not.toBe(sha256("hello"));
  });

  it("hashCanonical uses JCS + SHA-256 (gate 629)", () => {
    const a = { b: 2, a: 1, c: 3 };
    const b = { a: 1, b: 2, c: 3 };
    // JCS canonicalization: key reordering must not change the digest
    expect(hashCanonical(a)).toBe(hashCanonical(b));
    expect(jcsCanonicalize(a)).toBe(jcsCanonicalize(b));
  });

  it("key order does not affect JCS hash (gate 629 / canonicalization suite)", () => {
    expect(jcsHash({ z: 1, a: 2 })).toBe(jcsHash({ a: 2, z: 1 }));
  });
});

describe("Primitives table (gate 624)", () => {
  it("lists all primitives", () => {
    const primitives = listPrimitives();
    expect(primitives.length).toBeGreaterThan(0);
    expect(primitives.find((p) => p.primitive === "keccak256")).toBeDefined();
    expect(primitives.find((p) => p.primitive === "secp256k1")).toBeDefined();
  });

  it("getPrimitiveEntry returns the right entry", () => {
    const entry = getPrimitiveEntry("keccak256");
    expect(entry?.primitive).toBe("keccak256");
    expect(entry?.usedFor).toContain("on-chain hashes");
  });

  it("assertPrimitivesCovered passes for known primitives", () => {
    expect(() => assertPrimitivesCovered(["keccak256", "sha256", "csprng"])).not.toThrow();
  });

  it("assertPrimitivesCovered throws for unknown primitives", () => {
    expect(() => assertPrimitivesCovered(["made-up-cipher"] as any)).toThrow();
  });
});

describe("Hybrid AEAD (gate 636)", () => {
  it("encrypt then decrypt round-trips", () => {
    const { publicKey, secretKey } = createKeyPair();
    const plaintext = new TextEncoder().encode("secret message");
    const ct = encrypt(publicKey, plaintext);
    const decrypted = decrypt(secretKey, ct);
    expect(new TextDecoder().decode(decrypted)).toBe("secret message");
  });

  it("longevity mode is off by default (Anvil demo)", () => {
    expect(isLongevityMode()).toBe(false);
  });

  it("produces a HybridCiphertext with encapsulatedKey, nonce, ciphertext", () => {
    const { publicKey } = createKeyPair();
    const ct = encrypt(publicKey, new TextEncoder().encode("x"));
    expect(ct.encapsulatedKey).toBeInstanceOf(Uint8Array);
    expect(ct.nonce).toBeInstanceOf(Uint8Array);
    expect(ct.ciphertext).toBeInstanceOf(Uint8Array);
  });
});

describe("CSPRNG (gate 633)", () => {
  it("randomBytesN returns secure random bytes", () => {
    const a = randomBytesN(32);
    const b = randomBytesN(32);
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    expect(a.some((v, i) => v !== b[i])).toBe(true); // almost certainly different
  });
});
