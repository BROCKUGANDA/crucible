/**
 * @file org-coi.ts — Conflict-of-interest register.
 *
 * Records affiliations between principals and organisations, model providers,
 * cloud accounts, or other economic interests. Checked before Argus seat
 * assignment and before a reviewer grades a submission from an affiliated
 * principal.
 *
 * A correlation signal alone is not collusion — this register creates a
 * reviewable risk signal, not a determination (collaboration-and-governance.md
 * §3, game-theory.md §5.7).
 *
 * The register is DURABLE. A conflict declared on Monday and forgotten by
 * Tuesday — because the process restarted — is a conflict that stopped
 * being checked on Tuesday, and the check is the whole point. The store is
 * chosen once, at boot (ADR-0033's rule), and the boot log says which.
 */

import type { OrganisationId } from "./organisation.js";

export type COIType =
  | "employer"
  | "model-provider"
  | "cloud-account"
  | "sponsor-affiliation"
  | "reviewer-affiliation"
  | "other";

export interface COIEntry {
  id: string;
  principalId: string;
  /** the principal with the interest */
  orgId?: OrganisationId;
  /** the organisation the interest relates to, when applicable */
  type: COIType;
  description: string;
  disclosedAt: number;
  disclosedBy: string;
  /** the principal that made the disclosure */
  expiresAt?: number;
  /** when the interest lapses */
  active: boolean;
}

/**
 * The interest key of an entry: what two principals would SHARE.
 *
 * `${type}:${orgId}` for an organisation-based interest, `${type}:${description}`
 * for anything else. Two principals conflict when they share an interest
 * key — so the key is the comparison, and it is derived, never written.
 */
export function interestKey(entry: COIEntry): string {
  return `${entry.type}:${entry.orgId ?? entry.description}`;
}

/* ------------------------------------------------------------------ */
/* The store                                                           */
/* ------------------------------------------------------------------ */

export interface COIStore {
  /** Which store this is, for the boot log. */
  readonly kind: string;
  /** Record a declaration. The store refuses a duplicate id. */
  record(entry: COIEntry): Promise<void>;
  /** Withdraw a declaration. False when there is no such entry. */
  revoke(id: string): Promise<boolean>;
  get(id: string): Promise<COIEntry | null>;
  listForPrincipal(principalId: string): Promise<COIEntry[]>;
  /** The declarations about one organisation's employer interest. */
  listForInterest(type: COIType, orgId: OrganisationId): Promise<COIEntry[]>;
  listAll(): Promise<COIEntry[]>;
  /** For tests. */
  reset(): Promise<void>;
}

const STATE_KEY = "__crucible_org_coi__";
const globalScope = globalThis as unknown as Record<string, unknown>;

/** The in-memory register. It does not survive a restart, and says so. */
export function memoryCOIStore(): COIStore {
  const entries = new Map<string, COIEntry>();
  globalScope[STATE_KEY] = entries;

  return {
    kind: "memory",
    async record(entry) {
      if (entries.has(entry.id)) {
        throw new Error(`coi: entry already exists: ${entry.id}`);
      }
      entries.set(entry.id, entry);
    },
    async revoke(id) {
      const entry = entries.get(id);
      if (!entry) return false;
      entries.set(id, { ...entry, active: false });
      return true;
    },
    async get(id) {
      return entries.get(id) ?? null;
    },
    async listForPrincipal(principalId) {
      return [...entries.values()].filter((entry) => entry.principalId === principalId);
    },
    async listForInterest(type, orgId) {
      return [...entries.values()].filter(
        (entry) => entry.type === type && entry.orgId === orgId,
      );
    },
    async listAll() {
      return [...entries.values()];
    },
    async reset() {
      entries.clear();
    },
  };
}

let store: COIStore = memoryCOIStore();

/** Which store is in use: "memory" or "postgresql". */
export function coiStoreKind(): string {
  return store.kind;
}

/** Choose the store. Called once, at boot. */
export function configureCOIStore(next: COIStore): void {
  store = next;
}

