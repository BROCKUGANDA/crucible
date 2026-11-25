/**
 * @file review-pg.ts — the reviewer's own state, in PostgreSQL.
 *
 * A claim is HELD: one case, one reviewer. The uniqueness is on the trial
 * id — the claim's identity — rather than on the pair, because a case may
 * be held by only one reviewer and the pair's uniqueness would allow one
 * reviewer to hold many cases while two reviewers could hold one.
 *
 * An abstention is a separate fact from a claim: a reviewer who steps
 * away from a case is not holding it, and the reason they gave is part of
 * the record.
 */

import { getPool } from "@crucible/agent-security";
import type {
  ReviewAbstention,
  ReviewClaim,
  ReviewStore,
} from "./review-store.js";

/** The PostgreSQL store for claims and abstentions. */
export function pgReviewStore(): ReviewStore {
  return {
    kind: "postgresql",

    async claim(claim) {
      const pool = getPool();
      try {
        await pool.query(
          `INSERT INTO review_claims (trial_id, reviewer, claimed_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (trial_id) DO NOTHING`,
          [claim.trialId, claim.reviewer, claim.claimedAt],
        );
      } catch (error) {
        throw error;
      }
      // The insert above does nothing when the case is already held, so
      // the hold is checked afterwards and reported in the same words the
      // in-memory store uses.
      const held = await this.getClaim(claim.trialId);
      if (held && held.reviewer !== claim.reviewer) {
        throw new Error("review: the case is already held by another reviewer");
      }
    },

    async release(trialId, reviewer) {
      const pool = getPool();
      const result = await pool.query(
        "DELETE FROM review_claims WHERE trial_id = $1 AND reviewer = $2",
        [trialId, reviewer],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async getClaim(trialId) {
      const pool = getPool();
      const r = await pool.query("SELECT * FROM review_claims WHERE trial_id = $1", [trialId]);
      const row = r.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        trialId: Number(row.trial_id),
        reviewer: row.reviewer as string,
        claimedAt: Number(row.claimed_at),
      };
    },

    async listClaims() {
      const pool = getPool();
      const r = await pool.query("SELECT * FROM review_claims ORDER BY trial_id ASC");
      return r.rows.map((row: Record<string, unknown>) => ({
        trialId: Number(row.trial_id),
        reviewer: row.reviewer as string,
        claimedAt: Number(row.claimed_at),
      }));
    },

    async abstain(abstention) {
      const pool = getPool();
      await pool.query(
        `INSERT INTO review_abstentions (trial_id, reviewer, reason, abstained_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (trial_id, reviewer) DO UPDATE
           SET reason = EXCLUDED.reason,
               abstained_at = EXCLUDED.abstained_at`,
        [abstention.trialId, abstention.reviewer, abstention.reason, abstention.abstainedAt],
      );
    },

    async listAbstentions() {
      const pool = getPool();
      const r = await pool.query(
        "SELECT * FROM review_abstentions ORDER BY trial_id ASC, reviewer ASC",
      );
      return r.rows.map((row: Record<string, unknown>) => ({
        trialId: Number(row.trial_id),
        reviewer: row.reviewer as string,
        reason: row.reason as string,
        abstainedAt: Number(row.abstained_at),
      }));
    },

    async reset() {
      const pool = getPool();
      await pool.query("DELETE FROM review_claims");
      await pool.query("DELETE FROM review_abstentions");
    },
  };
}
