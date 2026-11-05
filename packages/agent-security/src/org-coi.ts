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
 * In-memory store, consistent with ADR-0008.
 */

import type { OrganisationId } from "./organisation.js";

const STATE_KEY = "__crucible_org_coi__";
const globalScope = globalThis as unknown as Record<string, unknown>;

type COIStore = {
  entries: Map<string, COIEntry>;
  /** interest key -> set of entry ids. An interest key is `${type}:${orgId}`
   * for org-based interests, or `${type}:${description}` for others. Two
   * principals conflict when they share an interest key. */
  byInterest: Map<string, Set<string>>;
  /** principalId -> set of entry ids */
  byPrincipal: Map<string, Set<string>>;
};

function interestKey(entry: COIEntry): string {
  return `${entry.type}:${entry.orgId ?? entry.description}`;
}

function getStore(): COIStore {
  let store = globalScope[STATE_KEY] as COIStore | undefined;
  if (!store) {
    store = { entries: new Map(), byInterest: new Map(), byPrincipal: new Map() };
    globalScope[STATE_KEY] = store;
  }
  return store;
}

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

export function recordCOI(entry: COIEntry): void {
  const store = getStore();
  if (store.entries.has(entry.id)) {
    throw new Error(`coi: entry already exists: ${entry.id}`);
  }
  store.entries.set(entry.id, entry);
  store.byPrincipal.get(entry.principalId)?.add(entry.id) ??
    store.byPrincipal.set(entry.principalId, new Set([entry.id]));
  const key = interestKey(entry);
  store.byInterest.get(key)?.add(entry.id) ??
    store.byInterest.set(key, new Set([entry.id]));
}

export function getCOIEntry(id: string): COIEntry | null {
  return getStore().entries.get(id) ?? null;
}

export function listCOIForPrincipal(principalId: string): COIEntry[] {
  const store = getStore();
  const ids = store.byPrincipal.get(principalId);
  if (!ids) return [];
  return [...ids].map((id) => store.entries.get(id)).filter(Boolean) as COIEntry[];
}

export function listCOIForOrg(orgId: OrganisationId): COIEntry[] {
  const store = getStore();
  const ids = store.byInterest.get(`employer:${orgId}`);
  if (!ids) return [];
  return [...ids].map((id) => store.entries.get(id)).filter(Boolean) as COIEntry[];
}

export function revokeCOI(id: string): boolean {
  const store = getStore();
  const entry = store.entries.get(id);
  if (!entry) return false;
  entry.active = false;
  store.entries.set(id, entry);
  return true;
}

/**
 * Check whether two principals have a conflict of interest: any shared
 * organisation, model provider, cloud account, or other recorded interest.
 *
 * Returns the matching entries, or an empty array when no conflict is recorded.
 * An empty result means "no recorded conflict" — not "proven independent".
 */
export function conflictsBetween(
  principalA: string,
  principalB: string,
): COIEntry[] {
  const store = getStore();
  const idsA = store.byPrincipal.get(principalA);
  const idsB = store.byPrincipal.get(principalB);
  if (!idsA || !idsB) return [];
  // Each principal's entry ids, grouped by interest key. Two principals
  // conflict when they share an interest key.
  const interestsA = new Map<string, Set<string>>();
  for (const id of idsA) {
    const e = store.entries.get(id);
    if (e && e.active) {
      const key = interestKey(e);
      interestsA.get(key)?.add(id) ?? interestsA.set(key, new Set([id]));
    }
  }
  const shared: COIEntry[] = [];
  for (const id of idsB) {
    const e = store.entries.get(id);
    if (!e || !e.active) continue;
    const key = interestKey(e);
    if (interestsA.has(key)) {
      shared.push(e);
    }
  }
  return shared;
}

/**
 * Whether a reviewer (principal) is conflicted against a submission's author
 * (submitter) — any recorded shared interest.
 */
export function reviewerIsConflicted(
  reviewerPrincipal: string,
  submitterPrincipal: string,
): { conflicted: boolean; entries: COIEntry[] } {
  const entries = conflictsBetween(reviewerPrincipal, submitterPrincipal);
  return { conflicted: entries.length > 0, entries };
}

/**
 * Whether an Argus seat candidate is conflicted against the trial's sponsor
 * and agent.
 */
export function seatIsConflicted(
  seatPrincipal: string,
  sponsorPrincipal: string,
  agentPrincipal: string,
): {
  conflicted: boolean;
  entries: COIEntry[];
  against: string[];
} {
  const against: string[] = [];
  const entries: COIEntry[] = [];
  const vsSponsor = conflictsBetween(seatPrincipal, sponsorPrincipal);
  const vsAgent = conflictsBetween(seatPrincipal, agentPrincipal);
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
export function __resetCOIStoreForTests(): void {
  const store = getStore();
  store.entries.clear();
  store.byPrincipal.clear();
  store.byInterest.clear();
}