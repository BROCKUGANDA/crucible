import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ROLE_PERMISSIONS,
  ROLE_RANK,
  type Credential,
  type Decision,
  type Permission,
  type Principal,
  type Role,
} from "./types.js";

/**
 * Agent credentialing, OAuth-style API keys, and RBAC.
 *
 * Two rules are non-negotiable here and both are enforced structurally rather than by
 * convention:
 *
 *   1. **An operator never gets `reputation:write`.** Not in the baseline matrix, not
 *      by grant. ERC-8004 forbids it too ("the feedback submitter MUST NOT be the agent
 *      owner"), and an agent that can grade itself makes the entire verification
 *      premise worthless.
 *
 *   2. **Delegation cannot deepen.** A credential can only ever hold permissions its
 *      parent held. Without this, any agent with `admin:policy` could mint itself an
 *      operator and there would be no security boundary at all.
 */

/** Permissions no principal may hold, regardless of grants. */
export const FORBIDDEN_PERMISSIONS: readonly Permission[] = ["reputation:write"];

export class CredentialError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(`crucible:v1:${secret}`).digest("hex");
}

function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface IssuedCredential {
  credential: Credential;
  /** returned exactly once; never persisted by the issuer */
  secret: string;
}

export class CredentialAuthority {
  private readonly principals = new Map<string, Principal>();
  private readonly credentials = new Map<string, Credential>();
  /** id -> secret hash, for O(1) lookup on presentation */
  private readonly bySecretHash = new Map<string, string>();
  private readonly usedNonces = new Set<string>();
  /** credential id -> the set of permission names it delegated away */
  private readonly delegatedAway = new Map<string, Set<Permission>>();

  // ── principals ──
  registerPrincipal(p: Omit<Principal, "createdAt"> & { createdAt?: number }): Principal {
    if (this.principals.has(p.id)) throw new CredentialError(`principal ${p.id} exists`, "exists");
    const principal: Principal = { ...p, createdAt: p.createdAt ?? Date.now() };
    this.principals.set(p.id, principal);
    return principal;
  }

  getPrincipal(id: string): Principal | undefined {
    return this.principals.get(id);
  }

  revokePrincipal(id: string, at = Date.now()): void {
    const p = this.principals.get(id);
    if (!p) throw new CredentialError(`no such principal ${id}`, "unknown-principal");
    p.revokedAt = at;
    // cascading: every credential the principal holds dies with it
    for (const c of this.credentials.values()) {
      if (c.principalId === id) c.revokedAt = at;
    }
  }

  // ── credential issuance ──
  issue(args: {
    principalId: string;
    scopes?: Permission[];
    ttlMs?: number;
    /** issue on behalf of another credential — caps scopes to the parent's */
    delegatedFrom?: string;
  }): IssuedCredential {
    const principal = this.principals.get(args.principalId);
    if (!principal) throw new CredentialError(`no such principal`, "unknown-principal");
    if (principal.revokedAt) throw new CredentialError("principal revoked", "revoked");

    let scopes: Permission[];
    if (args.delegatedFrom) {
      const parent = this.credentials.get(args.delegatedFrom);
      if (!parent) throw new CredentialError("no parent credential", "unknown-credential");
      if (parent.revokedAt || parent.expiresAt <= Date.now()) {
        throw new CredentialError("parent credential is not usable", "parent-unusable");
      }
      const requested = args.scopes ?? [...parent.scopes];
      const parentSet = new Set(parent.scopes);
      const notHeld = requested.filter((s) => !parentSet.has(s));
      if (notHeld.length > 0) {
        throw new CredentialError(
          `delegation cannot exceed the parent: ${notHeld.join(", ")}`,
          "escalation",
        );
      }
      scopes = requested;
      // remember what was given up, so revoke-all can be computed
      const given = new Set(this.delegatedAway.get(args.delegatedFrom) ?? []);
      parent.scopes.filter((s) => !scopes.includes(s)).forEach((s) => given.add(s));
      this.delegatedAway.set(args.delegatedFrom, given);
    } else {
      scopes = args.scopes ?? [...ROLE_PERMISSIONS[principal.role]];
    }

    const forbidden = scopes.filter((s) => FORBIDDEN_PERMISSIONS.includes(s));
    if (forbidden.length > 0) {
      throw new CredentialError(
        `${forbidden.join(", ")} can never be granted — an agent may not write its own reputation`,
        "forbidden-scope",
      );
    }

    const secret = randomBytes(32).toString("base64url");
    const credential: Credential = {
      id: `cred_${randomBytes(9).toString("hex")}`,
      principalId: args.principalId,
      secretHash: hashSecret(secret),
      scopes,
      issuedAt: Date.now(),
      expiresAt: Date.now() + (args.ttlMs ?? 24 * 60 * 60 * 1000),
      nonce: randomBytes(12).toString("base64url"),
      ...(args.delegatedFrom ? { delegatedFrom: args.delegatedFrom } : {}),
    };

    this.credentials.set(credential.id, credential);
    this.bySecretHash.set(credential.secretHash, credential.id);
    return { credential, secret };
  }

