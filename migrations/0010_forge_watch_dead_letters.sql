-- Durable dead-letter store for Forge Watch telemetry delivery (RUN-H1 / RUN-M3).
--
-- The Redis queue named "forge-watch-dlq" was the whole dead-letter mechanism:
-- a payload that exhausted its retries was pushed onto it and nothing could read
-- it back. Redis is a cache here, not the system of record — a flush, a
-- redeploy or an eviction took the evidence with it, and there was no way to
-- replay a quarantined message because no message survived to be replayed.
--
-- This table is the durable record. It is written by the same process that
-- gives up on a delivery, survives the queue, and supports an explicit
-- operator-driven replay. Retention is not implied: rows carry their own
-- created_at so a sweep can keep what an operator still needs, and the
-- resolution columns keep the history of what was done about it.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS), consistent with every other
-- migration in this directory.

CREATE TABLE IF NOT EXISTS forge_watch_dead_letters (
  id           BIGSERIAL PRIMARY KEY,
  -- Which subsystem gave up: "forge-watch-l0", "forge-watch-relay", ...
  source       TEXT NOT NULL,
  -- The idempotency key of the original delivery, so a replay is recognisable
  -- as the same message rather than a new one.
  event_id     TEXT,
  job_id       TEXT,
  job_name     TEXT NOT NULL,
  -- The payload as it was to be delivered. JSONB, not a string: an operator
  -- replaying this needs the structure, and a stringified payload would have
  -- to be re-parsed under a schema nobody wrote down.
  payload      JSONB NOT NULL,
  -- Why the delivery failed. The last error, not the first: the first is
  -- usually the symptom and the last is usually the cause.
  error        TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 1,
  -- pending    : quarantined, awaiting an operator decision
  -- replayed   : re-queued for delivery; the original outcome is still kept
  -- resolved   : handled deliberately (the delivery succeeded after a replay,
  --              or an operator accepted the loss)
  status       TEXT NOT NULL DEFAULT 'pending',
  replayed_at  BIGINT,
  resolved_at  BIGINT,
  created_at   BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

-- The queue of work an operator has to look at: not resolved, oldest first.
CREATE INDEX IF NOT EXISTS forge_watch_dead_letters_pending_idx
  ON forge_watch_dead_letters (source, created_at)
  WHERE status = 'pending';

-- One live dead letter per (source, event_id). A redelivery that fails again
-- updates the existing row instead of stacking a second copy of the same
-- message, so "how many times has this failed" stays answerable.
CREATE UNIQUE INDEX IF NOT EXISTS forge_watch_dead_letters_identity_idx
  ON forge_watch_dead_letters (source, COALESCE(event_id, job_id))
  WHERE status IN ('pending', 'replayed');
