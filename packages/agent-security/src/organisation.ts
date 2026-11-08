/**
 * @file organisation.ts — Organisation and tenancy domain model.
 *
 * Entities for CRU-005: organisation, workspace, membership, invitation, role,
 * permission, resource ownership, audit identity and conflict-of-interest.
 *
 * The model holds access, scope and evidence — never funds. Money moves only
 * when a participant signs for it (ADR-0006, ADR-0003).
 *
 * All timestamps are Unix milliseconds. All addresses are checksummed hex.
 * Unknown values are absent, never zero or fabricated.
 */

import type {
  Decision,
  DenialCode,
  Permission,
  Principal,
  Role,
} from "./types.js";

export type OrganisationId = string;
export type WorkspaceId = string;
export type MembershipId = string;
export type InvitationId = string;
export type ResourceId = string;

/* ------------------------------------------------------------------ */
/* Ten-role matrix (collaboration-and-governance.md §3)               */
/* ------------------------------------------------------------------ */

export type OrgRole =
  | "org.owner"
  | "org.billing.admin"
  | "org.benchmark.author"
  | "org.evaluator"
  | "org.runner.operator"
  | "org.reviewer"
  | "org.auditor"
  | "org.readonly.analyst"
  | "org.external.collaborator"
  | "org.platform.operator";

export const ORG_ROLE_RANK: Record<OrgRole, number> = {
  "org.readonly.analyst": 0,
  "org.external.collaborator": 1,
  "org.benchmark.author": 2,
  "org.evaluator": 2,
  "org.runner.operator": 2,
  "org.reviewer": 2,
  "org.billing.admin": 3,
  "org.auditor": 3,
  "org.platform.operator": 3,
  "org.owner": 4,
};

/* ------------------------------------------------------------------ */
/* Organisations                                                      */
/* ------------------------------------------------------------------ */

export interface Organisation {
  id: OrganisationId;
  name: string;
  /** legal or trading name, public-facing */
  slug: string;
  /** URL-safe identifier, unique */
  createdAt: number;
  createdBy: string; // wallet principal id
  /** the principal that created the organisation */
  ownerId: string;
  /** the wallet principal that owns the organisation */
  status: "active" | "suspended" | "closed";
  /** suspension blocks new paid work; it does not touch on-chain settlement */
  metadata: Record<string, string>;
  /** public metadata only; no secrets, no private keys */
}

export function newOrganisation(
  id: OrganisationId,
  name: string,
  slug: string,
  ownerId: string,
): Organisation {
  if (!id || !name || !slug || !ownerId) {
    throw new Error("organisation: id, name, slug and owner are required");
  }
  const now = Date.now();
  return {
    id,
    name,
    slug,
    ownerId,
    createdAt: now,
    createdBy: ownerId,
    status: "active",
    metadata: {},
  };
}

/* ------------------------------------------------------------------ */
/* Workspaces                                                         */
/* ------------------------------------------------------------------ */

export interface Workspace {
  id: WorkspaceId;
  orgId: OrganisationId;
  name: string;
  slug: string;
  createdAt: number;
  createdBy: string;
  status: "active" | "archived";
  metadata: Record<string, string>;
}

export function newWorkspace(
  id: WorkspaceId,
  orgId: OrganisationId,
  name: string,
  slug: string,
  createdBy: string,
): Workspace {
  if (!id || !orgId || !name || !slug || !createdBy) {
    throw new Error("workspace: id, orgId, name, slug and createdBy are required");
  }
  const now = Date.now();
  return {
    id,
    orgId,
    name,
    slug,
    createdAt: now,
    createdBy,
    status: "active",
    metadata: {},
  };
}

/* ------------------------------------------------------------------ */
/* Memberships                                                        */
/* ------------------------------------------------------------------ */

export interface Membership {
  id: MembershipId;
  orgId: OrganisationId;
  principalId: string;
  /** wallet principal id (SIWE-authenticated address) */
  role: OrgRole;
  workspaceId?: WorkspaceId;
  /** optional: membership scoped to one workspace within the org */
  createdAt: number;
  createdBy: string;
  /** the principal that granted the membership */
  revokedAt?: number;
  /** when set, the membership is inactive */
  expiresAt?: number;
  /** optional time-box */
}

export function newMembership(
  id: MembershipId,
  orgId: OrganisationId,
  principalId: string,
  role: OrgRole,
  createdBy: string,
  workspaceId?: WorkspaceId,
  expiresAt?: number,
): Membership {
  if (!id || !orgId || !principalId || !role || !createdBy) {
    throw new Error("membership: id, orgId, principalId, role and createdBy are required");
  }
  const now = Date.now();
  return {
    id,
    orgId,
    principalId,
    role,
    createdAt: now,
    createdBy,
    workspaceId,
    expiresAt,
  };
}

/* ------------------------------------------------------------------ */
/* Invitations                                                        */
/* ------------------------------------------------------------------ */

