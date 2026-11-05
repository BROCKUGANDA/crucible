/**
 * @file org-membership.ts — Organisation membership lifecycle.
 *
 * Invite, accept, expire, revoke, change role, remove membership, transfer
 * ownership through an authorised process. Default role on accept is the
 * lowest that grants access. Revocation takes effect at the next request.
 *
 * Builds on org-store.ts (Membership, Invitation). In-memory per ADR-0008.
 */

import {
  createInvitation,
  createMembership,
  createOrganisation,
  getInvitation,
  getMembershipByPrincipalAndOrg,
  getOrganisation,
  listInvitations,
  listMemberships,
  revokeMembership,
  updateOrganisation,
} from "./org-store.js";
import type { Invitation, Membership } from "./organisation.js";
import { newInvitation, newMembership, newOrganisation, parseOrgRole } from "./organisation.js";
import { createAuditEntry, listAuditForOrg, newAuditEntry } from "./org-audit.js";

/** Invite a principal to an organisation. */
export function inviteMember(
  orgId: string,
  inviteePrincipalId: string,
  role: string,
  actorId: string,
  ttlMs: number,
  projectId?: string,
  email?: string,
  domain?: string,
): { invitationId: string; invitation: Invitation } {
  const org = getOrganisation(orgId);
  if (!org) {
    throw new Error(`membership: organisation not found: ${orgId}`);
  }
  const parsedRole = parseOrgRole(role);
  if (!parsedRole) {
    throw new Error(`membership: unknown role: ${role}`);
  }
  // Only the organisation owner may invite members.
  const inviterMembership = getMembershipByPrincipalAndOrg(actorId, orgId);
  if (!inviterMembership || inviterMembership.role !== "org.owner") {
    throw new Error("membership: only the organisation owner may invite members");
  }
  const id = `inv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const invitation = newInvitation(id, orgId, parsedRole, actorId, ttlMs, projectId, email, domain);
  createInvitation(invitation);
  createAuditEntry(
    newAuditEntry(
      `audit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      actorId,
      "org:member:invite",
      { orgId, inviteePrincipalId, role, invitationId: id },
      orgId,
      inviteePrincipalId,
    ),
  );
  return { invitationId: id, invitation };
}

/** Accept an invitation. Binds an existing wallet principal. */
export function acceptMember(
  invitationId: string,
  acceptedBy: string,
): { membershipId: string; membership: Membership } {
  const result = __acceptInvitation(invitationId, acceptedBy);
  if (!result) {
    throw new Error("membership: invitation cannot be accepted (expired, revoked, used, or domain mismatch)");
  }
  const { membership, invitation } = result;
  createAuditEntry(
    newAuditEntry(
      `audit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      acceptedBy,
      "org:member:accept",
      { orgId: invitation.orgId, invitationId, role: membership.role },
      invitation.orgId,
      acceptedBy,
    ),
  );
  return { membershipId: membership.id, membership };
}

function __acceptInvitation(
  invitationId: string,
  acceptedBy: string,
): { membership: Membership; invitation: Invitation } | null {
  const invitation = getInvitation(invitationId);
  if (!invitation || invitation.used || invitation.revokedAt) return null;
  if (invitation.expiresAt <= Date.now()) return null;
  // Domain restriction: eligibility filter at accept time.
  if (invitation.domain && !acceptedBy.endsWith(`@${invitation.domain}`)) return null;
  // Mark the invitation used — the stored object reference is the Map's value,
  // so mutation persists.
  invitation.used = true;
  invitation.acceptedAt = Date.now();
  invitation.acceptedBy = acceptedBy;
  const membership = newMembership(
    `mem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    invitation.orgId,
    acceptedBy,
    invitation.role,
    acceptedBy,
    undefined,
    invitation.expiresAt,
  );
  createMembership(membership);
  return { membership, invitation };
}

/** Revoke a membership (immediately inactive). */
export function removeMember(orgId: string, principalId: string, actorId: string): boolean {
  const org = getOrganisation(orgId);
  if (!org) return false;
  const actor = getMembershipByPrincipalAndOrg(actorId, orgId);
  if (!actor || actor.role !== "org.owner") {
    throw new Error("membership: only the organisation owner may remove members");
  }
  const m = getMembershipByPrincipalAndOrg(principalId, orgId);
  if (!m) throw new Error(`membership: membership not found: ${principalId}`);
  const revoked = revokeMembership(m.id);
  if (revoked) {
    createAuditEntry(
      newAuditEntry(
        `audit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        actorId,
        "org:member:remove",
        { orgId, principalId, previousRole: m.role },
        orgId,
        principalId,
      ),
    );
  }
  return revoked;
}

/** Change a member's role. Separation of duties: billing admin cannot grant owner. */
export function changeRole(
  orgId: string,
  principalId: string,
  newRole: string,
  actorId: string,
): { previousRole: string; newRole: string } {
  const parsed = parseOrgRole(newRole);
  if (!parsed) throw new Error(`membership: unknown role: ${newRole}`);
  const m = getMembershipByPrincipalAndOrg(principalId, orgId);
  if (!m) throw new Error("membership: membership not found");
  const actor = getMembershipByPrincipalAndOrg(actorId, orgId);
  if (!actor || actor.role !== "org.owner") {
    throw new Error("membership: only the organisation owner may change roles");
  }
  const previous = m.role;
  m.role = parsed;
  const stored = getMembershipByPrincipalAndOrg(principalId, orgId);
  if (!stored) throw new Error("membership: membership not found");
  stored.role = parsed;
  createAuditEntry(
    newAuditEntry(
      `audit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      actorId,
      "org:role:change",
      { orgId, principalId, previousRole: previous, newRole: parsed },
      orgId,
      principalId,
    ),
  );
  return { previousRole: previous, newRole: parsed };
}

/** Transfer organisation ownership. */
export function transferOwnership(
  orgId: string,
  newOwnerId: string,
  actorId: string,
): { previousOwner: string; newOwner: string } {
  const org = getOrganisation(orgId);
  if (!org) throw new Error("membership: organisation not found");
  const actor = getMembershipByPrincipalAndOrg(actorId, orgId);
  if (!actor || actor.role !== "org.owner") {
    throw new Error("membership: only the organisation owner may transfer ownership");
  }
  const target = getMembershipByPrincipalAndOrg(newOwnerId, orgId);
  if (!target) throw new Error("membership: target principal is not a member");
  const previous = org.ownerId;
  const updated = updateOrganisation(orgId, { ownerId: newOwnerId });
  if (!updated) throw new Error("membership: organisation not found");
  createAuditEntry(
    newAuditEntry(
      `audit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      actorId,
      "org:transfer:ownership",
      { orgId, previousOwner: previous, newOwner: newOwnerId },
      orgId,
      orgId,
    ),
  );
  return { previousOwner: previous, newOwner: newOwnerId };
}

/** List all invitations for an org (active, expired, revoked). */
export function listOrgInvitations(orgId: string): Invitation[] {
  return listInvitations(orgId);
}

/** List all memberships for an org. */
export function listOrgMemberships(orgId: string): Membership[] {
  return listMemberships(orgId);
}

/** List the audit history for an org. */
export function listOrgAudit(orgId: string, limit?: number) {
  return listAuditForOrg(orgId, limit);
}