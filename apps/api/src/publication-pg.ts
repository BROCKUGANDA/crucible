/**
 * @file publication-pg.ts — the durable record of a published method.
 *
 * A published method card is the audit artifact of an evaluation: it says
 * what was measured, against what, and what the number does not establish.
 * It has to outlive the process, so it is written to PostgreSQL.
 *
 * The card is APPEND-ONLY and content-addressed. Its id is derived from the
 * digest of its own contents, so the same method published twice is the
 * same row, and a card cannot be edited — any change produces a different
 * address.
 *
 * Comparisons are recorded too: a comparison that cannot be looked up later
 * is a comparison nobody can check.
 */

import { getPool } from "@crucible/agent-security";
import type { PublishedMethod } from "./publication.js";
import type { PublicationFilter, PublicationStore, StoredComparison } from "./publication-store.js";

function rowToMethod(row: Record<string, unknown>): PublishedMethod {
  return row.card as PublishedMethod;
}

function rowToComparison(row: Record<string, unknown>): StoredComparison {
  return {
    id: row.id as string,
    leftId: row.left_id as string,
    rightId: row.right_id as string,
    comparable: Boolean(row.comparable),
    reason: row.reason as string,
    differences: (row.differences ?? []) as string[],
    comparedAt: Number(row.compared_at),
  };
}

/** The PostgreSQL store for published methods. */
export function pgPublicationStore(): PublicationStore {
  return {
    /**
     * Record a published method.
     *
     * The insert is an upsert on the id, and the id IS the digest of the
     * contents — so an existing row with the same id has the same contents.
     * Nothing is overwritten, because overwriting would mean editing a
     * published method, which the address forbids.
     */
    async record(method) {
      const pool = getPool();
      await pool.query(
        `INSERT INTO published_methods
           (id, digest, subject_kind, subject_id, agent_id, comparability_key, card, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          method.id,
          method.digest,
          method.subject.kind,
          method.subject.id,
          method.subject.agentId,
          method.comparabilityKey,
          JSON.stringify(method),
          method.publishedAt,
        ],
      );
      return (await this.get(method.id)) ?? method;
    },

    async get(id) {
      const pool = getPool();
      const r = await pool.query("SELECT * FROM published_methods WHERE id = $1", [id]);
      const row = r.rows[0] as Record<string, unknown> | undefined;
      return row ? rowToMethod(row) : null;
    },

    async list(filter: PublicationFilter) {
      const pool = getPool();
      const clauses: string[] = [];
      const values: string[] = [];
      if (filter.subjectId) {
        values.push(filter.subjectId);
        clauses.push(`subject_id = $${values.length}`);
      }
      if (filter.kind) {
        values.push(filter.kind);
        clauses.push(`subject_kind = $${values.length}`);
      }
      if (filter.comparabilityKey) {
        values.push(filter.comparabilityKey);
        clauses.push(`comparability_key = $${values.length}`);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      values.push(String(Math.min(filter.limit ?? 100, 500)));
      const r = await pool.query(
        `SELECT * FROM published_methods ${where} ORDER BY published_at DESC LIMIT $${values.length}`,
        values,
      );
      return r.rows.map((row: Record<string, unknown>) => rowToMethod(row));
    },

    async recordComparison(input) {
      const pool = getPool();
      const id = `cmp_${input.leftId}_${input.rightId}`.slice(0, 200);
      await pool.query(
        `INSERT INTO publication_comparisons
           (id, left_id, right_id, comparable, reason, differences, compared_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (id) DO UPDATE SET
           comparable = EXCLUDED.comparable,
           reason = EXCLUDED.reason,
           differences = EXCLUDED.differences,
           compared_at = EXCLUDED.compared_at`,
        [
          id,
          input.leftId,
          input.rightId,
          input.comparable,
          input.reason,
          JSON.stringify(input.differences),
          input.comparedAt,
        ],
      );
      const r = await pool.query("SELECT * FROM publication_comparisons WHERE id = $1", [id]);
      return rowToComparison(r.rows[0] as Record<string, unknown>);
    },

    async listComparisons(methodId) {
      const pool = getPool();
      const r = await pool.query(
        `SELECT * FROM publication_comparisons
          WHERE left_id = $1 OR right_id = $1
          ORDER BY compared_at DESC`,
        [methodId],
      );
      return r.rows.map((row: Record<string, unknown>) => rowToComparison(row));
    },
  };
}
