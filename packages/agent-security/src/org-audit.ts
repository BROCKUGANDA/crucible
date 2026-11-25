/**
 * @file org-audit.ts — Append-only organisation audit history.
 *
 * Every privileged action creates an audit entry. The log is hash-chained
 * (tamper-evident) and append-only — entries are never rewritten or
 * deleted.
 *
 * TWO DEFECTS WERE FOUND HERE, and both were the kind that a green test
 * suite hides:
 *
 *  - **The hash was not cryptographic.** The module asked for `sha256`
 *    through `require()`, which does not exist in an ES module — so the
 *    `try` threw, the `catch` swallowed it, and the chain was linked with
 *    a 31-multiplier rolling hash, eight hex characters long. A chain
 *    that is "tamper-evident" only because nobody read the code is not
 *    tamper-evident: anybody can recompute a forged chain.
 *  - **The chain broke on its own redaction.** The write-time hash
 *    covered the RAW metadata while the entry stored the MASKED metadata,
 *    so any entry whose metadata held a key, token, secret or seed (the
 *    redaction list covers "key", so `keyId` counts) produced a hash that
 *    no longer matched what was stored — and `verifyChain` reported the
 *    chain as tampered after an entirely innocent write. The raw metadata
 *    in the hash was a second, quieter problem: the hash of a secret is an
 *    oracle for that secret.
 *
 * So the hash is now `hashCanonical` over exactly what is stored, through
 * the one hashing door this repository has (@crucible/crypto, gate 629):
 * canonical, so the hash depends on the CONTENT and not on the order the
 * keys happen to be in; computed over the redacted metadata, so the chain
 * cannot break on its own redaction and a secret never reaches a digest.
 *
 * And the log is DURABLE. An audit trail that evaporates on restart is not
 * an audit trail, and this one is what a buyer's compliance review reads.
 * The chain head is read from the store, not from a field in memory, so
 * the chain continues across a restart instead of silently restarting at
 * "genesis" — which would orphan every entry written before it.
 */

import { hashCanonical } from "@crucible/crypto";
import type { OrganisationId } from "./organisation.js";

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
  /** sha256 (canonical) of prevHash + id + action + resource + at + metadata */
}

/**
 * Redact anything that looks like a credential.
 *
 * The audit log records what happened; it must never record a secret.
 * The redaction happens BEFORE the entry is hashed, so the hash covers
 * exactly what is stored — and a digest of a secret is an oracle for that
 * secret.
 */
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

/* ------------------------------------------------------------------ */
/* The store                                                           */
/* ------------------------------------------------------------------ */

export interface AuditStore {
  /** Which store this is, for the boot log. */
  readonly kind: string;
  /** Append an entry. The store refuses an entry that does not link. */
  append(entry: AuditEntry): Promise<void>;
  get(id: string): Promise<AuditEntry | null>;
  /** Every entry, in chain order. */
  listAll(): Promise<AuditEntry[]>;
  /** The entries of one organisation, in chain order. */
  listForOrg(orgId: OrganisationId): Promise<AuditEntry[]>;
  /** The last entry — the head the next entry links to. */
  head(): Promise<AuditEntry | null>;
  /** For tests. */
  reset(): Promise<void>;
}

const STATE_KEY = "__crucible_org_audit__";
const globalScope = globalThis as unknown as Record<string, unknown>;

type MemoryAuditState = {
  entries: Map<string, AuditEntry>;
  /** orgId -> set of entry ids (in insertion order) */
  byOrg: Map<OrganisationId, string[]>;
  /** all entry ids in insertion order */
  allIds: string[];
  lastHash: string;
};

/** The in-memory store. It does not survive a restart, and says so. */
export function memoryAuditStore(): AuditStore {
  const state: MemoryAuditState = {
    entries: new Map(),
    byOrg: new Map(),
    allIds: [],
    lastHash: "genesis",
  };
  // The memory store is per process, so it lives on globalThis: the
  // package's own pattern for state that must survive a module reload.
  globalScope[STATE_KEY] = state;

  return {
    kind: "memory",
    async append(entry) {
      if (state.entries.has(entry.id)) {
        throw new Error(`org-audit: entry already exists: ${entry.id}`);
      }
      if (entry.prevHash !== state.lastHash) {
        throw new Error("org-audit: prevHash does not match the current chain head");
      }
      state.entries.set(entry.id, entry);
      state.allIds.push(entry.id);
      if (entry.orgId) {
        const ids = state.byOrg.get(entry.orgId) ?? [];
        ids.push(entry.id);
        state.byOrg.set(entry.orgId, ids);
      }
      state.lastHash = entry.hash;
    },
    async get(id) {
      return state.entries.get(id) ?? null;
    },
    async listAll() {
      return state.allIds
        .map((id) => state.entries.get(id))
        .filter((entry): entry is AuditEntry => Boolean(entry));
    },
    async listForOrg(orgId) {
      const ids = state.byOrg.get(orgId) ?? [];
      return ids
        .map((id) => state.entries.get(id))
        .filter((entry): entry is AuditEntry => Boolean(entry));
    },
    async head() {
      const last = state.allIds[state.allIds.length - 1];
      return last ? (state.entries.get(last) ?? null) : null;
    },
    async reset() {
      state.entries.clear();
      state.byOrg.clear();
      state.allIds = [];
      state.lastHash = "genesis";
    },
  };
}

