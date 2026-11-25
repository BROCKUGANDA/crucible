/**
 * @file org-api-key.ts — Scoped organisation API keys.
 *
 * A key is bound to an org, a role and a set of read paths. It cannot
 * authorise a write — writes require a wallet-signed SIWE session
 * (ADR-0006).
 *
 * **The keys are DURABLE.** The defect that made them durable was not
 * that a key was lost: it was that a REVOKED key came back. A revocation
 * lived in process memory, so a restart un-revoked every key the
 * organisation had revoked — the one moment a credential is most likely
 * to be tried again is after somebody rotated it in a hurry. The store is
 * chosen once, at boot (ADR-0033's rule), and the boot log says which.
 *
 * The secret itself is NEVER stored: only its hash, and only the first
 * eight characters in the clear so a reader can tell two keys apart.
 */

import type { OrganisationId } from "./organisation.js";
import { randomBytes, scryptSync } from "node:crypto";
import { secretEquals } from "./credentials.js";

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

/* ------------------------------------------------------------------ */
/* The store                                                           */
/* ------------------------------------------------------------------ */

/**
 * Where the keys live.
 *
 * The store never sees a plaintext secret: the hash has already been
 * computed by `newOrgApiKey`, and the plaintext exists only in the
 * response to the creating request.
 */
export interface ApiKeyStore {
  /** Which store this is, for the boot log. */
  readonly kind: string;
  /** Record a key. The store refuses a duplicate id or prefix. */
  create(key: OrgApiKey): Promise<void>;
  get(id: string): Promise<OrgApiKey | null>;
  getByPrefix(prefix: string): Promise<OrgApiKey | null>;
  listForOrg(orgId: OrganisationId): Promise<OrgApiKey[]>;
  /** Record the use of a key. Telemetry, not a decision. */
  touch(id: string, at: number): Promise<void>;
  /** Revoke a key. False when there is no such key. */
  revoke(id: string, orgId?: OrganisationId): Promise<boolean>;
  /** Replace a key's secret with a new one. */
  rotate(id: string, secretHash: string, prefix: string, rotatedTo: string): Promise<boolean>;
  /** For tests. */
  reset(): Promise<void>;
}

const STATE_KEY = "__crucible_org_api_key__";
const globalScope = globalThis as unknown as Record<string, unknown>;

/** The in-memory store. It does not survive a restart, and says so. */
export function memoryApiKeyStore(): ApiKeyStore {
  const keys = new Map<string, OrgApiKey>();
  const byOrg = new Map<OrganisationId, Set<string>>();
  const byPrefix = new Map<string, string>();
  globalScope[STATE_KEY] = { keys, byOrg, byPrefix };

  return {
    kind: "memory",
    async create(key) {
      if (keys.has(key.id)) {
        throw new Error(`org-api-key: key already exists: ${key.id}`);
      }
      if (byPrefix.has(key.prefix)) {
        throw new Error(`org-api-key: prefix collision: ${key.prefix}`);
      }
      keys.set(key.id, key);
      const ids = byOrg.get(key.orgId) ?? new Set<string>();
      ids.add(key.id);
      byOrg.set(key.orgId, ids);
      byPrefix.set(key.prefix, key.id);
    },
    async get(id) {
      return keys.get(id) ?? null;
    },
    async getByPrefix(prefix) {
      const id = byPrefix.get(prefix);
      if (!id) return null;
      return keys.get(id) ?? null;
    },
    async listForOrg(orgId) {
      const ids = byOrg.get(orgId);
      if (!ids) return [];
      return [...ids].map((id) => keys.get(id)).filter(Boolean) as OrgApiKey[];
    },
    async touch(id, at) {
      const key = keys.get(id);
      if (!key) return;
      keys.set(id, { ...key, lastUsedAt: at });
    },
    async revoke(id, orgId) {
      const key = keys.get(id);
      if (!key) return false;
      // A key that is already revoked has nothing left to revoke: the
      // second call changed nothing, and the durable store says the same.
      if (key.revokedAt) return false;
      // Scope guard: a caller revoking within one org must not revoke
      // another org's key (CRU-IAM-002).
      if (orgId && key.orgId !== orgId) return false;
      keys.set(id, { ...key, revokedAt: Date.now() });
      return true;
    },
    async rotate(id, secretHash, prefix, rotatedTo) {
      const key = keys.get(id);
      if (!key || key.revokedAt) return false;
      const held = byPrefix.get(prefix);
      if (byPrefix.has(prefix) && held !== id) {
        throw new Error(`org-api-key: prefix collision on rotation: ${prefix}`);
      }
      byPrefix.delete(key.prefix);
      keys.set(id, {
        ...key,
        prefix,
        secretHash,
        rotatedTo,
        lastUsedAt: undefined,
      });
      byPrefix.set(prefix, id);
      return true;
    },
    async reset() {
      keys.clear();
      byOrg.clear();
      byPrefix.clear();
    },
  };
}

