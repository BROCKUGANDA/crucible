/**
 * @file org-api-key-pg.ts — the API keys, in PostgreSQL.
 *
 * The store never holds a plaintext secret: the hash has already been
 * computed, and the plaintext exists only in the response to the creating
 * request. The prefix is stored in the clear because it is half of the
 * credential's public half — it is how a key is FOUND, and it is shown
 * to a reader so they can tell two keys apart.
 *
 * The revocation is the reason this table exists: a revocation that lives
 * in process memory is undone by the next restart, and the moment a
 * credential is most likely to be tried again is right after somebody
 * rotated it in a hurry.
 */

import { getPool } from "./database.js";
import type { OrganisationId } from "./organisation.js";
import type { ApiKeyStore, OrgApiKey } from "./org-api-key.js";

function rowToKey(row: Record<string, unknown>): OrgApiKey {
  return {
    id: row.id as string,
    orgId: row.org_id as OrganisationId,
    name: row.name as string,
    prefix: row.prefix as string,
    secretHash: row.secret_hash as string,
    scopes: (row.scopes as string[] | null) ?? [],
    resourceScope: (row.resource_scope as string[] | null) ?? undefined,
    expiresAt: row.expires_at === null ? undefined : Number(row.expires_at),
    createdAt: Number(row.created_at),
    createdBy: row.created_by as string,
    lastUsedAt: row.last_used_at === null ? undefined : Number(row.last_used_at),
    revokedAt: row.revoked_at === null ? undefined : Number(row.revoked_at),
    rotatedFrom: (row.rotated_from as string | null) ?? undefined,
    rotatedTo: (row.rotated_to as string | null) ?? undefined,
  };
}

/** The PostgreSQL store for organisation API keys. */
export function pgApiKeyStore(): ApiKeyStore {
  return {
    kind: "postgresql",

    async create(key) {
      const pool = getPool();
      try {
        await pool.query(
          `INSERT INTO org_api_keys
             (id, org_id, name, prefix, secret_hash, scopes, resource_scope, expires_at,
              created_at, created_by, last_used_at, revoked_at, rotated_from, rotated_to)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            key.id,
            key.orgId,
            key.name,
            key.prefix,
            key.secretHash,
            key.scopes as string[],
            key.resourceScope ?? null,
            key.expiresAt ?? null,
            key.createdAt,
            key.createdBy,
            key.lastUsedAt ?? null,
            key.revokedAt ?? null,
            key.rotatedFrom ?? null,
            key.rotatedTo ?? null,
          ],
        );
      } catch (error) {
        // The durable store says the same things the in-memory store says:
        // a duplicate id and a colliding prefix are two different mistakes,
        // and both are named.
        const code = (error as { code?: string }).code;
        if (code === "23505") {
          // Which uniqueness fired decides the sentence. The constraint
          // name is the precise answer; the detail is the fallback for a
          // driver that does not carry it.
          const constraint = String((error as { constraint?: string }).constraint ?? "");
          const detail = String((error as { detail?: string }).detail ?? "");
          if (constraint.includes("prefix") || detail.includes("(prefix)")) {
            throw new Error(`org-api-key: prefix collision: ${key.prefix}`);
          }
          throw new Error(`org-api-key: key already exists: ${key.id}`);
        }
        throw error;
      }
    },

    async get(id) {
      const pool = getPool();
      const r = await pool.query("SELECT * FROM org_api_keys WHERE id = $1", [id]);
      return r.rows[0] ? rowToKey(r.rows[0] as Record<string, unknown>) : null;
    },

    async getByPrefix(prefix) {
      const pool = getPool();
      const r = await pool.query("SELECT * FROM org_api_keys WHERE prefix = $1", [prefix]);
      return r.rows[0] ? rowToKey(r.rows[0] as Record<string, unknown>) : null;
    },

    async listForOrg(orgId) {
      const pool = getPool();
      const r = await pool.query(
        "SELECT * FROM org_api_keys WHERE org_id = $1 ORDER BY created_at ASC, id ASC",
        [orgId],
      );
      return r.rows.map((row: Record<string, unknown>) => rowToKey(row));
    },

    async touch(id, at) {
      const pool = getPool();
      await pool.query("UPDATE org_api_keys SET last_used_at = $2 WHERE id = $1", [id, at]);
    },

    async revoke(id, orgId) {
      const pool = getPool();
      // The scope guard is part of the statement, not a check outside it: a
      // caller revoking within one organisation must not revoke another
      // organisation's key (CRU-IAM-002).
      const result = orgId
        ? await pool.query(
            "UPDATE org_api_keys SET revoked_at = $2 WHERE id = $1 AND org_id = $3 AND revoked_at IS NULL",
            [id, Date.now(), orgId],
          )
        : await pool.query(
            "UPDATE org_api_keys SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL",
            [id, Date.now()],
          );
      return (result.rowCount ?? 0) > 0;
    },

    async rotate(id, secretHash, prefix, rotatedTo) {
      const pool = getPool();
      const result = await pool.query(
        `UPDATE org_api_keys
            SET secret_hash = $2, prefix = $3, rotated_to = $4, last_used_at = NULL
          WHERE id = $1 AND revoked_at IS NULL`,
        [id, secretHash, prefix, rotatedTo],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async reset() {
      const pool = getPool();
      await pool.query("DELETE FROM org_api_keys");
    },
  };
}
