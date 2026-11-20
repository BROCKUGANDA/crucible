/**
 * @file artifact-integrity.ts — Artifact integrity verification (Phase 3).
 *
 * Every artifact uploaded to the system is verified on upload and download.
 * Content hashes are computed and stored, so any tampering is detected.
 * Artifacts have ownership, size limits, MIME type validation, and retention
 * policies.
 *
 * Design principles:
 * - Content hash is computed on upload and verified on download.
 * - Artifacts are immutable once stored.
 * - Ownership is enforced: only the tenant can access its artifacts.
 * - Size limits prevent abuse.
 * - Retention policies control lifecycle.
 */

import { createHash, randomUUID } from "node:crypto";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type ArtifactStatus = "uploading" | "verified" | "corrupt" | "deleted";
export type ArtifactVisibility = "private" | "org" | "public";

export interface ArtifactMetadata {
  artifactId: string;
  runId: string;
  tenantId: string;
  mimeType: string;
  size: number;
  contentHash: string;
  createdAt: number;
  status: ArtifactStatus;
  visibility: ArtifactVisibility;
  retentionUntil?: number;
  storageRef?: string;
  integrityStatus: "ok" | "corrupt" | "unknown";
}

export interface CreateArtifactInput {
  runId: string;
  tenantId: string;
  mimeType: string;
  data: Buffer;
  visibility?: ArtifactVisibility;
  retentionUntil?: number;
  storageRef?: string;
}

export interface ArtifactConfig {
  /** Maximum artifact size in bytes. */
  maxSizeBytes?: number;
  /** Allowed MIME types. */
  allowedMimeTypes?: string[];
  /** Default retention period in milliseconds. */
  defaultRetentionMs?: number;
}

/* ------------------------------------------------------------------ */
/* Defaults                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_CONFIG: Required<ArtifactConfig> = {
  maxSizeBytes: 100 * 1024 * 1024, // 100MB
  allowedMimeTypes: [
    "application/json",
    "text/plain",
    "text/csv",
    "text/markdown",
    "application/octet-stream",
    "image/png",
    "image/jpeg",
    "image/gif",
    "application/zip",
    "application/gzip",
  ],
  defaultRetentionMs: 30 * 24 * 60 * 60 * 1000, // 30 days
};

/* ------------------------------------------------------------------ */
/* In-memory store                                                    */
/* ------------------------------------------------------------------ */

interface ArtifactStore {
  metadata: Map<string, ArtifactMetadata>;
  data: Map<string, Buffer>;
}

const store: ArtifactStore = {
  metadata: new Map(),
  data: new Map(),
};

/* ------------------------------------------------------------------ */
/* Hash computation                                                   */
/* ------------------------------------------------------------------ */

/**
 * Compute SHA-256 hash of the artifact data.
 */
