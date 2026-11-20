/**
 * @file org-store-pg.ts — the tenancy model, in PostgreSQL.
 *
 * The organisation, its workspaces, its memberships, its invitations and its
 * resource ownership are the model's idea of WHO MAY SEE WHAT. Keeping them
 * in process memory means a restart loses them, and — because the API runs
 * under Octane, where every worker process has its own `globalThis` — two
 * workers can disagree about who is a member of what.
 *
 * This module is the durable backing for that model. It reads all five
 * tables in one pass (`loadAll`) to hydrate the store, and writes one
 * record at a time.
 *
 * The schema is migration 0002's, unchanged except for two additions in
 * migration 0013: `organisations.created_by` (the domain has an author as
 * well as an owner) and a partial unique index on active memberships (the
 * old constraint forbade ANY second membership for a principal in an
 * organisation, including a revoked one — so a member who left and came
 * back could not be recorded).
 *
 * Nothing here is a second source of truth: the store in `org-store.ts` is
 * a CACHE over these rows, hydrated at boot and written through on every
 * mutation. A read that the cache cannot answer is a bug in the cache, and
 * the cache is refilled from here.
 */

import { getPool } from "./database.js";
import type {
  Invitation,
  InvitationId,
  Membership,
  MembershipId,
  Organisation,
  OrganisationId,
  ResourceId,
  ResourceOwnership,
  Workspace,
  WorkspaceId,
} from "./organisation.js";

/** Everything the store holds, in one shape. */
export interface OrgState {
  organisations: Organisation[];
  workspaces: Workspace[];
  memberships: Membership[];
  invitations: Invitation[];
  resources: ResourceOwnership[];
}

function rowToOrganisation(row: Record<string, unknown>): Organisation {
  return {
    id: row.id as OrganisationId,
    name: row.name as string,
    slug: row.slug as string,
    createdAt: Number(row.created_at),
    createdBy: (row.created_by as string) ?? (row.owner_id as string),
    ownerId: row.owner_id as string,
    status: row.status as Organisation["status"],
    metadata: (row.metadata ?? {}) as Record<string, string>,
  };
}

function rowToWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: row.id as WorkspaceId,
    orgId: row.org_id as OrganisationId,
    name: row.name as string,
    slug: row.slug as string,
    createdAt: Number(row.created_at),
    createdBy: row.created_by as string,
    status: row.status as Workspace["status"],
    metadata: (row.metadata ?? {}) as Record<string, string>,
  };
}

function rowToMembership(row: Record<string, unknown>): Membership {
  return {
    id: row.id as MembershipId,
    orgId: row.org_id as OrganisationId,
    principalId: row.principal_id as string,
    role: row.role as Membership["role"],
    workspaceId: (row.workspace_id as WorkspaceId | null) ?? undefined,
    createdAt: Number(row.created_at),
    createdBy: row.created_by as string,
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? undefined : Number(row.revoked_at),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? undefined : Number(row.expires_at),
  };
}

function rowToInvitation(row: Record<string, unknown>): Invitation {
  return {
    id: row.id as InvitationId,
    orgId: row.org_id as OrganisationId,
    projectId: (row.project_id as string | null) ?? undefined,
    email: (row.email as string | null) ?? undefined,
    domain: (row.domain as string | null) ?? undefined,
    role: row.role as Invitation["role"],
    inviterId: row.inviter_id as string,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    acceptedAt: row.accepted_at === null || row.accepted_at === undefined ? undefined : Number(row.accepted_at),
    acceptedBy: (row.accepted_by as string | null) ?? undefined,
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? undefined : Number(row.revoked_at),
    nonce: row.nonce as string,
    used: Boolean(row.used),
  };
}

function rowToResource(row: Record<string, unknown>): ResourceOwnership {
  return {
    resourceId: row.resource_id as ResourceId,
    orgId: row.org_id as OrganisationId,
    workspaceId: (row.workspace_id as WorkspaceId | null) ?? undefined,
    ownerPrincipalId: row.owner_principal_id as string,
    createdAt: Number(row.created_at),
    visibility: row.visibility as ResourceOwnership["visibility"],
  };
}

/**
 * The durable backing for the tenancy model.
 *
 * The interface is small on purpose: it is the whole of what the store
 * needs to be restart-proof.
 */
