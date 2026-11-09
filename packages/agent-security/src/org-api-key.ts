/**
 * @file org-api-key.ts — Scoped organisation API keys.
 *
 * A key is bound to an org, a role and a set of read paths. It cannot
 * authorise a write — writes require a wallet-signed SIWE session (ADR-0006).
 *
 * In-memory store, consistent with ADR-0008. Migration-ready for PostgreSQL.
 */

import type { OrganisationId } from "./organisation.js";
import { createHmac, timingSafeEqual } from "node:crypto";

const STATE_KEY = "__crucible_org_api_key__";
const globalScope = globalThis as unknown as Record<string, unknown>;

type ApiKeyStore = {
  keys: Map<string, OrgApiKey>;
  /** orgId -> set of key ids */
  byOrg: Map<OrganisationId, Set<string>>;
  /** key prefix -> key id (for fast lookup) */
  byPrefix: Map<string, string>;
};

function getStore(): ApiKeyStore {
  let store = globalScope[STATE_KEY] as ApiKeyStore | undefined;
  if (!store) {
    store = { keys: new Map(), byOrg: new Map(), byPrefix: new Map() };
    globalScope[STATE_KEY] = store;
  }
  return store;
}

export interface OrgApiKey {
  id: string;
  orgId: OrganisationId;
  /** human-readable name */
  name: string;
  /** first 8 chars, used for lookup and display only — never the secret */
  prefix: string;
  /** the full secret is returned only once at creation, then only the hash is stored */
  secretHash: string;
  scopes: readonly string[];
  /** resource ids the key may access, or undefined for org-wide */
  resourceScope?: string[];
  expiresAt?: number;
  createdAt: number;
  createdBy: string;
  /** last time the key was used, or null */
  lastUsedAt?: number;
  revokedAt?: number;
  /** rotation chain: id of the key this one replaces, or the id it was replaced by */
  rotatedFrom?: string;
  rotatedTo?: string;
}

export function newOrgApiKey(
  id: string,
  orgId: OrganisationId,
  name: string,
  secret: string,
  scopes: readonly string[],
  createdBy: string,
  resourceScope?: string[],
  expiresAt?: number,
): { key: OrgApiKey; plaintextSecret: string } {
  if (!id || !orgId || !name || !secret || secret.length < 16 || !createdBy) {
    throw new Error("api-key: id, orgId, name, secret (>=16 chars) and createdBy are required");
  }
  const prefix = secret.slice(0, 8);
  const secretHash = createHmac("sha256", secret).digest("hex");
  const now = Date.now();
  return {
    key: {
      id,
      orgId,
      name,
      prefix,
      secretHash,
      scopes,
      resourceScope,
      expiresAt,
      createdAt: now,
      createdBy,
      lastUsedAt: undefined,
    },
    plaintextSecret: secret,
  };
}

export function createApiKey(entry: { key: OrgApiKey; plaintextSecret: string }): void {
  const store = getStore();
  const k = entry.key;
  if (store.keys.has(k.id)) {
    throw new Error(`org-api-key: key already exists: ${k.id}`);
  }
  if (store.byPrefix.has(k.prefix)) {
    throw new Error(`org-api-key: prefix collision: ${k.prefix}`);
  }
  store.keys.set(k.id, k);
  store.byOrg.get(k.orgId)?.add(k.id) ?? store.byOrg.set(k.orgId, new Set([k.id]));
  store.byPrefix.set(k.prefix, k.id);
}

export function getApiKey(id: string): OrgApiKey | null {
  return getStore().keys.get(id) ?? null;
}

export function getApiKeyByPrefix(prefix: string): OrgApiKey | null {
  const id = getStore().byPrefix.get(prefix);
  if (!id) return null;
  return getStore().keys.get(id) ?? null;
}

export function listApiKeysForOrg(orgId: OrganisationId): OrgApiKey[] {
  const store = getStore();
  const ids = store.byOrg.get(orgId);
  if (!ids) return [];
  return [...ids].map((id) => store.keys.get(id)).filter(Boolean) as OrgApiKey[];
}

/**
 * Validate an API key presentation: prefix + secret hash match, not expired,
 * not revoked, and the requested scopes/resource are within the key's grant.
 */
export function validateApiKey(
  prefix: string,
  secret: string,
  requestedScopes: readonly string[],
  resourceId?: string,
): { valid: boolean; key?: OrgApiKey; reason?: string; code?: string } {
  const key = getApiKeyByPrefix(prefix);
  if (!key) {
    return { valid: false, reason: "api_key_not_found", code: "no-credential" };
  }
  if (key.revokedAt) {
    return { valid: false, reason: "api_key_revoked", code: "revoked" };
  }
  if (key.expiresAt && key.expiresAt <= Date.now()) {
    return { valid: false, reason: "api_key_expired", code: "expired" };
  }
  const providedHash = createHmac("sha256", secret).digest("hex");
  const a = Buffer.from(providedHash);
  const b = Buffer.from(key.secretHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: "invalid_secret", code: "wrong-scope" };
  }
  const scopeSet = new Set(key.scopes);
  for (const s of requestedScopes) {
    if (!scopeSet.has(s)) {
      return { valid: false, reason: `scope not granted: ${s}`, code: "wrong-scope" };
    }
  }
  if (resourceId && key.resourceScope && !key.resourceScope.includes(resourceId)) {
    return {
      valid: false,
      reason: `resource not in key scope: ${resourceId}`,
      code: "wrong-scope",
    };
  }
  // Record last used.
  key.lastUsedAt = Date.now();
  getStore().keys.set(key.id, key);
  return { valid: true, key };
}

export function revokeApiKey(id: string, orgId?: OrganisationId): boolean {
  const store = getStore();
  const k = store.keys.get(id);
  if (!k) return false;
  // Scope guard: a caller revoking within one org must not revoke another org's key (CRU-IAM-002).
  if (orgId && k.orgId !== orgId) return false;
  k.revokedAt = Date.now();
  store.keys.set(id, k);
  return true;
}

export function rotateApiKey(
  id: string,
  newSecret: string,
): { key: OrgApiKey; plaintextSecret: string } | null {
  const store = getStore();
  const k = store.keys.get(id);
  if (!k || k.revokedAt) return null;
  const rotated = createHmac("sha256", newSecret).digest("hex");
  const prefix = newSecret.slice(0, 8);
  if (store.byPrefix.has(prefix) && store.byPrefix.get(prefix) !== id) {
    throw new Error(`org-api-key: prefix collision on rotation: ${prefix}`);
  }
  store.byPrefix.delete(k.prefix);
  k.prefix = prefix;
  k.secretHash = rotated;
  k.rotatedTo = `${id}-${Date.now()}`;
  k.lastUsedAt = undefined;
  store.keys.set(id, k);
  store.byPrefix.set(prefix, id);
  return { key: k, plaintextSecret: newSecret };
}

/** Reset store state (testing only). */
export function __resetApiKeyStoreForTests(): void {
  const store = getStore();
  store.keys.clear();
  store.byOrg.clear();
  store.byPrefix.clear();
}

/** TypeScript brand. */
export const __orgApiKeyBrand = Symbol.for("crucible.org-api-key");