/**
 * @file org-principal.ts — Server-side organisation principal resolver.
 *
 * Resolves the wallet principal from a SIWE session (apps/api/src/auth.ts) and
 * binds it to organisation memberships. A client-supplied orgId is never trusted
 * as proof of membership: membership is read from the store per request, and the
 * session principal is the source of truth.
 *
 * An organisation-store outage fails closed for protected org writes but never
 * blocks on-chain settlement (ADR-0003, collaboration-and-governance.md §1).
 */

import type { OrganisationId } from "./organisation.js";
import {
  getMembershipByPrincipalAndOrg,
  isMemberOf,
  membershipForPrincipalInOrg,
  organisationsForPrincipal,
  roleForPrincipalInOrg,
} from "./org-store.js";

/** The wallet principal resolved from a verified SIWE session. */
export interface WalletPrincipal {
  /** the SIWE-authenticated address, checksummed */
  address: string;
  /** stable principal id: `eip155:<chainId>:<address>` */
  id: string;
  /** the session that proved this principal (opaque token id) */
  sessionId: string;
  /** whether the session is still valid */
  authenticated: boolean;
}

/** Resolve the wallet principal from a verified SIWE session payload. */
export function resolveWalletPrincipal(
  address: string,
  sessionId: string,
  chainId: string = "31337",
): WalletPrincipal {
  const normalized = address.toLowerCase();
  return {
    address: normalized,
    id: `eip155:${chainId}:${normalized}`,
    sessionId,
    authenticated: true,
  };
}

/**
 * The organisation-scoped principal: who the caller is, and which orgs they
 * may act in. Built once per request from the session and the store.
 */
export interface OrganisationPrincipal {
  wallet: WalletPrincipal;
  /** organisations the caller is an active member of */
  organisations: OrganisationId[];
  /** the org the caller is acting in for this request (from path/body) — verified, not trusted */
  activeOrgId?: OrganisationId;
  /** the caller's role in the active org, or null when not a member */
  activeRole?: string | null;
  /** membership record for the active org, or null */
  membership?: import("./organisation.js").Membership | null;
}

/**
 * Build an OrganisationPrincipal from a wallet principal and a requested org id.
 * The requested org id is verified against the store; it is never trusted on its own.
 *
 * Returns null when the principal is not authenticated.
 */
export function buildOrganisationPrincipal(
  wallet: WalletPrincipal | null,
  requestedOrgId?: OrganisationId,
): OrganisationPrincipal | null {
  if (!wallet || !wallet.authenticated) return null;

  const orgs = organisationsForPrincipal(wallet.id);
  let activeOrgId: OrganisationId | undefined;
  let activeRole: string | null = null;
  let membership: import("./organisation.js").Membership | null = null;

  if (requestedOrgId) {
      // Verify the caller is actually a member of the requested org.
    if (!isMemberOf(wallet.id, requestedOrgId)) {
      return null; // not a member — fail closed
    }
    activeOrgId = requestedOrgId;
    membership = membershipForPrincipalInOrg(wallet.id, requestedOrgId);
    activeRole = membership?.role ?? null;
  }

  return {
    wallet,
    organisations: orgs,
    activeOrgId,
    activeRole,
    membership,
  };
}

/**
 * Whether the principal may act in the given org.
 */
export function canActInOrg(
  principal: OrganisationPrincipal,
  orgId: OrganisationId,
): boolean {
  return isMemberOf(principal.wallet.id, orgId);
}

/**
 * The principal's role in the given org, or null when not a member.
 */
export function roleInOrg(
  principal: OrganisationPrincipal,
  orgId: OrganisationId,
): string | null {
  if (principal.activeOrgId === orgId) return principal.activeRole ?? null;
  return roleForPrincipalInOrg(principal.wallet.id, orgId);
}