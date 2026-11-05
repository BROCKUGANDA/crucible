/**
 * @file org-store.ts — In-memory organisation store.
 *
 * Consistent with ADR-0008 (in-memory indexer): a single-process deployment
 * owns the store, backed by `globalThis` so a dev-server hot reload does not
 * empty it mid-flow. A multi-process deployment moves the store to a shared
 * backing without changing the entity or authorization interface.
 *
 * Persistence is explicitly deferred: no database or queue is introduced
 * without a new ADR.
 *
 * All lookups return absent (null/undefined) — never fabricated — when a
 * record does not exist.
 */

import type {
  Invitation,
  Membership,
  Organisation,
  OrganisationId,
  ResourceId,
  ResourceOwnership,
  Workspace,
  WorkspaceId,
} from "./organisation.js";
import { newMembership } from "./organisation.js";

const STATE_KEY = "__crucible_org_store__";
const globalScope = globalThis as unknown as Record<string, unknown>;

type Store = {
  organisations: Map<OrganisationId, Organisation>;
  workspaces: Map<WorkspaceId, Workspace>;
  memberships: Map<string, Membership>;
  invitations: Map<string, Invitation>;
  resources: Map<string, ResourceOwnership>;
  /** orgId -> set of principalIds that are members */
  orgMembers: Map<OrganisationId, Set<string>>;
  /** principalId -> set of orgIds they belong to */
  principalOrgs: Map<string, Set<OrganisationId>>;
};

function getStore(): Store {
  let store = globalScope[STATE_KEY] as Store | undefined;
  if (!store) {
    store = {
      organisations: new Map(),
      workspaces: new Map(),
      memberships: new Map(),
      invitations: new Map(),
      resources: new Map(),
      orgMembers: new Map(),
      principalOrgs: new Map(),
    };
    globalScope[STATE_KEY] = store;
  }
  return store;
}

/* ------------------------------------------------------------------ */
/* Organisations                                                      */
/* ------------------------------------------------------------------ */

export function createOrganisation(org: Organisation): void {
  const store = getStore();
  if (store.organisations.has(org.id)) {
    throw new Error(`org-store: organisation already exists: ${org.id}`);
  }
  store.organisations.set(org.id, org);
  // The organisation owner is automatically a member with the owner role.
  const ownerMembership = newMembership(
    `mem-org-${org.id}`,
    org.id,
    org.ownerId,
    "org.owner",
    org.ownerId,
  );
  store.memberships.set(ownerMembership.id, ownerMembership);
  store.orgMembers.get(org.id)?.add(org.ownerId) ??
    store.orgMembers.set(org.id, new Set([org.ownerId]));
  store.principalOrgs.get(org.ownerId)?.add(org.id) ??
    store.principalOrgs.set(org.ownerId, new Set([org.id]));
}

export function getOrganisation(id: OrganisationId): Organisation | null {
  return getStore().organisations.get(id) ?? null;
}

export function listOrganisations(): Organisation[] {
  return [...getStore().organisations.values()];
}

export function updateOrganisation(
  id: OrganisationId,
  patch: Partial<Pick<Organisation, "name" | "slug" | "status" | "metadata" | "ownerId">>,
): Organisation | null {
  const store = getStore();
  const existing = store.organisations.get(id);
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  store.organisations.set(id, updated);
  return updated;
}

export function deleteOrganisation(id: OrganisationId): boolean {
  const store = getStore();
  const org = store.organisations.get(id);
  if (!org) return false;
  // Cascade: remove workspaces, memberships, invitations, resources owned by this org.
  for (const [wid, ws] of store.workspaces) {
    if (ws.orgId === id) store.workspaces.delete(wid);
  }
  for (const [mid, m] of store.memberships) {
    if (m.orgId === id) {
      store.memberships.delete(mid);
      const members = store.orgMembers.get(id);
      members?.delete(m.principalId);
      const orgs = store.principalOrgs.get(m.principalId);
      orgs?.delete(id);
    }
  }
  for (const [iid, inv] of store.invitations) {
    if (inv.orgId === id) store.invitations.delete(iid);
  }
  for (const [rid, r] of store.resources) {
    if (r.orgId === id) store.resources.delete(rid);
  }
  store.orgMembers.delete(id);
  store.organisations.delete(id);
  return true;
}

