/**
 * @file evidence-bundle-pg.ts — the durable record of a frozen bundle.
 *
 * The bundle is written as it was sealed, never rebuilt: a committee that
 * comes back next week reads the same bytes that the parties saw when the
 * trial was broken.
 */

import { getPool } from "@crucible/agent-security";
import type { EvidenceBundle } from "./evidence-bundle.js";
import type { EvidenceBundleStore, StoredBundle } from "./evidence-bundle-store.js";

function rowToStored(row: Record<string, unknown>): StoredBundle {
  return {
    bundle: row.bundle as EvidenceBundle,
    sealedAt: Number(row.sealed_at),
    predatesDispute: row.predates_dispute === null ? null : Boolean(row.predates_dispute),
  };
}

/** The PostgreSQL store for frozen bundles. */
export function pgEvidenceBundleStore(): EvidenceBundleStore {
  return {
    /**
     * Record a frozen bundle.
     *
     * The insert is an upsert on the id, and the id IS the digest of the
     * contents — so an existing row with the same id has the same contents.
     * Nothing is overwritten: overwriting would mean editing the evidence a
     * committee is about to read.
     */
    async record(bundle, predatesDispute) {
      const pool = getPool();
      await pool.query(
        `INSERT INTO dispute_evidence_bundles
           (id, trial_key, digest, bundle, sealed_at, predates_dispute)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [
          bundle.id,
          bundle.trialKey,
          bundle.digest,
          JSON.stringify(bundle),
          bundle.sealedAt,
          predatesDispute,
        ],
      );
      return (await this.get(bundle.id)) ?? {
        bundle,
        sealedAt: bundle.sealedAt,
        predatesDispute,
      };
    },

    async get(id) {
      const pool = getPool();
      const r = await pool.query("SELECT * FROM dispute_evidence_bundles WHERE id = $1", [id]);
      const row = r.rows[0] as Record<string, unknown> | undefined;
      return row ? rowToStored(row) : null;
    },

    async listForTrial(trialKey) {
      const pool = getPool();
      const r = await pool.query(
        `SELECT * FROM dispute_evidence_bundles
          WHERE trial_key = $1
          ORDER BY sealed_at ASC`,
        [trialKey],
      );
      return r.rows.map((row: Record<string, unknown>) => rowToStored(row));
    },
  };
}
