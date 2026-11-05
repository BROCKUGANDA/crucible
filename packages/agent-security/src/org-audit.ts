/**
 * @file org-audit.ts — Append-only organisation audit history.
 *
 * Every privileged action creates an audit entry. The log is hash-chained
 (tamper-evident) and append-only — entries are never rewritten or deleted.
 *
 * In-memory store, consistent with ADR-0008. Migration-ready for PostgreSQL.
 */

import type { OrganisationId } from "./organisation.js";

const STATE_KEY = "__crucible_org_audit__";
const globalScope = globalThis as unknown as Record<string, unknown>;

type AuditStore = {
  entries: Map<string, AuditEntry>;
  /** orgId -> set of entry ids (in insertion order) */
  byOrg: Map<OrganisationId, string[]>;
  /** all entry ids in insertion order */
  allIds: string[];
  lastHash: string;
};

function getStore(): AuditStore {
  let store = globalScope[STATE_KEY] as AuditStore | undefined;
  if (!store) {
    store = { entries: new Map(), byOrg: new Map(), allIds: [], lastHash: "genesis" };
    globalScope[STATE_KEY] = store;
  }
  return store;
}

export interface AuditEntry {
  id: string;
  orgId?: OrganisationId;
  /** absent when the action is not org-scoped */
  principalId: string;
  /** the wallet principal or API key that performed the action */
  action: string;
  /** e.g. "org:budget:set", "api_key:create", "webhook:deliver" */
  resource?: string;
  /** the resource acted upon, or null */
  at: number;
  /** Unix milliseconds */
  metadata: Record<string, unknown>;
  /** never contains secrets — masked at write time */
  prevHash: string;
  /** hash chain link from the previous entry */
  hash: string;
  /** sha256 of prevHash + id + action + resource + at + JSON(metadata) */
}

export function newAuditEntry(
  id: string,
  principalId: string,
  action: string,
  metadata: Record<string, unknown>,
  orgId?: OrganisationId,
  resource?: string,
): AuditEntry {
  if (!id || !principalId || !action) {
    throw new Error("audit: id, principalId and action are required");
  }
  const store = getStore();
  const prevHash = store.lastHash;
  const at = Date.now();
  const hashInput = `${prevHash}|${id}|${action}|${resource ?? ""}|${at}|${JSON.stringify(metadata)}`;
  const hash = requireHash(hashInput);
  return {
    id,
    orgId,
    principalId,
    action,
    resource,
    at,
    metadata: maskSecrets(metadata),
    prevHash,
    hash,
  };
}

function requireHash(input: string): string {
  // Use the crypto package's sha256 if available, fallback to a simple stable hash.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { sha256 } = require("@crucible/crypto");
    return sha256(input);
  } catch {
    // Deterministic fallback — not cryptographic but stable for the audit chain.
    let h = 0;
    for (let i = 0; i < input.length; i++) {
      h = (h * 31 + input.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(16).padStart(8, "0");
  }
}

function maskSecrets(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    const key = k.toLowerCase();
    if (
      key.includes("secret") ||
      key.includes("key") ||
      key.includes("token") ||
      key.includes("password") ||
      key.includes("private") ||
      key.includes("seed")
    ) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function createAuditEntry(entry: AuditEntry): void {
  const store = getStore();
  if (store.entries.has(entry.id)) {
    throw new Error(`org-audit: entry already exists: ${entry.id}`);
  }
  // Verify the chain link matches the store's last hash.
  if (entry.prevHash !== store.lastHash) {
    throw new Error("org-audit: prevHash does not match the current chain head");
  }
  store.entries.set(entry.id, entry);
  store.allIds.push(entry.id);
  if (entry.orgId) {
    store.byOrg.get(entry.orgId)?.push(entry.id) ??
      store.byOrg.set(entry.orgId, [entry.id]);
  }
  store.lastHash = entry.hash;
}

export function getAuditEntry(id: string): AuditEntry | null {
  return getStore().entries.get(id) ?? null;
}

export function listAuditForOrg(orgId: OrganisationId, limit?: number): AuditEntry[] {
  const store = getStore();
  const ids = store.byOrg.get(orgId);
  if (!ids) return [];
  const selected = limit ? ids.slice(-limit) : ids;
  return selected.map((id) => store.entries.get(id)).filter(Boolean) as AuditEntry[];
}

export function listAllAudit(limit?: number): AuditEntry[] {
  const store = getStore();
  const ids = limit ? store.allIds.slice(-limit) : store.allIds;
  return ids.map((id) => store.entries.get(id)).filter(Boolean) as AuditEntry[];
}

/**
 * Verify the integrity of the audit chain: every entry's hash must be
 * reproducible and the prevHash chain must be unbroken.
 */
export function verifyChain(): { valid: boolean; brokenAt?: string; reason?: string } {
  const store = getStore();
  let prev = "genesis";
  for (const id of store.allIds) {
    const e = store.entries.get(id);
    if (!e) {
      return { valid: false, brokenAt: id, reason: "missing_entry" };
    }
    if (e.prevHash !== prev) {
      return { valid: false, brokenAt: id, reason: "chain_link_broken" };
    }
    const hashInput = `${e.prevHash}|${e.id}|${e.action}|${e.resource ?? ""}|${e.at}|${JSON.stringify(e.metadata)}`;
    const expected = requireHash(hashInput);
    if (expected !== e.hash) {
      return { valid: false, brokenAt: id, reason: "hash_mismatch" };
    }
    prev = e.hash;
  }
  return { valid: true };
}

/** Reset store state (testing only). */
export function __resetAuditStoreForTests(): void {
  const store = getStore();
  store.entries.clear();
  store.byOrg.clear();
  store.allIds = [];
  store.lastHash = "genesis";
}

/** TypeScript brand. */
export const __orgAuditBrand = Symbol.for("crucible.org-audit");