/* ------------------------------------------------------------------ */
/* Workspaces                                                         */
/* ------------------------------------------------------------------ */

export function createWorkspace(ws: Workspace): void {
  const store = getStore();
  if (store.workspaces.has(ws.id)) {
    throw new Error(`org-store: workspace already exists: ${ws.id}`);
  }
  if (!store.organisations.has(ws.orgId)) {
    throw new Error(`org-store: workspace references unknown organisation: ${ws.orgId}`);
  }
  store.workspaces.set(ws.id, ws);
}

export function getWorkspace(id: WorkspaceId): Workspace | null {
  return getStore().workspaces.get(id) ?? null;
}

export function listWorkspaces(orgId: OrganisationId): Workspace[] {
  return [...getStore().workspaces.values()].filter((w) => w.orgId === orgId);
}

/* ------------------------------------------------------------------ */
/* Memberships                                                        */
/* ------------------------------------------------------------------ */

export function createMembership(m: Membership): void {
  const store = getStore();
  if (store.memberships.has(m.id)) {
    throw new Error(`org-store: membership already exists: ${m.id}`);
  }
  if (!store.organisations.has(m.orgId)) {
    throw new Error(`org-store: membership references unknown organisation: ${m.orgId}`);
  }
  if (m.workspaceId && !store.workspaces.has(m.workspaceId)) {
    throw new Error(`org-store: membership references unknown workspace: ${m.workspaceId}`);
  }
  store.memberships.set(m.id, m);
  store.orgMembers.get(m.orgId)?.add(m.principalId) ??
    store.orgMembers.set(m.orgId, new Set([m.principalId]));
  store.principalOrgs.get(m.principalId)?.add(m.orgId) ??
    store.principalOrgs.set(m.principalId, new Set([m.orgId]));
}

export function getMembership(id: string): Membership | null {
  return getStore().memberships.get(id) ?? null;
}

export function getMembershipByPrincipalAndOrg(
  principalId: string,
  orgId: OrganisationId,
): Membership | null {
  const store = getStore();
  for (const m of store.memberships.values()) {
    if (
      m.principalId === principalId &&
      m.orgId === orgId &&
      !m.revokedAt &&
      (!m.expiresAt || m.expiresAt > Date.now())
    ) {
      return m;
    }
  }
  return null;
}

export function listMemberships(orgId: OrganisationId): Membership[] {
  return [...getStore().memberships.values()].filter(
    (m) => m.orgId === orgId && !m.revokedAt,
  );
}

export function listMembershipsForPrincipal(principalId: string): Membership[] {
  return [...getStore().memberships.values()].filter(
    (m) => m.principalId === principalId && !m.revokedAt,
  );
}

export function revokeMembership(id: string): boolean {
  const store = getStore();
  const m = store.memberships.get(id);
  if (!m) return false;
  m.revokedAt = Date.now();
  store.memberships.set(id, m);
  const members = store.orgMembers.get(m.orgId);
  members?.delete(m.principalId);
  const orgs = store.principalOrgs.get(m.principalId);
  orgs?.delete(m.orgId);
  return true;
}

/* ------------------------------------------------------------------ */
/* Invitations                                                        */
/* ------------------------------------------------------------------ */

export function createInvitation(inv: Invitation): void {
  const store = getStore();
  if (store.invitations.has(inv.id)) {
    throw new Error(`org-store: invitation already exists: ${inv.id}`);
  }
  store.invitations.set(inv.id, inv);
}

export function getInvitation(id: string): Invitation | null {
  return getStore().invitations.get(id) ?? null;
}

export function listInvitations(orgId: OrganisationId): Invitation[] {
  return [...getStore().invitations.values()].filter((i) => i.orgId === orgId);
}

