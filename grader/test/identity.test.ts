import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  buildIdentity,
  verifyShards,
  verifyConfigHash,
  checkIdentityDrift,
  merkleRoot,
  identityHash,
  IDENTITY_ERRORS,
  validateManifest,
  type ModelManifest,
  type Shard,
} from "../src/eval/identity.js";

function digestOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const VALID_MANIFEST: ModelManifest = {
  modelId: "verifier-7b",
  revision: "r1",
  quantization: "fp16",
  shards: [
    { path: "shard-000.bin", size: 100, digest: digestOf("content-a") },
    { path: "shard-001.bin", size: 200, digest: digestOf("content-b") },
  ],
  configHash: "config-hash-123",
  tokenizerId: "tok-v1",
};

function shardContent(path: string, size: number, content: string): { size: number; content: Uint8Array } {
  return { size, content: new TextEncoder().encode(content) };
}

describe("Model identity (P0)", () => {
  it("builds a valid identity from a manifest", () => {
    const id = buildIdentity(VALID_MANIFEST);
    expect(id.modelId).toBe("verifier-7b");
    expect(id.identityHash).toBeTruthy();
    expect(id.weightRoot).toBeTruthy();
  });

  it("merkle root is stable to shard order", () => {
    const ordered = VALID_MANIFEST.shards;
    const reversed = [...VALID_MANIFEST.shards].reverse();
    expect(merkleRoot(ordered)).toBe(merkleRoot(reversed));
  });

  it("one flipped byte changes identity hash", () => {
    const base = buildIdentity(VALID_MANIFEST);
    const mutated = {
      ...VALID_MANIFEST,
      shards: [
        { ...VALID_MANIFEST.shards[0], digest: "digest-a-mutated" },
        VALID_MANIFEST.shards[1],
      ],
    };
    const mutatedId = buildIdentity(mutated);
    expect(mutatedId.identityHash).not.toBe(base.identityHash);
    expect(mutatedId.weightRoot).not.toBe(base.weightRoot);
  });

  it("rejects path traversal", () => {
    const bad = { ...VALID_MANIFEST, shards: [{ ...VALID_MANIFEST.shards[0], path: "../etc/passwd" }] };
    expect(() => validateManifest(bad)).toThrow(IDENTITY_ERRORS.PATH_TRAVERSAL);
  });

  it("rejects absolute paths", () => {
    const bad = { ...VALID_MANIFEST, shards: [{ ...VALID_MANIFEST.shards[0], path: "/etc/passwd" }] };
    expect(() => validateManifest(bad)).toThrow(IDENTITY_ERRORS.ABSOLUTE_PATH);
  });

  it("rejects duplicate shard paths", () => {
    const bad = {
      ...VALID_MANIFEST,
      shards: [VALID_MANIFEST.shards[0], { ...VALID_MANIFEST.shards[0] }],
    };
    expect(() => validateManifest(bad)).toThrow(IDENTITY_ERRORS.DUPLICATE_PATH);
  });

  it("rejects zero-byte shards", () => {
    const bad = { ...VALID_MANIFEST, shards: [{ ...VALID_MANIFEST.shards[0], size: 0 }] };
    expect(() => validateManifest(bad)).toThrow(IDENTITY_ERRORS.ZERO_BYTE_SHARD);
  });

  it("rejects unknown quantization", () => {
    const bad = { ...VALID_MANIFEST, quantization: "int2" as const };
    expect(() => validateManifest(bad)).toThrow(IDENTITY_ERRORS.UNKNOWN_QUANTIZATION);
  });

  it("verifyShards: missing shard throws", () => {
    const actual = new Map([["shard-001.bin", shardContent("shard-001.bin", 200, "b")]]);
    expect(() => verifyShards(VALID_MANIFEST, actual)).toThrow(IDENTITY_ERRORS.MISSING_SHARD);
  });

  it("verifyShards: size mismatch throws", () => {
    const actual = new Map([
      ["shard-000.bin", shardContent("shard-000.bin", 999, "a")],
      ["shard-001.bin", shardContent("shard-001.bin", 200, "b")],
    ]);
    expect(() => verifyShards(VALID_MANIFEST, actual)).toThrow(IDENTITY_ERRORS.SIZE_MISMATCH);
  });

  it("verifyShards: hash mismatch throws", () => {
    const actual = new Map([
      ["shard-000.bin", shardContent("shard-000.bin", 100, "wrong-content")],
      ["shard-001.bin", shardContent("shard-001.bin", 200, "b")],
    ]);
    expect(() => verifyShards(VALID_MANIFEST, actual)).toThrow(IDENTITY_ERRORS.HASH_MISMATCH);
  });

  it("verifyShards: extra shard throws", () => {
    const actual = new Map([
      ["shard-000.bin", shardContent("shard-000.bin", 100, "content-a")],
      ["shard-001.bin", shardContent("shard-001.bin", 200, "content-b")],
      ["shard-002.bin", shardContent("shard-002.bin", 50, "content-c")],
    ]);
    expect(() => verifyShards(VALID_MANIFEST, actual)).toThrow(IDENTITY_ERRORS.EXTRA_SHARD);
  });

  it("verifyConfigHash: mismatch throws", () => {
    expect(() => verifyConfigHash(VALID_MANIFEST, "wrong-config")).toThrow(IDENTITY_ERRORS.CONFIG_HASH_MISMATCH);
  });

  it("checkIdentityDrift: same identity OK, different throws", () => {
    const id = buildIdentity(VALID_MANIFEST);
    expect(() => checkIdentityDrift(null, id)).not.toThrow();
    expect(() => checkIdentityDrift(id, id)).not.toThrow();
    const other = { ...id, identityHash: "different" };
    expect(() => checkIdentityDrift(id, other)).toThrow(IDENTITY_ERRORS.IDENTITY_MISMATCH);
  });
});
