-- 0015_dispute_evidence_bundles.sql — the frozen evidence of a dispute.
--
-- When a break is filed, the committees read an EVIDENCE BUNDLE: what the
-- chain committed to, what the platform measured, and — stated in the
-- bundle itself — what is missing from it.
--
-- The bundle is append-only and content-addressed:
--
--   - the id is derived from the digest of the bundle's own contents, so a
--     bundle can never be edited. A change produces a different address and
--     a different row, and the old row keeps saying what it said when the
--     dispute opened.
--   - publishing the same freeze twice is the same row, so the store cannot
--     accumulate duplicates.
--
-- The chain facts are stored as they were read; the measurement as it was
-- frozen. Nothing here is recomputed on read: a bundle that was rebuilt
-- from today's data would be a different bundle, and the parties agreed on
-- THIS one.

CREATE TABLE IF NOT EXISTS dispute_evidence_bundles (
  id          TEXT PRIMARY KEY,
  -- The subject: the chain's trial id, as a string.
  trial_key   TEXT NOT NULL,
  -- The content address over the bundle's contents. The id is a prefix of it.
  digest      TEXT NOT NULL,
  -- The whole bundle, as sealed. The columns above index into it; this is
  -- the record.
  bundle      JSONB NOT NULL,
  -- When the freeze happened, in milliseconds.
  sealed_at   BIGINT NOT NULL,
  -- Whether the bundle predates the dispute it belongs to. Null when the
  -- chain has not said when the dispute opened.
  predates_dispute BOOLEAN
);

CREATE INDEX IF NOT EXISTS dispute_evidence_bundles_trial_idx
  ON dispute_evidence_bundles (trial_key);
CREATE INDEX IF NOT EXISTS dispute_evidence_bundles_sealed_idx
  ON dispute_evidence_bundles (sealed_at);
CREATE INDEX IF NOT EXISTS dispute_evidence_bundles_digest_idx
  ON dispute_evidence_bundles (digest);