let store: ApiKeyStore = memoryApiKeyStore();

/** Which store is in use: "memory" or "postgresql". */
export function apiKeyStoreKind(): string {
  return store.kind;
}

/** Choose the store. Called once, at boot. */
export function configureApiKeyStore(next: ApiKeyStore): void {
  store = next;
}

/** The store in use. */
export function currentApiKeyStore(): ApiKeyStore {
  return store;
}

/* ------------------------------------------------------------------ */
/* The keys                                                            */
/* ------------------------------------------------------------------ */

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
  const secretHash = hashApiKeySecret(secret);
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

/**
 * The hash of a secret.
 *
 * A credential hash is not a checksum: it is the thing an attacker with
 * a stolen database would attack, and a fast hash is a gift to them —
 * a GPU tries billions of SHA-256 candidates a second, so a weak secret
 * is a broken credential. The hash is therefore SLOW (scrypt) and
 * SALTED per key, and the stored form describes itself:
 * `scrypt$N$r$p$salt$hash`. A key hashed before this change cannot be
 * verified by it, so the format is checked rather than assumed.
 *
 * The secret never reaches the store: only this string does.
 */
export function hashApiKeySecret(secret: string, salt?: string): string {
  const usedSalt = salt ?? randomBytes(16).toString("hex");
  const derived = scryptSync(secret, usedSalt, 32, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$16384$8$1$${usedSalt}$${derived.toString("hex")}`;
}

/**
 * Does this secret match the stored hash?
 *
 * False for anything the store could not have written — a hash in another
 * format is not "valid with a different algorithm", it is a hash this
 * code does not understand, and saying yes to it would be a guess.
 */
export function verifyApiKeySecret(secret: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (!parts[4] || !parts[5]) return false;
  let derived: Buffer;
  try {
    derived = scryptSync(secret, parts[4], 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  } catch {
    return false;
  }
  return secretEquals(derived.toString("hex"), parts[5]);
}

export async function createApiKey(entry: { key: OrgApiKey; plaintextSecret: string }): Promise<void> {
  await currentApiKeyStore().create(entry.key);
}

export async function getApiKey(id: string): Promise<OrgApiKey | null> {
  return currentApiKeyStore().get(id);
}

export async function getApiKeyByPrefix(prefix: string): Promise<OrgApiKey | null> {
  return currentApiKeyStore().getByPrefix(prefix);
}

export async function listApiKeysForOrg(orgId: OrganisationId): Promise<OrgApiKey[]> {
  return currentApiKeyStore().listForOrg(orgId);
}

/**
 * Validate an API key presentation: prefix + secret hash match, not expired,
 * not revoked, and the requested scopes/resource are within the key's grant.
 */
export async function validateApiKey(
  prefix: string,
  secret: string,
  requestedScopes: readonly string[],
  resourceId?: string,
): Promise<{ valid: boolean; key?: OrgApiKey; reason?: string; code?: string }> {
  const key = await currentApiKeyStore().getByPrefix(prefix);
  if (!key) {
    return { valid: false, reason: "api_key_not_found", code: "no-credential" };
  }
  if (key.revokedAt) {
    return { valid: false, reason: "api_key_revoked", code: "revoked" };
  }
  if (key.expiresAt && key.expiresAt <= Date.now()) {
    return { valid: false, reason: "api_key_expired", code: "expired" };
  }
  if (!verifyApiKeySecret(secret, key.secretHash)) {
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
  // Record the use. It is telemetry, not a decision: a failure to write it
  // must not fail an authentication, because the authentication has
  // already been decided by the checks above.
  try {
    await currentApiKeyStore().touch(key.id, Date.now());
  } catch {
    // ignored on purpose: the timestamp is not worth refusing a call over
  }
  return { valid: true, key };
}

export async function revokeApiKey(id: string, orgId?: OrganisationId): Promise<boolean> {
  return currentApiKeyStore().revoke(id, orgId);
}

export async function rotateApiKey(
  id: string,
  newSecret: string,
): Promise<{ key: OrgApiKey; plaintextSecret: string } | null> {
  const existing = await currentApiKeyStore().get(id);
  if (!existing || existing.revokedAt) return null;
  const rotated = hashApiKeySecret(newSecret);
  const prefix = newSecret.slice(0, 8);
  const rotatedTo = `${id}-${Date.now()}`;
  const ok = await currentApiKeyStore().rotate(id, rotated, prefix, rotatedTo);
  if (!ok) return null;
  const key = await currentApiKeyStore().get(id);
  if (!key) return null;
  return { key, plaintextSecret: newSecret };
}

/** Reset store state (testing only). */
export async function __resetApiKeyStoreForTests(): Promise<void> {
  await currentApiKeyStore().reset();
}

/** TypeScript brand. */
export const __orgApiKeyBrand = Symbol.for("crucible.org-api-key");
