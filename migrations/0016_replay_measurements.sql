-- 0016_replay_measurements.sql — the measurement is durable.
--
-- A replay manifest IS the measurement: what was run, in which environment,
-- by which worker, and what each replay produced. It lived in a module
-- map, so a restart erased it — and a published card or a frozen dispute
-- bundle would then describe a measurement that could no longer be
-- re-derived.
--
-- THE NAMES ARE NOT `replay_manifests` / `replay_records` ON PURPOSE.
--
-- Migration 0008 already defines tables by those names, with a DIFFERENT
-- and richer model: every row there must name an `evaluation_spec_id` and
-- a `trial_revision_hash`, carry a `manifest_digest`, and its
-- `replay_status` is CHECKed against a set that does not include
-- 'RUNNING'. The live manifest — the one the Studio writes, the published
-- card is built from and the dispute bundle freezes — has no evaluation
-- spec id and no trial revision hash, and its status set is wider.
--
-- Nothing in the codebase writes the 0008 tables: they are a schema that
-- was designed and never connected (see CRUCIBLE_AUDIT.md, REPL-D2). So
-- this migration does NOT reuse them — reusing them would mean inventing
-- values for columns the live model does not have, and fabricating data
-- to satisfy a NOT NULL is exactly the kind of lie this repository does
-- not tell. The two schemas are reconciled in a later change, and the
-- divergence is named rather than left to rot.
--
-- Two tables, because the manifest and its replay records have different
-- shapes and different lives.

CREATE TABLE IF NOT EXISTS replay_measurements (
  manifest_id  TEXT PRIMARY KEY,
  trial_id     TEXT NOT NULL,
  run_id       TEXT NOT NULL,
  spec_digest  TEXT NOT NULL,
  -- The manifest's own contents. Kept whole, not exploded into columns:
  -- the manifest is written by one implementation, and a second, partial
  -- column set is a second place for a field to go missing.
  manifest     JSONB NOT NULL,
  created_at   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS replay_measurements_trial_idx ON replay_measurements (trial_id);
CREATE INDEX IF NOT EXISTS replay_measurements_run_idx ON replay_measurements (run_id);

CREATE TABLE IF NOT EXISTS replay_measurement_records (
  replay_id       TEXT PRIMARY KEY,
  manifest_id     TEXT NOT NULL REFERENCES replay_measurements (manifest_id) ON DELETE CASCADE,
  replay_number   INTEGER NOT NULL,
  -- WHO RAN THE REPLAY. The independence rule is decided on this, so it is
  -- a column of its own and not something a reader has to dig out of the
  -- JSON to find.
  worker_identity TEXT NOT NULL,
  status          TEXT NOT NULL,
  record          JSONB NOT NULL,
  created_at      BIGINT NOT NULL,
  UNIQUE (manifest_id, replay_number)
);

CREATE INDEX IF NOT EXISTS replay_measurement_records_manifest_idx
  ON replay_measurement_records (manifest_id);
