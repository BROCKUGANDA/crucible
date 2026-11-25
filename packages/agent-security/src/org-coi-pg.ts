/**
 * @file org-coi-pg.ts — the conflict-of-interest register, in PostgreSQL.
 *
 * A conflict declared on Monday and forgotten by Tuesday — because the
 * process restarted — is a conflict that stopped being checked on
 * Tuesday. The register is a record, not a memory.
 *
 * A declaration is withdrawn by setting `active = false`, never by
 * deleting it: the fact that a conflict WAS declared and then withdrawn is
 * itself part of the history a reviewer may need.
 */

import { getPool } from "./database.js";
import type { COIEntry, COIStore, COIType } from "./org-coi.js";
import type { OrganisationId } from "./organisation.js";

function rowToEntry(row: Record<string, unknown>): COIEntry {
  return {
    id: row.id as string,
    principalId: row.principal_id as string,
    orgId: (row.org_id as string) ?? undefined,
    type: row.type as COIType,
    description: row.description as string,
    disclosedAt: Number(row.disclosed_at),
    disclosedBy: row.disclosed_by as string,
    expiresAt: row.expires_at === null || row.expires_at === undefined ? undefined : Number(row.expires_at),
    active: Boolean(row.active),
  };
}

/** The PostgreSQL register. */
export function pgCOIStore(): COIStore {
  return {
    kind: "postgresql",

    async record(entry) {
      const pool = getPool();
      try {
        await pool.query(
          `INSERT INTO org_coi_entries
             (id, principal_id, org_id, type, description, disclosed_at, disclosed_by, expires_at, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            entry.id,
            entry.principalId,
            entry.orgId ?? null,
            entry.type,
            entry.description,
            entry.disclosedAt,
            entry.disclosedBy,
            entry.expiresAt ?? null,
            entry.active,
          ],
        );
      } catch (error) {
        // The durable store says the SAME thing the in-memory store says:
        // a duplicate declaration is refused, in the same words.
        if ((error as { code?: string }).code === "23505") {
          throw new Error(`coi: entry already exists: ${entry.id}`);
        }
        throw error;
      }
    },

    async revoke(id) {
      const pool = getPool();
      const result = await pool.query(
        "UPDATE org_coi_entries SET active = false WHERE id = $1 AND active = true",
        [id],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async get(id) {
      const pool = getPool();
      const r = await pool.query("SELECT * FROM org_coi_entries WHERE id = $1", [id]);
      const row = r.rows[0] as Record<string, unknown> | undefined;
      return row ? rowToEntry(row) : null;
    },

    async listForPrincipal(principalId) {
      const pool = getPool();
      const r = await pool.query(
        "SELECT * FROM org_coi_entries WHERE principal_id = $1 ORDER BY disclosed_at ASC, id ASC",
        [principalId],
      );
      return r.rows.map((row: Record<string, unknown>) => rowToEntry(row));
    },

    async listForInterest(type, orgId) {
      const pool = getPool();
      const r = await pool.query(
        `SELECT * FROM org_coi_entries
          WHERE type = $1 AND org_id = $2
          ORDER BY disclosed_at ASC, id ASC`,
        [type, orgId],
      );
      return r.rows.map((row: Record<string, unknown>) => rowToEntry(row));
    },

    async listAll() {
      const pool = getPool();
      const r = await pool.query(
        "SELECT * FROM org_coi_entries ORDER BY disclosed_at ASC, id ASC",
      );
      return r.rows.map((row: Record<string, unknown>) => rowToEntry(row));
    },

    async reset() {
      const pool = getPool();
      await pool.query("DELETE FROM org_coi_entries");
    },
  };
}
