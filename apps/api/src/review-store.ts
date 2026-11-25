/**
 * @file review-store.ts — where a reviewer's own state lives.
 *
 * The CASES are chain-derived: a trial that is open for review is a fact
 * the chain holds, and the indexer re-reads it after a restart. What the
 * chain does NOT hold is the reviewer's side of it: who has claimed a
 * case, who has abstained from one, and why.
 *
 * Those are durable. A queue that forgets its claims after a restart is a
 * queue where two reviewers believe they hold the same case, and the
 * second one to finish is refused by the platform for no stated reason.
 *
 * The store is chosen once, at boot (ADR-0033's rule), and the boot log
 * says which.
 */

export interface ReviewClaim {
  /** The trial id, as the chain knows it. */
  trialId: number;
  /** The reviewer's principal (a wallet address, lowercased). */
  reviewer: string;
  claimedAt: number;
}

export interface ReviewAbstention {
  trialId: number;
  reviewer: string;
  /** Why the reviewer stepped away. Free text, recorded verbatim. */
  reason: string;
  abstainedAt: number;
}

export interface ReviewStore {
  readonly kind: string;
  claim(claim: ReviewClaim): Promise<void>;
  /** False when the case is already held by somebody else. */
  release(trialId: number, reviewer: string): Promise<boolean>;
  getClaim(trialId: number): Promise<ReviewClaim | null>;
  listClaims(): Promise<ReviewClaim[]>;
  abstain(abstention: ReviewAbstention): Promise<void>;
  listAbstentions(): Promise<ReviewAbstention[]>;
  /** For tests. */
  reset(): Promise<void>;
}

/** The in-memory store. It does not survive a restart, and says so. */
export function memoryReviewStore(): ReviewStore {
  const claims = new Map<number, ReviewClaim>();
  const abstentions = new Map<string, ReviewAbstention>();

  return {
    kind: "memory",
    async claim(claim) {
      const held = claims.get(claim.trialId);
      if (held && held.reviewer !== claim.reviewer) {
        throw new Error(`review: the case is already held by another reviewer`);
      }
      claims.set(claim.trialId, claim);
    },
    async release(trialId, reviewer) {
      const held = claims.get(trialId);
      if (!held || held.reviewer !== reviewer) return false;
      claims.delete(trialId);
      return true;
    },
    async getClaim(trialId) {
      return claims.get(trialId) ?? null;
    },
    async listClaims() {
      return [...claims.values()];
    },
    async abstain(abstention) {
      abstentions.set(`${abstention.trialId}:${abstention.reviewer}`, abstention);
    },
    async listAbstentions() {
      return [...abstentions.values()];
    },
    async reset() {
      claims.clear();
      abstentions.clear();
    },
  };
}

let store: ReviewStore = memoryReviewStore();

/** Which store is in use: "memory" or "postgresql". */
export function reviewStoreKind(): string {
  return store.kind;
}

/** Choose the store. Called once, at boot. */
export function configureReviewStore(next: ReviewStore): void {
  store = next;
}

/** The store in use. */
export function currentReviewStore(): ReviewStore {
  return store;
}
