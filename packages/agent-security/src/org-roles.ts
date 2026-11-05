/**
 * @file org-roles.ts — Ten-role organisation matrix (re-exported from organisation.ts).
 *
 * Collapses the role matrix and separation-of-duties rules into one importable
 * surface for the API and tests. The source of truth is
 * `docs/enterprise/collaboration-and-governance.md` §3; this file is the code
 * rendering of that matrix.
 */

export type { OrgRole } from "./organisation.js";
export {
  ORG_ROLE_RANK,
  rolePermissions,
  separationOfDutiesDenial,
  parseOrgRole,
  orgRoleToSecurityRole,
} from "./organisation.js";