-- 0014_published_methods.sql — the method card of a published score.
--
-- A published score is a number; a published METHOD is the number plus how
-- it was measured and what it does not establish. The method is the part
-- that has to outlive the process: a card that evaporates on restart is a
-- claim with no record.
--
-- The card is APPEND-ONLY and content-addressed. Its primary key is derived
-- from the digest of its own contents, so:
--
--   - publishing the same method twice yields the same row (no duplicate);
--   - a card can never be edited, because any change produces a different
--     address and therefore a different row.
--
-- Two comparisons live here as well, because a comparison that cannot be
-- recorded is a comparison nobody can check:
--
--   - `publication_comparisons` — what was compared, and the verdict:
--     comparable, or not comparable with the reason.
--
-- Every column that carries a number is TEXT. A score in basis points
-- crosses as an integer string; nothing here rounds.

-- ---------------------------------------------------------------------------
-- Published methods
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS published_methods (
  id                TEXT PRIMARY KEY,
  -- The content address over the card's contents. The id is a prefix of it.
  digest            TEXT NOT NULL,
  -- What the card is about.
  subject_kind      TEXT NOT NULL CHECK (subject_kind IN ('run','trial')),
  subject_id        TEXT NOT NULL,
  agent_id          TEXT,
  -- The key two publications must share to be comparable: suite digest,
  -- rubric, judge version.
  comparability_key TEXT NOT NULL,
  -- The whole card, as published. The columns above are the indexes into
  -- it; this is the record.
  card              JSONB NOT NULL,
  published_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS published_methods_subject_idx
  ON published_methods (subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS published_methods_comparability_idx
  ON published_methods (comparability_key);
CREATE INDEX IF NOT EXISTS published_methods_digest_idx
  ON published_methods (digest);

-- ---------------------------------------------------------------------------
-- Comparisons
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS publication_comparisons (
  id            TEXT PRIMARY KEY,
  left_id       TEXT NOT NULL REFERENCES published_methods(id) ON DELETE CASCADE,
  right_id      TEXT NOT NULL REFERENCES published_methods(id) ON DELETE CASCADE,
  comparable    BOOLEAN NOT NULL,
  -- Why not, when not. In words, because a comparison without a reason is
  -- not usable by the person who has to act on it.
  reason        TEXT NOT NULL,
  differences   JSONB NOT NULL DEFAULT '[]'::JSONB,
  compared_at   BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS publication_comparisons_left_idx
  ON publication_comparisons (left_id);
CREATE INDEX IF NOT EXISTS publication_comparisons_right_idx
  ON publication_comparisons (right_id);
