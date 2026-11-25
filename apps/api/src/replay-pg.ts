/**
 * @file replay-pg.ts — the durable record of a measurement.
 *
 * The manifest is the measurement: what was run, in which environment, by
 * which worker, and what each replay produced. If it evaporates on
 * restart, a published card and a frozen dispute bundle describe something
 * that can no longer be re-derived — and a card that outlives its
 * measurement is a claim with no record.
 *
 * Two tables, because the manifest and the replay records have different
 * shapes and different lives: the manifest's reproducibility state moves
 * as the replays complete, while a replay record's identity never does.
 *
 * The tables are NOT the `replay_manifests` / `replay_records` of
 * migration 0008: those describe a spec-bound manifest that no code
 * writes (CRUCIBLE_AUDIT.md, REPL-D2), and reusing them would mean
 * inventing values the live model does not have.
 */

import { getPool } from "@crucible/agent-security";
import type { ReplayManifest, ReplayRecord } from "./replay-manifest.js";
import type { ReplayStore } from "./replay-store.js";

function rowToManifest(row: Record<string, unknown>): ReplayManifest {
  return row.manifest as ReplayManifest;
}

function rowToReplay(row: Record<string, unknown>): ReplayRecord {
  return row.record as ReplayRecord;
}

/** The PostgreSQL store for replay manifests and their records. */
export function pgReplayStore(): ReplayStore {
  return {
    kind: "postgresql",

    async putManifest(manifest) {
      const pool = getPool();
      await pool.query(
        `INSERT INTO replay_measurements (manifest_id, trial_id, run_id, spec_digest, manifest, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (manifest_id) DO UPDATE
           SET manifest = EXCLUDED.manifest`,
        [
          manifest.manifestId,
          manifest.trialId,
          manifest.runId,
          manifest.specDigest,
          JSON.stringify(manifest),
          manifest.createdAt,
        ],
      );
    },

    async getManifest(manifestId) {
      const pool = getPool();
      const r = await pool.query("SELECT manifest FROM replay_measurements WHERE manifest_id = $1", [
        manifestId,
      ]);
      const row = r.rows[0] as Record<string, unknown> | undefined;
      return row ? rowToManifest(row) : undefined;
    },

    async listManifestsByTrial(trialId) {
      const pool = getPool();
      const r = await pool.query(
        `SELECT manifest FROM replay_measurements
          WHERE trial_id = $1
          ORDER BY created_at ASC, manifest_id ASC`,
        [trialId],
      );
      return r.rows.map((row: Record<string, unknown>) => rowToManifest(row));
    },

    async listManifestsByRun(runId) {
      const pool = getPool();
      const r = await pool.query(
        `SELECT manifest FROM replay_measurements
          WHERE run_id = $1
          ORDER BY created_at ASC, manifest_id ASC`,
        [runId],
      );
      return r.rows.map((row: Record<string, unknown>) => rowToManifest(row));
    },

    /**
     * Record a replay.
     *
     * The insert is an upsert, and the update touches ONLY what a replay's
     * life may change: its status, its output, its differences and when it
     * finished. The identity of a replay — which manifest it belongs to,
     * which number it is, which worker ran it — never moves. A record
     * whose worker can be rewritten after the fact is a record that cannot
     * be trusted about independence.
     */
    async putReplay(record) {
      const pool = getPool();
      await pool.query(
        `INSERT INTO replay_measurement_records
           (replay_id, manifest_id, replay_number, worker_identity, status, record, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (replay_id) DO UPDATE
           SET status = EXCLUDED.status,
               record = EXCLUDED.record`,
        [
          record.replayId,
          record.manifestId,
          record.replayNumber,
          record.workerIdentity,
          record.status,
          JSON.stringify(record),
          record.createdAt,
        ],
      );
    },

    async getReplay(replayId) {
      const pool = getPool();
      const r = await pool.query("SELECT record FROM replay_measurement_records WHERE replay_id = $1", [
        replayId,
      ]);
      const row = r.rows[0] as Record<string, unknown> | undefined;
      return row ? rowToReplay(row) : undefined;
    },

    async listReplaysByManifest(manifestId) {
      const pool = getPool();
      const r = await pool.query(
        `SELECT record FROM replay_measurement_records
          WHERE manifest_id = $1
          ORDER BY replay_number ASC`,
        [manifestId],
      );
      return r.rows.map((row: Record<string, unknown>) => rowToReplay(row));
    },

    async reset() {
      const pool = getPool();
      await pool.query("DELETE FROM replay_measurement_records");
      await pool.query("DELETE FROM replay_measurements");
    },
  };
}