let store: AuditStore = memoryAuditStore();

/** Which store is in use: "memory" or "postgresql". */
export function auditStoreKind(): string {
  return store.kind;
}

/**
 * Choose the store. Called once, at boot.
 *
 * Choosing per request is how a record ends up written to one store and
 * read from another, so this is deliberately not something a route can do.
 */
export function configureAuditStore(next: AuditStore): void {
  store = next;
}

/** The store in use. */
export function currentAuditStore(): AuditStore {
  return store;
}

/* ------------------------------------------------------------------ */
/* Writing an entry                                                   */
/* ------------------------------------------------------------------ */

/**
 * The hash of an entry: a canonical sha256 over exactly what is stored.
 *
 * Canonical, so two entries with the same content hash the same however
 * their metadata's keys happen to be ordered. Over the REDACTED metadata,
 * so the redaction cannot break the chain and no secret reaches a digest.
 */
export function auditEntryHash(entry: Omit<AuditEntry, "hash">): string {
  return hashCanonical({
    prevHash: entry.prevHash,
    id: entry.id,
    action: entry.action,
    resource: entry.resource ?? null,
    at: entry.at,
    metadata: entry.metadata,
  });
}

/**
 * Build an entry, linked to the current head.
 *
 * The head is read from the store, so the link is to the chain as it is
 * DURABLY, not to a field in this process's memory: a chain that restarts
 * at "genesis" after a restart orphans every entry written before it.
 */
export async function newAuditEntry(
  id: string,
  principalId: string,
  action: string,
  metadata: Record<string, unknown>,
  orgId?: OrganisationId,
  resource?: string,
): Promise<AuditEntry> {
  if (!id || !principalId || !action) {
    throw new Error("audit: id, principalId and action are required");
  }
  const head = await currentAuditStore().head();
  const prevHash = head ? head.hash : "genesis";
  const at = Date.now();
  const redacted = maskSecrets(metadata);
  const unhashed: Omit<AuditEntry, "hash"> = {
    id,
    orgId,
    principalId,
    action,
    resource,
    at,
    metadata: redacted,
    prevHash,
  };
  return { ...unhashed, hash: auditEntryHash(unhashed) };
}

/**
 * Append an entry to the chain.
 *
 * The store refuses an entry that does not link to the head, and the
 * durable store checks the link again inside its transaction, so two
 * writers cannot both link to the same head.
 */
export async function createAuditEntry(entry: AuditEntry): Promise<void> {
  const head = await currentAuditStore().head();
  if (head && entry.prevHash !== head.hash) {
    throw new Error("org-audit: prevHash does not match the current chain head");
  }
  await currentAuditStore().append(entry);
}

export async function getAuditEntry(id: string): Promise<AuditEntry | null> {
  return currentAuditStore().get(id);
}

export async function listAuditForOrg(
  orgId: OrganisationId,
  limit?: number,
): Promise<AuditEntry[]> {
  const entries = await currentAuditStore().listForOrg(orgId);
  return limit ? entries.slice(-limit) : entries;
}

export async function listAllAudit(limit?: number): Promise<AuditEntry[]> {
  const entries = await currentAuditStore().listAll();
  return limit ? entries.slice(-limit) : entries;
}

/**
 * Verify the integrity of the audit chain: every entry's hash must be
 * reproducible and the prevHash chain must be unbroken.
 */
export async function verifyChain(): Promise<{
  valid: boolean;
  brokenAt?: string;
  reason?: string;
}> {
  const entries = await currentAuditStore().listAll();
  let prev = "genesis";
  for (const entry of entries) {
    if (entry.prevHash !== prev) {
      return { valid: false, brokenAt: entry.id, reason: "chain_link_broken" };
    }
    const expected = auditEntryHash(entry);
    if (expected !== entry.hash) {
      return { valid: false, brokenAt: entry.id, reason: "hash_mismatch" };
    }
    prev = entry.hash;
  }
  return { valid: true };
}

/** Reset store state (testing only). */
export async function __resetAuditStoreForTests(): Promise<void> {
  await currentAuditStore().reset();
}

/** TypeScript brand. */
export const __orgAuditBrand = Symbol.for("crucible.org-audit");
