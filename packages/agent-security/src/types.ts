/**
 * Core types for the agent security layer.
 *
 * The vocabulary matters: an *agent* is a principal, not a user. It has its own
 * identity, its own credentials, and its own audit trail. Treating an agent's actions
 * as "the user's actions" is how delegation chains turn into unaccountable blast
 * radius.
 */

export type Role =
  | "operator" // owns an agent, funds it, signs for it
  | "sponsor" // posts trials
  | "skeptic" // files breaks, risks stake
  | "argus" // adjudicates disputes
  | "verifier" // re-runs claims
  | "observer" // read-only
  | "admin"; // operator of the platform itself

export const ROLE_RANK: Record<Role, number> = {
  observer: 0,
  verifier: 1,
  skeptic: 1,
  sponsor: 2,
  argus: 3,
  operator: 3,
  admin: 4,
};

export type Permission =
  | "trial:create"
  | "trial:claim"
  | "trial:run"
  | "trial:break"
  | "trial:finalize"
  | "trial:dispute:vote"
  | "agent:register"
  | "agent:stake"
  | "agent:unstake"
  | "funds:withdraw"
  | "reputation:read"
  | "reputation:write" // the operator NEVER gets this
  | "admin:rotate-key"
  | "admin:policy";

/** The baseline matrix. Everything else must be granted explicitly and expiring. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  observer: ["reputation:read"],
  verifier: ["reputation:read"],
  skeptic: ["trial:break", "reputation:read"],
  sponsor: ["trial:create", "funds:withdraw", "reputation:read"],
  argus: ["trial:finalize", "trial:dispute:vote", "reputation:read"],
  operator: [
    "agent:register",
    "agent:stake",
    "agent:unstake",
    "trial:claim",
    "trial:run",
    "funds:withdraw",
    "reputation:read",
  ],
  admin: ["admin:rotate-key", "admin:policy", "reputation:read"],
};

export interface Principal {
  /** stable identifier: `eip155:31337:0xabc…` or an app-local id */
  id: string;
  kind: "human" | "agent" | "service";
  role: Role;
  /** for agents: the principal that authorised this agent */
  delegatedBy?: string;
  /** unix ms */
  createdAt: number;
  revokedAt?: number;
}

export interface Credential {
  id: string;
  principalId: string;
  /** never stored, never logged — only the hash is retained */
  secretHash: string;
  scopes: readonly Permission[];
  issuedAt: number;
  expiresAt: number;
  /** single-use nonce so a replayed presentation is detectable */
  nonce: string;
  revokedAt?: number;
  /** the credential this one may act as — prevents horizontal privilege escalation */
  delegatedFrom?: string;
}

export type Decision =
  | { allow: true; reason: string }
  | { allow: false; reason: string; code: DenialCode };

export type DenialCode =
  | "no-credential"
  | "expired"
  | "revoked"
  | "wrong-scope"
  | "insufficient-role"
  | "role-incompatible"
  | "replayed-nonce"
  | "delegation-too-deep"
  | "self-attestation"
  | "separation-of-duties"
  | "outside-delegation"
  | "rate-limited"
  | "blocked-tool"
  | "output-rejected"
  | "input-rejected"
  | "injection-detected"
  | "boundary-violation"
  | "context-overflow"
  | "poisoning-detected"
  | "session-scope"
  | "rate-limit-exceeded"
  | "approval-required"
  | "approval-denied"
  | "action-scope-exceeded"
  | "anomaly-detected"
  | "trust-chain-broken"
  | "risk-too-high";

export interface ActionRequest {
  principalId: string;
  permission: Permission;
  /** what the action targets — a trial id, an amount, a URL */
  resource: string;
  /** explicit arguments, so scope limits can be checked against them */
  args?: Record<string, unknown>;
  at: number;
}

export interface ApprovalRequest {
  id: string;
  principalId: string;
  action: string;
  resource: string;
  risk: RiskAssessment;
  requestedAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "denied" | "expired" | "auto-approved";
  decidedBy?: string;
  decidedAt?: number;
  reason?: string;
}

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RiskAssessment {
  level: RiskLevel;
  score: number; // 0-100
  factors: string[];
  requiresHumanApproval: boolean;
}

export interface ToolPolicy {
  name: string;
  /** the agent must declare this to call the tool at all */
  requiredScopes: readonly Permission[];
  /** hard ceiling on what this tool may ever be asked to do */
  maxCallsPerSession?: number;
  /** e.g. only these URL prefixes */
  allowedTargets?: string[];
  riskWeight: number; // contributes to the session risk score
  /** requires human approval regardless of score */
  alwaysNeedsApproval?: boolean;
}

export interface LogEntry {
  seq: number;
  at: number;
  principalId: string;
  action: string;
  resource: string;
  decision: Decision;
  /** never contains secrets — masked at write time */
  metadata: Record<string, unknown>;
  /** hash chain link, so the log is tamper-evident */
  prevHash: string;
  hash: string;
}
