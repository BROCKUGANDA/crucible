/**
 * Model identity — weights are identity, not names.
 *
 * A model manifest carries one sha256 per weight shard. A merkle root is computed
 * over the sorted, domain-separated leaf digests so the root is stable regardless
 * of shard listing order. The full model identity hash binds modelId, revision,
 * quantization, weight root, config hash, and tokenizer id into one canonical
 * value recorded on every verdict.
 *
 * Flip one byte in one shard and the identity hash changes — silent quantization
 * swaps, republished checkpoints, and poison fine-tunes all become visible.
 * LoRA adapters pin the exact base weight root, never just the base name.
 *
 * Validation is fail-closed with named codes. The model registry refuses to
 * register the same modelId twice under different identity hashes — that is
 * identity drift, and it halts the run.
 */

import { createHash } from "node:crypto";

/** One weight shard: path, size in bytes, hex sha256 of contents. */
export interface Shard {
  path: string;
  size: number;
  digest: string;
}

/** Model manifest — content-derived identity. Names lie; bytes don't. */
export interface ModelManifest {
  modelId: string;
  revision: string;
  quantization: "fp16" | "bf16" | "int8" | "int4";
  shards: Shard[];
  configHash: string; // hex sha256 of the config JSON
  tokenizerId: string;
}

/** Computed, verified model identity — recorded on every verdict. */
export interface ModelIdentity {
  modelId: string;
  revision: string;
  quantization: string;
  weightRoot: string; // merkle root over sorted, domain-separated shard leaves
  configHash: string;
  tokenizerId: string;
  identityHash: string; // canonical hash of the whole bundle
}

export class IdentityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "IdentityError";
  }
}

export const IDENTITY_ERRORS = {
  MISSING_SHARD: "MISSING_SHARD",
  EXTRA_SHARD: "EXTRA_SHARD",
  SIZE_MISMATCH: "SIZE_MISMATCH",
  HASH_MISMATCH: "HASH_MISMATCH",
  ROOT_MISMATCH: "ROOT_MISMATCH",
  CONFIG_HASH_MISMATCH: "CONFIG_HASH_MISMATCH",
  IDENTITY_MISMATCH: "IDENTITY_MISMATCH",
  PATH_TRAVERSAL: "PATH_TRAVERSAL",
  ABSOLUTE_PATH: "ABSOLUTE_PATH",
  DUPLICATE_PATH: "DUPLICATE_PATH",
  ZERO_BYTE_SHARD: "ZERO_BYTE_SHARD",
  UNKNOWN_QUANTIZATION: "UNKNOWN_QUANTIZATION",
} as const;

const VALID_QUANTIZATIONS = new Set(["fp16", "bf16", "int8", "int4"]);

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Domain-separated leaf hash for a shard at its sorted position. */
function leafHash(index: number, shard: Shard): string {
  return sha256Hex(`shard:${index}:${shard.path}:${shard.size}:${shard.digest}`);
}

/** Merkle root over sorted, domain-separated shard leaves. Stable to shard order. */
export function merkleRoot(shards: readonly Shard[]): string {
  const sorted = [...shards].sort((a, b) => a.path.localeCompare(b.path));
  const leaves = sorted.map((s, i) => leafHash(i, s));
  if (leaves.length === 0) return sha256Hex("");
  let level = leaves;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256Hex(level[i] + (level[i + 1] ?? level[i]!)));
    }
    level = next;
  }
  return level[0]!;
}

/** Full identity hash: canonical hash over the identity bundle. */
export function identityHash(manifest: ModelManifest): string {
  const payload = {
    modelId: manifest.modelId,
    revision: manifest.revision,
    quantization: manifest.quantization,
    weightRoot: merkleRoot(manifest.shards),
    configHash: manifest.configHash,
    tokenizerId: manifest.tokenizerId,
  };
  return sha256Hex(JSON.stringify(payload));
}

/** Structural validation of a manifest (no file access). Throws IdentityError. */
export function validateManifest(manifest: ModelManifest): void {
  const paths: string[] = [];
  for (const shard of manifest.shards) {
    if (shard.path.includes("..")) {
      throw new IdentityError(IDENTITY_ERRORS.PATH_TRAVERSAL, `path traversal: ${shard.path}`);
    }
    if (shard.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(shard.path)) {
      throw new IdentityError(IDENTITY_ERRORS.ABSOLUTE_PATH, `absolute path: ${shard.path}`);
    }
    if (shard.size === 0) {
      throw new IdentityError(IDENTITY_ERRORS.ZERO_BYTE_SHARD, `zero-byte shard: ${shard.path}`);
    }
    paths.push(shard.path);
  }
  if (new Set(paths).size !== paths.length) {
    throw new IdentityError(IDENTITY_ERRORS.DUPLICATE_PATH, "duplicate shard path");
  }
  if (!VALID_QUANTIZATIONS.has(manifest.quantization)) {
    throw new IdentityError(IDENTITY_ERRORS.UNKNOWN_QUANTIZATION, manifest.quantization);
  }
}

/** Verify declared shard digests against actual shard contents. Fail-closed. */
export interface ShardContent {
  path: string;
  size: number;
  content: Uint8Array;
}

export function verifyShards(
  manifest: ModelManifest,
  actual: Map<string, ShardContent>,
): void {
  for (const shard of manifest.shards) {
    const a = actual.get(shard.path);
    if (!a) {
      throw new IdentityError(IDENTITY_ERRORS.MISSING_SHARD, shard.path);
    }
    if (a.size !== shard.size) {
      throw new IdentityError(IDENTITY_ERRORS.SIZE_MISMATCH, shard.path);
    }
    if (sha256Hex(a.content) !== shard.digest) {
      throw new IdentityError(IDENTITY_ERRORS.HASH_MISMATCH, shard.path);
    }
  }
  for (const path of actual.keys()) {
    if (!manifest.shards.some((s) => s.path === path)) {
      throw new IdentityError(IDENTITY_ERRORS.EXTRA_SHARD, path);
    }
  }
}

/** Verify declared config hash against actual config bytes. Fail-closed. */
export function verifyConfigHash(manifest: ModelManifest, config: string | Uint8Array): void {
  if (sha256Hex(config) !== manifest.configHash) {
    throw new IdentityError(IDENTITY_ERRORS.CONFIG_HASH_MISMATCH, manifest.modelId);
  }
}

/** Registry drift check: same modelId must never register under two identities. */
export function checkIdentityDrift(registered: ModelIdentity | null, current: ModelIdentity): void {
  if (registered && registered.identityHash !== current.identityHash) {
    throw new IdentityError(
      IDENTITY_ERRORS.IDENTITY_MISMATCH,
      `model ${current.modelId} identity drift: registered ${registered.identityHash}, current ${current.identityHash}`,
    );
  }
}

/** Build a ModelIdentity from a validated manifest. */
export function buildIdentity(manifest: ModelManifest): ModelIdentity {
  return {
    modelId: manifest.modelId,
    revision: manifest.revision,
    quantization: manifest.quantization,
    weightRoot: merkleRoot(manifest.shards),
    configHash: manifest.configHash,
    tokenizerId: manifest.tokenizerId,
    identityHash: identityHash(manifest),
  };
}