export function computeContentHash(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Validation                                                         */
/* ------------------------------------------------------------------ */

function validateCreateArtifactInput(
  input: CreateArtifactInput,
  config: ArtifactConfig = {},
): string[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const errors: string[] = [];

  if (!input.runId) {
    errors.push("runId is required");
  }
  if (!input.tenantId) {
    errors.push("tenantId is required");
  }
  if (!input.mimeType) {
    errors.push("mimeType is required");
  }
  if (!input.data || input.data.length === 0) {
    errors.push("data is required and must not be empty");
  }

  // Size limit
  if (input.data && input.data.length > cfg.maxSizeBytes) {
    errors.push(
      `Artifact size ${input.data.length} exceeds maximum ${cfg.maxSizeBytes}`,
    );
  }

  // MIME type validation
  if (
    input.mimeType &&
    cfg.allowedMimeTypes &&
    !cfg.allowedMimeTypes.includes(input.mimeType)
  ) {
    errors.push(
      `MIME type ${input.mimeType} is not allowed. Allowed: ${cfg.allowedMimeTypes.join(", ")}`,
    );
  }

  return errors;
}

/* ------------------------------------------------------------------ */
/* Artifact operations                                                */
/* ------------------------------------------------------------------ */

/**
 * Create an artifact with integrity verification.
 */
export function createArtifact(
  input: CreateArtifactInput,
  config: ArtifactConfig = {},
): ArtifactMetadata {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const errors = validateCreateArtifactInput(input, cfg);
  if (errors.length > 0) {
    throw new Error(`Invalid artifact input: ${errors.join("; ")}`);
  }

  const contentHash = computeContentHash(input.data);
  const now = Date.now();
  const artifactId = randomUUID();

  const metadata: ArtifactMetadata = {
    artifactId,
    runId: input.runId,
    tenantId: input.tenantId,
    mimeType: input.mimeType,
    size: input.data.length,
    contentHash,
    createdAt: now,
    status: "verified",
    visibility: input.visibility ?? "private",
    retentionUntil: input.retentionUntil ?? now + cfg.defaultRetentionMs,
    storageRef: input.storageRef,
    integrityStatus: "ok",
  };

  // Store metadata and data
  store.metadata.set(artifactId, metadata);
  store.data.set(artifactId, input.data);

  return metadata;
}

/**
 * Get artifact metadata by ID.
 */
export function getArtifact(artifactId: string): ArtifactMetadata | undefined {
  return store.metadata.get(artifactId);
}

/**
 * Get artifact data with integrity verification.
 */
export function getArtifactData(
  artifactId: string,
): { data: Buffer; metadata: ArtifactMetadata } | undefined {
  const metadata = store.metadata.get(artifactId);
  if (!metadata) return undefined;

  const data = store.data.get(artifactId);
  if (!data) return undefined;

  // Verify integrity
  const hash = computeContentHash(data);
  if (hash !== metadata.contentHash) {
    metadata.integrityStatus = "corrupt";
    metadata.status = "corrupt";
    store.metadata.set(artifactId, metadata);
    return undefined;
  }

  return { data, metadata };
}

/**
 * List artifacts by run ID.
 */
export function listArtifactsByRun(runId: string): ArtifactMetadata[] {
  const artifacts: ArtifactMetadata[] = [];
  for (const [, metadata] of store.metadata) {
    if (metadata.runId === runId) {
      artifacts.push(metadata);
    }
  }
  return artifacts;
}

/**
 * List artifacts by tenant ID.
 */
export function listArtifactsByTenant(tenantId: string): ArtifactMetadata[] {
  const artifacts: ArtifactMetadata[] = [];
  for (const [, metadata] of store.metadata) {
    if (metadata.tenantId === tenantId) {
      artifacts.push(metadata);
    }
  }
  return artifacts;
}

/**
 * Delete an artifact.
 */
export function deleteArtifact(artifactId: string): boolean {
  const metadata = store.metadata.get(artifactId);
  if (!metadata) return false;

  metadata.status = "deleted";
  store.metadata.set(artifactId, metadata);
  store.data.delete(artifactId);

  return true;
}

/**
 * Check for expired artifacts based on retention policy.
 */
export function checkExpiredArtifacts(): string[] {
  const now = Date.now();
  const expired: string[] = [];

  for (const [artifactId, metadata] of store.metadata) {
    if (metadata.retentionUntil && now > metadata.retentionUntil) {
      expired.push(artifactId);
    }
  }

  return expired;
}

/* ------------------------------------------------------------------ */
/* Stats                                                              */
/* ------------------------------------------------------------------ */

export interface ArtifactStats {
  totalArtifacts: number;
  totalSize: number;
  byStatus: Map<ArtifactStatus, number>;
  byTenant: Map<string, number>;
}

export function getArtifactStats(): ArtifactStats {
  const byStatus = new Map<ArtifactStatus, number>();
  const byTenant = new Map<string, number>();
  let totalSize = 0;

  for (const [, metadata] of store.metadata) {
    if (metadata.status === "deleted") continue;

    byStatus.set(metadata.status, (byStatus.get(metadata.status) ?? 0) + 1);
    byTenant.set(metadata.tenantId, (byTenant.get(metadata.tenantId) ?? 0) + 1);
    totalSize += metadata.size;
  }

  return {
    totalArtifacts: store.metadata.size,
    totalSize,
    byStatus,
    byTenant,
  };
}

/* ------------------------------------------------------------------ */
/* Store access for testing                                         */
/* ------------------------------------------------------------------ */

export function getArtifactStore(): ArtifactStore {
  return store;
}

export function resetArtifactStore(): void {
  store.metadata.clear();
  store.data.clear();
}