/** The store in use. */
export function currentCOIStore(): COIStore {
  return store;
}

/* ------------------------------------------------------------------ */
/* The register                                                        */
/* ------------------------------------------------------------------ */

export function newCOIEntry(
  id: string,
  principalId: string,
  type: COIType,
  description: string,
  disclosedBy: string,
  orgId?: OrganisationId,
  expiresAt?: number,
): COIEntry {
  if (!id || !principalId || !type || !description || !disclosedBy) {
    throw new Error("coi: id, principalId, type, description and disclosedBy are required");
  }
  return {
    id,
    principalId,
    orgId,
    type,
    description,
    disclosedAt: Date.now(),
    disclosedBy,
    expiresAt,
    active: true,
  };
}

export async function recordCOI(entry: COIEntry): Promise<void> {
  await currentCOIStore().record(entry);
}

export async function getCOIEntry(id: string): Promise<COIEntry | null> {
  return currentCOIStore().get(id);
}

export async function listCOIForPrincipal(principalId: string): Promise<COIEntry[]> {
  return currentCOIStore().listForPrincipal(principalId);
}

export async function listCOIForOrg(orgId: OrganisationId): Promise<COIEntry[]> {
  return currentCOIStore().listForInterest("employer", orgId);
}

export async function revokeCOI(id: string): Promise<boolean> {
  return currentCOIStore().revoke(id);
}

/**
 * Check whether two principals have a conflict of interest: any shared
 * organisation, model provider, cloud account, or other recorded interest.
 *
 * Returns the matching entries, or an empty array when no conflict is recorded.
 * An empty result means "no recorded conflict" — not "proven independent".
 */
export async function conflictsBetween(
  principalA: string,
  principalB: string,
): Promise<COIEntry[]> {
  const entriesA = await currentCOIStore().listForPrincipal(principalA);
  const entriesB = await currentCOIStore().listForPrincipal(principalB);

  // Each principal's entries, grouped by interest key. Two principals
  // conflict when they share an interest key.
  const interestsA = new Map<string, Set<string>>();
  for (const entry of entriesA) {
    if (!entry.active) continue;
    const key = interestKey(entry);
    const ids = interestsA.get(key) ?? new Set<string>();
    ids.add(entry.id);
    interestsA.set(key, ids);
  }

  const shared: COIEntry[] = [];
  for (const entry of entriesB) {
    if (!entry.active) continue;
    if (interestsA.has(interestKey(entry))) {
      shared.push(entry);
    }
  }
  return shared;
}

/**
 * Whether a reviewer (principal) is conflicted against a submission's author
 * (submitter) — any recorded shared interest.
 */
export async function reviewerIsConflicted(
  reviewerPrincipal: string,
  submitterPrincipal: string,
): Promise<{ conflicted: boolean; entries: COIEntry[] }> {
  const entries = await conflictsBetween(reviewerPrincipal, submitterPrincipal);
  return { conflicted: entries.length > 0, entries };
}

/**
 * Whether an Argus seat candidate is conflicted against the trial's sponsor
 * and agent.
 */
export async function seatIsConflicted(
  seatPrincipal: string,
  sponsorPrincipal: string,
  agentPrincipal: string,
): Promise<{
  conflicted: boolean;
  entries: COIEntry[];
  against: string[];
}> {
  const against: string[] = [];
  const entries: COIEntry[] = [];
  const vsSponsor = await conflictsBetween(seatPrincipal, sponsorPrincipal);
  const vsAgent = await conflictsBetween(seatPrincipal, agentPrincipal);
  if (vsSponsor.length > 0) {
    against.push("sponsor");
    entries.push(...vsSponsor);
  }
  if (vsAgent.length > 0) {
    against.push("agent");
    entries.push(...vsAgent);
  }
  return { conflicted: against.length > 0, entries, against };
}

/** Reset store state (testing only). */
export async function __resetCOIStoreForTests(): Promise<void> {
  await currentCOIStore().reset();
}
