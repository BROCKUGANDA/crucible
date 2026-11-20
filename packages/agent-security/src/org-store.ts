/**
 * @file org-store.ts — The tenancy model: organisations, members, invitations.
 *
 * The entity and authorization interface did not change when the records
 * moved; where they live did (ADR-0033).
 *
 * The store is a CACHE over a durable backing. The cache is what every read
 * is answered from, because `isMemberOf` is called on the hot path of every
 * request and must not become a database round trip. The backing
 * (`org-store-pg.ts`) is PostgreSQL when a database is configured, and the
 * cache is hydrated from it at boot and written through on every mutation.
 *
 * Two rules make that safe:
 *
 *   1. **A write is durable before it is visible.** The durable path writes
 *      the record to the database first and updates the cache second. A
 *      write that fails is a write that did not happen — the cache is never
 *      ahead of the database.
 *   2. **The non-durable path is refused when durability is on.** The
 *      synchronous mutators here throw if a durable backing is configured,
 *      so nobody can accidentally create state that a restart would lose.
 *      With no database configured they keep working exactly as before, and
 *      the tests use them.
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
import { getPool } from "./database.js";
import type { OrgPersistence, OrgState } from "./org-store-pg.js";

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
/* The durable backing                                                */
/* ------------------------------------------------------------------ */

let persistence: OrgPersistence | null = null;

/**
 * Attach (or detach) the durable backing.
 *
 * Called once, at boot. While a backing is attached, the synchronous
 * mutators refuse to run — a write that only reaches the cache is a write
 * a restart would lose, and the refusal is how that mistake is prevented
 * rather than documented.
 */
export function configureOrgPersistence(backing: OrgPersistence | null): void {
  persistence = backing;
}

/** Where the records are: PostgreSQL, or process memory. */
export function orgPersistenceKind(): "memory" | "postgresql" {
  return persistence ? "postgresql" : "memory";
}

/**
 * Refuse a non-durable write while a durable backing is attached.
 *
 * The message says what to do instead, because "throw" without a reason is
 * a mystery to whoever finds it at 3am.
 */
function refuseNonDurable(operation: string): void {
  if (!persistence) return;
  throw new Error(
    `org-store: ${operation} would only change the cache; a durable backing is configured. ` +
      `Use the durable path (createOrganisationDurable and friends).`,
  );
}

/**
 * Refill the cache from the durable backing.
 *
 * Called at boot when a database is configured. It REPLACES the cache: rows
 * that are gone from the database are gone from the cache, because a record
 * the database does not have is not a record.
 */
export async function hydrateOrgStore(): Promise<{
  organisations: number;
  memberships: number;
  invitations: number;
  workspaces: number;
  resources: number;
}> {
  if (!persistence) {
    throw new Error("org-store: no durable backing is configured; nothing to hydrate from");
  }
  const state: OrgState = await persistence.loadAll();
  const store = getStore();
  store.organisations.clear();
  store.workspaces.clear();
  store.memberships.clear();
  store.invitations.clear();
  store.resources.clear();
  store.orgMembers.clear();
  store.principalOrgs.clear();

  for (const org of state.organisations) store.organisations.set(org.id, org);
  for (const workspace of state.workspaces) store.workspaces.set(workspace.id, workspace);
  for (const membership of state.memberships) {
    store.memberships.set(membership.id, membership);
    if (!membership.revokedAt) {
      store.orgMembers.get(membership.orgId)?.add(membership.principalId) ??
        store.orgMembers.set(membership.orgId, new Set([membership.principalId]));
      store.principalOrgs.get(membership.principalId)?.add(membership.orgId) ??
        store.principalOrgs.set(membership.principalId, new Set([membership.orgId]));
    }
  }
  for (const invitation of state.invitations) store.invitations.set(invitation.id, invitation);
  for (const resource of state.resources) store.resources.set(resource.resourceId, resource);

  return {
    organisations: state.organisations.length,
    memberships: state.memberships.length,
    invitations: state.invitations.length,
    workspaces: state.workspaces.length,
    resources: state.resources.length,
  };
}