export function acceptInvitation(id: string, acceptedBy: string): Invitation | null {
  const store = getStore();
  const inv = store.invitations.get(id);
  if (!inv) return null;
  if (inv.used) return null;
  if (inv.expiresAt <= Date.now()) return null;
  if (inv.revokedAt) return null;
  // Domain restriction: eligibility filter at accept time, not a display hint.
  if (inv.domain && acceptedBy && !acceptedBy.endsWith(`@${inv.domain}`)) {
    return null;
  }
  inv.used = true;
  inv.acceptedAt = Date.now();
  inv.acceptedBy = acceptedBy;
  store.invitations.set(id, inv);
  return inv;
}

export function revokeInvitation(id: string): boolean {
  const store = getStore();
  const inv = store.invitations.get(id);
  if (!inv) return false;
  inv.revokedAt = Date.now();
  store.invitations.set(id, inv);
  return true;
}

/* ------------------------------------------------------------------ */
/* Resource ownership                                                 */
/* ------------------------------------------------------------------ */

export function createResourceOwnership(r: ResourceOwnership): void {
  const store = getStore();
  if (store.resources.has(r.resourceId)) {
    throw new Error(`org-store: resource ownership already exists: ${r.resourceId}`);
  }
  store.resources.set(r.resourceId, r);
}

export function getResourceOwnership(resourceId: ResourceId): ResourceOwnership | null {
  return getStore().resources.get(resourceId) ?? null;
}

export function listResourcesForOrg(orgId: OrganisationId): ResourceOwnership[] {
  return [...getStore().resources.values()].filter((r) => r.orgId === orgId);
}

export function listResourcesForPrincipal(principalId: string): ResourceOwnership[] {
  return [...getStore().resources.values()].filter(
    (r) => r.ownerPrincipalId === principalId,
  );
}

/* ------------------------------------------------------------------ */
/* Membership resolution                                              */
/* ------------------------------------------------------------------ */

/**
 * The set of organisation ids a principal is an active member of.
 * Absent (empty) when the principal has no active memberships.
 * Revoked and expired memberships are excluded.
 */
export function organisationsForPrincipal(principalId: string): OrganisationId[] {
  const store = getStore();
  const orgIds = store.principalOrgs.get(principalId);
  if (!orgIds) return [];
  const now = Date.now();
  return [...orgIds].filter((orgId) => {
    const m = getMembershipByPrincipalAndOrg(principalId, orgId);
    return m !== null;
  });
}

/**
 * Whether a principal is an active member of an organisation.
 */
export function isMemberOf(principalId: string, orgId: OrganisationId): boolean {
  return getMembershipByPrincipalAndOrg(principalId, orgId) !== null;
}

/**
 * The active membership for a principal in an organisation, or null.
 */
export function membershipForPrincipalInOrg(
  principalId: string,
  orgId: OrganisationId,
): Membership | null {
  return getMembershipByPrincipalAndOrg(principalId, orgId);
}

/**
 * The role a principal holds in an organisation, or null when not a member.
 */
export function roleForPrincipalInOrg(
  principalId: string,
  orgId: OrganisationId,
): string | null {
  const m = getMembershipByPrincipalAndOrg(principalId, orgId);
  return m ? m.role : null;
}

/**
 * All principals that are active members of an organisation.
 */
export function membersOf(orgId: OrganisationId): string[] {
  return [...(getStore().orgMembers.get(orgId) ?? new Set())];
}

/* ------------------------------------------------------------------ */
/* Reset (testing only)                                               */
/* ------------------------------------------------------------------ */

/** Clears all store state. Intended for test isolation; not exported to app code. */
export function __resetStoreForTests(): void {
  const store = getStore();
  store.organisations.clear();
  store.workspaces.clear();
  store.memberships.clear();
  store.invitations.clear();
  store.resources.clear();
  store.orgMembers.clear();
  store.principalOrgs.clear();
}