export interface OrgPersistence {
  /** Read the whole model. One pass, five tables. */
  loadAll(): Promise<OrgState>;
  saveOrganisation(org: Organisation): Promise<void>;
  deleteOrganisation(id: OrganisationId): Promise<void>;
  saveWorkspace(workspace: Workspace): Promise<void>;
  saveMembership(membership: Membership): Promise<void>;
  saveInvitation(invitation: Invitation): Promise<void>;
  saveResource(resource: ResourceOwnership): Promise<void>;
}

export const pgOrgPersistence: OrgPersistence = {
  async loadAll(): Promise<OrgState> {
    const pool = getPool();
    const [orgs, workspaces, memberships, invitations, resources] = await Promise.all([
      pool.query("SELECT * FROM organisations ORDER BY created_at ASC"),
      pool.query("SELECT * FROM workspaces ORDER BY created_at ASC"),
      pool.query("SELECT * FROM memberships ORDER BY created_at ASC"),
      pool.query("SELECT * FROM invitations ORDER BY created_at ASC"),
      pool.query("SELECT * FROM resources ORDER BY created_at ASC"),
    ]);
    return {
      organisations: orgs.rows.map((row: Record<string, unknown>) => rowToOrganisation(row)),
      workspaces: workspaces.rows.map((row: Record<string, unknown>) => rowToWorkspace(row)),
      memberships: memberships.rows.map((row: Record<string, unknown>) => rowToMembership(row)),
      invitations: invitations.rows.map((row: Record<string, unknown>) => rowToInvitation(row)),
      resources: resources.rows.map((row: Record<string, unknown>) => rowToResource(row)),
    };
  },

  async saveOrganisation(org: Organisation): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO organisations (id, name, slug, owner_id, status, created_at, created_by, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         slug = EXCLUDED.slug,
         owner_id = EXCLUDED.owner_id,
         status = EXCLUDED.status,
         created_by = EXCLUDED.created_by,
         metadata = EXCLUDED.metadata`,
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
  },

  async deleteOrganisation(id: OrganisationId): Promise<void> {
    // The foreign keys cascade: workspaces, memberships, invitations and
    // resources all name the organisation.
    const pool = getPool();
    await pool.query("DELETE FROM organisations WHERE id = $1", [id]);
  },

  async saveWorkspace(workspace: Workspace): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO workspaces (id, org_id, name, slug, created_at, created_by, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         slug = EXCLUDED.slug,
         status = EXCLUDED.status,
         metadata = EXCLUDED.metadata`,
      [
        workspace.id,
        workspace.orgId,
        workspace.name,
        workspace.slug,
        workspace.createdAt,
        workspace.createdBy,
        workspace.status,
        JSON.stringify(workspace.metadata ?? {}),
      ],
    );
  },

  async saveMembership(membership: Membership): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO memberships
         (id, org_id, principal_id, role, workspace_id, created_at, created_by, revoked_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         role = EXCLUDED.role,
         workspace_id = EXCLUDED.workspace_id,
         revoked_at = EXCLUDED.revoked_at,
         expires_at = EXCLUDED.expires_at`,
      [
        membership.id,
        membership.orgId,
        membership.principalId,
        membership.role,
        membership.workspaceId ?? null,
        membership.createdAt,
        membership.createdBy,
        membership.revokedAt ?? null,
        membership.expiresAt ?? null,
      ],
    );
  },

  async saveInvitation(invitation: Invitation): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO invitations
         (id, org_id, project_id, email, domain, role, inviter_id, created_at, expires_at,
          accepted_at, accepted_by, revoked_at, nonce, used)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (id) DO UPDATE SET
         accepted_at = EXCLUDED.accepted_at,
         accepted_by = EXCLUDED.accepted_by,
         revoked_at = EXCLUDED.revoked_at,
         used = EXCLUDED.used`,
      [
        invitation.id,
        invitation.orgId,
        invitation.projectId ?? null,
        invitation.email ?? null,
        invitation.domain ?? null,
        invitation.role,
        invitation.inviterId,
        invitation.createdAt,
        invitation.expiresAt,
        invitation.acceptedAt ?? null,
        invitation.acceptedBy ?? null,
        invitation.revokedAt ?? null,
        invitation.nonce,
        invitation.used,
      ],
    );
  },

  async saveResource(resource: ResourceOwnership): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO resources
         (resource_id, org_id, workspace_id, owner_principal_id, created_at, visibility)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (resource_id) DO UPDATE SET
         workspace_id = EXCLUDED.workspace_id,
         visibility = EXCLUDED.visibility`,
      [
        resource.resourceId,
        resource.orgId,
        resource.workspaceId ?? null,
        resource.ownerPrincipalId,
        resource.createdAt,
        resource.visibility,
      ],
    );
  },
};