export interface Invitation {
  id: InvitationId;
  orgId: OrganisationId;
  projectId?: string;
  /** optional: invitation scoped to one project within the org */
  email?: string;
  /** optional domain restriction: eligibility filter at accept time */
  domain?: string;
  /** email domain the accepting address must belong to */
  role: OrgRole;
  /** default: lowest role that grants access */
  inviterId: string;
  /** the principal that issued the invitation */
  createdAt: number;
  expiresAt: number;
  /** time-boxed */
  acceptedAt?: number;
  acceptedBy?: string;
  /** wallet principal that accepted */
  revokedAt?: number;
  /** revocation takes effect at the next request */
  nonce: string;
  /** single-use; a replayed acceptance is detectable */
  used: boolean;
}

export function newInvitation(
  id: InvitationId,
  orgId: OrganisationId,
  role: OrgRole,
  inviterId: string,
  ttlMs: number,
  projectId?: string,
  email?: string,
  domain?: string,
): Invitation {
  if (!id || !orgId || !role || !inviterId || ttlMs < 0) {
    throw new Error("invitation: id, orgId, role, inviterId and non-negative ttlMs are required");
  }
  const now = Date.now();
  return {
    id,
    orgId,
    projectId,
    email,
    domain,
    role,
    inviterId,
    createdAt: now,
    expiresAt: now + ttlMs,
    nonce: crypto.randomUUID(),
    used: false,
  };
}

/* ------------------------------------------------------------------ */
/* Resource ownership                                                 */
/* ------------------------------------------------------------------ */

export interface ResourceOwnership {
  resourceId: ResourceId;
  /** a run, benchmark, dataset, evaluation, artifact */
  orgId: OrganisationId;
  workspaceId?: WorkspaceId;
  ownerPrincipalId: string;
  /** the principal that created the resource */
  createdAt: number;
  visibility: "private" | "org" | "public";
}

export function newResourceOwnership(
  resourceId: ResourceId,
  orgId: OrganisationId,
  ownerPrincipalId: string,
  visibility: ResourceOwnership["visibility"] = "private",
  workspaceId?: WorkspaceId,
): ResourceOwnership {
  if (!resourceId || !orgId || !ownerPrincipalId) {
    throw new Error("resource ownership: resourceId, orgId and ownerPrincipalId are required");
  }
  return {
    resourceId,
    orgId,
    workspaceId,
    ownerPrincipalId,
    createdAt: Date.now(),
    visibility,
  };
}

/* ------------------------------------------------------------------ */
/* Audit identity                                                     */
/* ------------------------------------------------------------------ */

export interface AuditIdentity {
  principalId: string;
  orgId?: OrganisationId;
  /** absent when the action is not org-scoped */
  workspaceId?: WorkspaceId;
  /** the chain of delegation, if any */
  delegatedBy?: string;
  /** for agents: the principal that authorised this agent */
  at: number;
}

export function newAuditIdentity(
  principalId: string,
  at: number,
  orgId?: OrganisationId,
  workspaceId?: WorkspaceId,
  delegatedBy?: string,
): AuditIdentity {
  return { principalId, orgId, workspaceId, delegatedBy, at };
}

/* ------------------------------------------------------------------ */
/* Organisation-scoped decision                                       */
/* ------------------------------------------------------------------ */

export interface OrgDecision {
  allow: boolean;
  reason: string;
  code?: string;
  orgId?: OrganisationId;
  principalId: string;
  /** the wallet principal making the request */
  resource?: ResourceId;
}

/**
 * Identity-state-based public permissions. Visitor and wallet-connected
 * tiers are not organisation roles; they apply to public resources and
 * chain reads that require no SIWE session at all. They are resolved from
 * the seven-state identity model (apps/api/src/auth.ts) rather than the
 * org store.
 */
export type IdentityState =
  | "ANONYMOUS"
  | "WALLET_CONNECTED"
  | "SIWE_AUTHENTICATED"
  | "TENANT_MEMBER"
  | "ROLE_AUTHORIZED"
  | "TRANSACTION_AUTHORIZED"
  | "RUNTIME_VERIFIED";

/** Permissions granted to a caller in a given identity state. */
export function identityStatePermissions(state: IdentityState): readonly string[] {
  switch (state) {
    case "ANONYMOUS":
      return [
        "trials:read:public",
        "agents:read:public",
        "scorecards:read:public",
        "leaderboards:read:public",
        "hall:read:public",
        "engrams:read:public",
        "docs:read",
      ];
    case "WALLET_CONNECTED":
      return [
        ...identityStatePermissions("ANONYMOUS"),
        "chain:read:public",
        "transaction:prepare",
      ];
    case "SIWE_AUTHENTICATED":
      return [...identityStatePermissions("WALLET_CONNECTED"), "workspace:read:own"];
    case "TENANT_MEMBER":
      return [...identityStatePermissions("SIWE_AUTHENTICATED"), "org:read"];
    case "ROLE_AUTHORIZED":
      return [...identityStatePermissions("TENANT_MEMBER")];
    case "TRANSACTION_AUTHORIZED":
      return [...identityStatePermissions("ROLE_AUTHORIZED")];
    case "RUNTIME_VERIFIED":
      return [...identityStatePermissions("TRANSACTION_AUTHORIZED")];
    default:
      return identityStatePermissions("ANONYMOUS");
  }
}