  // ── presentation & verification ──
  verify(args: {
    credentialId: string;
    secret: string;
    now?: number;
    /** consume the nonce; a second use is a replay */
    consumeNonce?: boolean;
  }): Decision {
    const now = args.now ?? Date.now();
    const cred = this.credentials.get(args.credentialId);
    if (!cred) return { allow: false, reason: "unknown credential", code: "no-credential" };

    if (!secretEquals(hashSecret(args.secret), cred.secretHash)) {
      return { allow: false, reason: "credential secret mismatch", code: "no-credential" };
    }
    const principal = this.principals.get(cred.principalId);
    if (!principal || principal.revokedAt) {
      return { allow: false, reason: "principal revoked", code: "revoked" };
    }
    if (cred.revokedAt) {
      return { allow: false, reason: "credential revoked", code: "revoked" };
    }
    if (cred.expiresAt <= now) {
      return { allow: false, reason: "credential expired", code: "expired" };
    }
    if (this.usedNonces.has(cred.nonce)) {
      return { allow: false, reason: "nonce already used — replay", code: "replayed-nonce" };
    }
    if (args.consumeNonce) this.usedNonces.add(cred.nonce);

    return { allow: true, reason: `credential valid for ${cred.scopes.length} scope(s)` };
  }

  // ── RBAC ──
  /** @returns true when the role may hold the permission at all */
  static roleMayHold(role: Role, permission: Permission): boolean {
    if (FORBIDDEN_PERMISSIONS.includes(permission)) return false;
    return ROLE_PERMISSIONS[role].includes(permission);
  }

  /**
   * Separation of duties. The judge cannot be the judged.
   *
   * This is what makes the whole dispute mechanism meaningful: if an agent could
   * arbitrate its own trial, the 2-of-3 commit-reveal would be theatre.
   */
  static checkSeparationOfDuties(args: {
    principal: Principal;
    permission: Permission;
    resourceOwnerId?: string;
    resourceOperatorId?: string;
  }): Decision {
    const { principal, permission } = args;
    const isJudge = permission === "trial:dispute:vote" || permission === "trial:finalize";

    if (isJudge) {
      if (args.resourceOwnerId === principal.id) {
        return {
          allow: false,
          reason: "the sponsor of a trial may not adjudicate it",
          code: "separation-of-duties",
        };
      }
      if (args.resourceOperatorId === principal.id) {
        return {
          allow: false,
          reason: "the agent being judged may not vote on its own trial",
          code: "separation-of-duties",
        };
      }
      if (principal.role !== "argus" && principal.role !== "admin") {
        return {
          allow: false,
          reason: "only an Argus seat or an admin may adjudicate",
          code: "insufficient-role",
        };
      }
    }

    // An agent may not act on its own creator's behalf in a judging capacity, and an
    // agent below operator rank may not move funds at all.
    if (permission === "funds:withdraw" && ROLE_RANK[principal.role] < ROLE_RANK.operator) {
      return {
        allow: false,
        reason: "withdrawing funds requires operator rank",
        code: "insufficient-role",
      };
    }

    return { allow: true, reason: "separation of duties satisfied" };
  }

  // ── delegation policy ──
  static MAX_DELEGATION_DEPTH = 3;

  /** Walk the chain and enforce depth, revocation and scope containment. */
  checkDelegationChain(credentialId: string): Decision {
    let depth = 0;
    let current = this.credentials.get(credentialId);
    let scopes: Set<Permission> | null = null;

    while (current?.delegatedFrom) {
      depth += 1;
      if (depth > CredentialAuthority.MAX_DELEGATION_DEPTH) {
        return {
          allow: false,
          reason: `delegation chain deeper than ${CredentialAuthority.MAX_DELEGATION_DEPTH}`,
          code: "delegation-too-deep",
        };
      }
      const parent = this.credentials.get(current.delegatedFrom);
      if (!parent) {
        return { allow: false, reason: "broken delegation chain", code: "trust-chain-broken" };
      }
      if (parent.revokedAt || parent.expiresAt <= Date.now()) {
        return {
          allow: false,
          reason: "an ancestor credential is no longer valid",
          code: "trust-chain-broken",
        };
      }
      // a child's scopes must remain a subset of its parent's
      const parentScopes = new Set(parent.scopes);
      if (current.scopes.some((s) => !parentScopes.has(s))) {
        return {
          allow: false,
          reason: "delegated scopes exceed the parent credential",
          code: "trust-chain-broken",
        };
      }
      scopes = parentScopes;
      current = parent;
    }

    if (scopes && current && current.scopes.some((s) => !scopes!.has(s))) {
      return {
        allow: false,
        reason: "final scope is not contained by the root credential",
        code: "trust-chain-broken",
      };
    }
    return { allow: true, reason: "delegation chain verified" };
  }

  revokeCredential(id: string, at = Date.now()): void {
    const c = this.credentials.get(id);
    if (!c) throw new CredentialError(`no such credential ${id}`, "unknown-credential");
    c.revokedAt = at;
  }

  /** Rotate: issue a replacement and kill the old one atomically. */
  rotate(credentialId: string, ttlMs?: number): IssuedCredential {
    const old = this.credentials.get(credentialId);
    if (!old) throw new CredentialError("no such credential", "unknown-credential");
    const issued = this.issue({
      principalId: old.principalId,
      scopes: [...old.scopes],
      ttlMs,
      ...(old.delegatedFrom ? { delegatedFrom: old.delegatedFrom } : {}),
    });
    this.revokeCredential(credentialId);
    return issued;
  }

  listCredentials(principalId?: string): Credential[] {
    const all = [...this.credentials.values()];
    return principalId ? all.filter((c) => c.principalId === principalId) : all;
  }
}