/* ------------------------------------------------------------------ */
/* Organisations                                                      */
/* ------------------------------------------------------------------ */

export function createOrganisation(org: Organisation): void {
  refuseNonDurable("createOrganisation");
  applyCreateOrganisation(org);
}

/** The cache half of creating an organisation. No guard: the durable path calls it. */
function applyCreateOrganisation(org: Organisation): void {
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

/* ------------------------------------------------------------------ */
/* The durable path                                                    */
/* ------------------------------------------------------------------ */
/*
 * Every function here does the same three things in the same order:
 *
 *   1. check the domain rules and work out what the new state is;
 *   2. WRITE THE RECORD TO THE DATABASE;
 *   3. update the cache.
 *
 * The order is the point. A record that is visible in the cache but not in
 * the database is a record that a restart will lose, and a caller that was
 * told "created" would have been told a lie.
 */

/**
 * Create an organisation, durably.
 *
 * The owner's membership is created with it, in the same transaction: an
 * organisation whose owner is not a member is an organisation nobody can
 * administer, and a membership that exists only in the cache is worse.
 */
export async function createOrganisationDurable(org: Organisation): Promise<void> {
  const store = getStore();
  if (store.organisations.has(org.id)) {
    throw new Error(`org-store: organisation already exists: ${org.id}`);
  }
  const ownerMembership = newMembership(
    `mem-org-${org.id}`,
    org.id,
    org.ownerId,
    "org.owner",
    org.ownerId,
  );
  if (!persistence) {
    // No durable backing: the synchronous path is the path.
    applyCreateOrganisation(org);
    return;
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO organisations (id, name, slug, owner_id, status, created_at, created_by, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        org.id,
        org.name,
        org.slug,
        org.ownerId,
        org.status,
        org.createdAt,
        org.createdBy,
        JSON.stringify(org.metadata ?? {}),
      ],
    );
    await client.query(
      `INSERT INTO memberships (id, org_id, principal_id, role, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        ownerMembership.id,
        ownerMembership.orgId,
        ownerMembership.principalId,
        ownerMembership.role,
        ownerMembership.createdAt,
        ownerMembership.createdBy,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  // Durable; now visible.
  applyCreateOrganisation(org);
}

export async function updateOrganisationDurable(
  id: OrganisationId,
  patch: Partial<Pick<Organisation, "name" | "slug" | "status" | "metadata" | "ownerId">>,
): Promise<Organisation | null> {
  const existing = getStore().organisations.get(id);
  if (!existing) return null;
  const updated: Organisation = { ...existing, ...patch };
  if (persistence) await persistence.saveOrganisation(updated);
  return applyUpdateOrganisation(id, patch);
}

export async function deleteOrganisationDurable(id: OrganisationId): Promise<boolean> {
  if (!getStore().organisations.has(id)) return false;
  if (persistence) await persistence.deleteOrganisation(id);
  return applyDeleteOrganisation(id);
}

export async function createWorkspaceDurable(workspace: Workspace): Promise<void> {
  const store = getStore();
  if (store.workspaces.has(workspace.id)) {
    throw new Error(`org-store: workspace already exists: ${workspace.id}`);
  }
  if (!store.organisations.has(workspace.orgId)) {
    throw new Error(`org-store: workspace references unknown organisation: ${workspace.orgId}`);
  }
  if (persistence) await persistence.saveWorkspace(workspace);
  applyWorkspace(workspace);
}

export async function createMembershipDurable(membership: Membership): Promise<void> {
  const store = getStore();
  if (store.memberships.has(membership.id)) {
    throw new Error(`org-store: membership already exists: ${membership.id}`);
  }
  if (!store.organisations.has(membership.orgId)) {
    throw new Error(`org-store: membership references unknown organisation: ${membership.orgId}`);
  }
  if (membership.workspaceId && !store.workspaces.has(membership.workspaceId)) {
    throw new Error(`org-store: membership references unknown workspace: ${membership.workspaceId}`);
  }
  // One ACTIVE membership per principal per organisation. The database
  // enforces it too (a partial unique index), but the message here is
  // better than a constraint violation.
  if (getMembershipByPrincipalAndOrg(membership.principalId, membership.orgId)) {
    throw new Error(
      `org-store: ${membership.principalId} is already an active member of ${membership.orgId}`,
    );
  }
  if (persistence) await persistence.saveMembership(membership);
  applyMembership(membership);
}

export async function revokeMembershipDurable(id: string): Promise<boolean> {
  const membership = getStore().memberships.get(id);
  if (!membership) return false;
  const revoked: Membership = { ...membership, revokedAt: Date.now() };
  if (persistence) await persistence.saveMembership(revoked);
  return applyRevokeMembership(id);
}

export async function createInvitationDurable(invitation: Invitation): Promise<void> {
  if (getStore().invitations.has(invitation.id)) {
    throw new Error(`org-store: invitation already exists: ${invitation.id}`);
  }
  if (persistence) await persistence.saveInvitation(invitation);
  applyInvitation(invitation);
}

export async function acceptInvitationDurable(
  id: string,
  acceptedBy: string,
): Promise<Invitation | null> {
  const invitation = getStore().invitations.get(id);
  if (!invitation) return null;
  if (invitation.used) return null;
  if (invitation.expiresAt <= Date.now()) return null;
  if (invitation.revokedAt) return null;
  if (invitation.domain && acceptedBy && !acceptedBy.endsWith(`@${invitation.domain}`)) {
    return null;
  }
  const accepted: Invitation = {
    ...invitation,
    used: true,
    acceptedAt: Date.now(),
    acceptedBy,
  };
  if (persistence) await persistence.saveInvitation(accepted);
  return applyAcceptInvitation(id, acceptedBy);
}

export async function revokeInvitationDurable(id: string): Promise<boolean> {
  const invitation = getStore().invitations.get(id);
  if (!invitation) return false;
  const revoked: Invitation = { ...invitation, revokedAt: Date.now() };
  if (persistence) await persistence.saveInvitation(revoked);
  return applyRevokeInvitation(id);
}

export async function createResourceOwnershipDurable(resource: ResourceOwnership): Promise<void> {
  if (getStore().resources.has(resource.resourceId)) {
    throw new Error(`org-store: resource ownership already exists: ${resource.resourceId}`);
  }
  if (persistence) await persistence.saveResource(resource);
  applyResourceOwnership(resource);
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
  refuseNonDurable("updateOrganisation");
  return applyUpdateOrganisation(id, patch);
}

/** The cache half of updating an organisation. */
function applyUpdateOrganisation(
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
  refuseNonDurable("deleteOrganisation");
  return applyDeleteOrganisation(id);
}

/** The cache half of deleting an organisation, cascades included. */
function applyDeleteOrganisation(id: OrganisationId): boolean {
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
  refuseNonDurable("createWorkspace");
  applyWorkspace(ws);
}

/** The cache half of creating a workspace. */
function applyWorkspace(ws: Workspace): void {
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
  refuseNonDurable("createMembership");
  applyMembership(m);
}

/** The cache half of creating a membership. */
function applyMembership(m: Membership): void {
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
  refuseNonDurable("revokeMembership");
  return applyRevokeMembership(id);
}

/** The cache half of revoking a membership. */
function applyRevokeMembership(id: string): boolean {
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
  refuseNonDurable("createInvitation");
  applyInvitation(inv);
}

/** The cache half of recording an invitation. */
function applyInvitation(inv: Invitation): void {
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
  refuseNonDurable("acceptInvitation");
  return applyAcceptInvitation(id, acceptedBy);
}

/** The cache half of accepting an invitation. */
function applyAcceptInvitation(id: string, acceptedBy: string): Invitation | null {
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
  refuseNonDurable("revokeInvitation");
  return applyRevokeInvitation(id);
}

/** The cache half of revoking an invitation. */
function applyRevokeInvitation(id: string): boolean {
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
  refuseNonDurable("createResourceOwnership");
  applyResourceOwnership(r);
}

/** The cache half of recording resource ownership. */
function applyResourceOwnership(r: ResourceOwnership): void {
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