/**
 * Whether a given identity state holds a permission, without requiring
 * organisation membership. Used for public and wallet-aware routes.
 */
export function identityStateAllows(state: IdentityState, permission: string): boolean {
  return identityStatePermissions(state).includes(permission);
}

/* ------------------------------------------------------------------ */
/* OrgRole permission derivation                                      */
/* ------------------------------------------------------------------ */

/**
 * The permissions an OrgRole carries. Derived from the collaboration and
 * governance document's role matrix. Nothing here may grant on-chain
 * escrow access — no role can move a participant's funds.
 */
export function rolePermissions(role: OrgRole): readonly string[] {
  switch (role) {
    case "org.owner":
      return [
        "org:manage",
        "org:member:invite",
        "org:member:remove",
        "org:role:change",
        "org:transfer:ownership",
        "org:budget:set",
        "org:read",
        "org:audit:export",
        "benchmark:create",
        "benchmark:edit:private",
        "evaluation:run",
        "runner:register",
        "reviewer:file:break",
        "audit:read",
      ];
    case "org.billing.admin":
      return [
        "org:budget:set",
        "org:read",
        "org:audit:export",
        "invoice:read",
        "credit:read",
      ];
    case "org.benchmark.author":
      return ["benchmark:create", "benchmark:edit:private", "org:read"];
    case "org.evaluator":
      return ["evaluation:run", "org:read"];
    case "org.runner.operator":
      return ["runner:register", "runner:bind:agent", "org:read"];
    case "org.reviewer":
      return ["reviewer:file:break", "reviewer:read:submission", "org:read"];
    case "org.auditor":
      return ["org:read", "org:audit:export", "audit:read"];
    case "org.readonly.analyst":
      return ["org:read", "audit:read"];
    case "org.external.collaborator":
      return ["org:read:scoped", "audit:read:scoped"];
    case "org.platform.operator":
      return [
        "org:deploy:observe",
        "org:rotate:observe",
        "org:read",
        "org:audit:export",
      ];
    default:
      return [];
  }
}

/**
 * Separation-of-duties checks (collaboration-and-governance.md §3).
 * Returns a denial when the pairing is prohibited.
 */
export function separationOfDutiesDenial(
  actorRole: OrgRole,
  targetRole: OrgRole,
  action: "grant-role" | "grade-own-run" | "publish-own-benchmark",
): DenialCode | null {
  // A billing administrator cannot grant themselves a role.
  if (action === "grant-role" && actorRole === "org.billing.admin" && targetRole === "org.owner") {
    return "separation-of-duties";
  }
  // A runner operator cannot grade its own run.
  if (action === "grade-own-run" && actorRole === "org.runner.operator") {
    return "separation-of-duties";
  }
  // A benchmark author and the reviewer who publishes must not be the same
  // principal for a benchmark that appears on a public leaderboard.
  if (action === "publish-own-benchmark" && actorRole === "org.benchmark.author") {
    return "separation-of-duties";
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* OrgRole from string (safe parse; unknown is absent)                */
/* ------------------------------------------------------------------ */

export function parseOrgRole(value: unknown): OrgRole | null {
  if (typeof value !== "string") return null;
  const roles: readonly OrgRole[] = [
    "org.owner",
    "org.billing.admin",
    "org.benchmark.author",
    "org.evaluator",
    "org.runner.operator",
    "org.reviewer",
    "org.auditor",
    "org.readonly.analyst",
    "org.external.collaborator",
    "org.platform.operator",
  ];
  return roles.includes(value as OrgRole) ? (value as OrgRole) : null;
}

/* ------------------------------------------------------------------ */
/* OrgRole to legacy agent-security Role (for adapter interop)        */
/* ------------------------------------------------------------------ */

/**
 * Maps an organisation role to the nearest agent-security Role for code that
 * consumes the existing Principal/Decision vocabulary. The mapping is
 * deliberately lossy in the downward direction: organisation-specific scopes
 * (org:budget:set, invoice:read, etc.) have no agent-security equivalent and
 * are not represented there.
 */
export function orgRoleToSecurityRole(role: OrgRole): Role | null {
  const map: Record<OrgRole, Role | null> = {
    "org.owner": "operator",
    "org.billing.admin": "admin",
    "org.benchmark.author": "sponsor",
    "org.evaluator": "verifier",
    "org.runner.operator": "operator",
    "org.reviewer": "skeptic",
    "org.auditor": "observer",
    "org.readonly.analyst": "observer",
    "org.external.collaborator": "observer",
    "org.platform.operator": "admin",
  };
  return map[role] ?? null;
}

/* ------------------------------------------------------------------ */
/* TypeScript brand check                                             */
/* ------------------------------------------------------------------ */

export const __organisationBrand = Symbol.for("crucible.organisation");