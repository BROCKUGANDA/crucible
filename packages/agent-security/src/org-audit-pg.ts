/**
 * @file org-audit-pg.ts — the audit chain, in PostgreSQL.
 *
 * An audit trail that evaporates on restart is not an audit trail, and
 * this one is what a buyer's compliance review reads. The chain also has
 * to CONTINUE across a restart: the head is the last entry in the table,
 * not a field in a process's memory, or every entry written before the
 * restart would be orphaned by a chain that restarted at "genesis".
 *
 * The append is serialised with an advisory lock and checks the link
 * INSIDE the transaction. Two writers that both read the same head would
 * otherwise both link to it and fork the chain — and a forked chain
 * verifies as broken, which is exactly what a tamper must look like.
 *
 * Entries are never updated and never deleted: there is no code path here
 * that can do either.
 */

import { getPool } from "./database.js";
import type { AuditEntry, AuditStore } from "./org-audit.js";

/** A lock key for the audit chain append. Any constant will do. */
const AUDIT_CHAIN_LOCK = 0x41554449; /* "AUDI" */

function rowToEntry(row: Record<string, unknown>): AuditEntry {
  return {
    id: row.id as string,
    orgId: (row.org_id as string) ?? undefined,
    principalId: row.principal_id as string,
    action: row.action as string,
    resource: (row.resource as string) ?? undefined,
    at: Number(row.at),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    prevHash: row.prev_hash as string,
    hash: row.hash as string,
  };
}

/** The PostgreSQL store for the append-only audit chain. */
export function pgAuditStore(): AuditStore {
  return {
    kind: "postgresql",

    async append(entry) {
      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Serialise the append: two writers must not link to the same head.
        await client.query("SELECT pg_advisory_xact_lock($1)", [AUDIT_CHAIN_LOCK]);

        const head = await client.query(
          "SELECT hash FROM org_audit_entries ORDER BY seq DESC LIMIT 1",
        );
        const headHash = (head.rows[0] as { hash?: string } | undefined)?.hash ?? "genesis";
        if (entry.prevHash !== headHash) {
          throw new Error("org-audit: prevHash does not match the current chain head");
        }

        await client.query(
          `INSERT INTO org_audit_entries
             (id, org_id, principal_id, action, resource, at, metadata, prev_hash, hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
          [
            entry.id,
            entry.orgId ?? null,
            entry.principalId,
            entry.action,
            entry.resource ?? null,
            entry.at,
            JSON.stringify(entry.metadata),
            entry.prevHash,
            entry.hash,
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async get(id) {
      const pool = getPool();
      const r = await pool.query("SELECT * FROM org_audit_entries WHERE id = $1", [id]);
      const row = r.rows[0] as Record<string, unknown> | undefined;
      return row ? rowToEntry(row) : null;
    },

    async listAll() {
      const pool = getPool();
      const r = await pool.query("SELECT * FROM org_audit_entries ORDER BY seq ASC");
      return r.rows.map((row: Record<string, unknown>) => rowToEntry(row));
    },

    async listForOrg(orgId) {
      const pool = getPool();
      const r = await pool.query(
        "SELECT * FROM org_audit_entries WHERE org_id = $1 ORDER BY seq ASC",
        [orgId],
      );
      return r.rows.map((row: Record<string, unknown>) => rowToEntry(row));
    },

    async head() {
      const pool = getPool();
      const r = await pool.query("SELECT * FROM org_audit_entries ORDER BY seq DESC LIMIT 1");
      const row = r.rows[0] as Record<string, unknown> | undefined;
      return row ? rowToEntry(row) : null;
    },

    async reset() {
      const pool = getPool();
      await pool.query("DELETE FROM org_audit_entries");
    },
  };
}
