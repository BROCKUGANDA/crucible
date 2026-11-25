-- 0019_review_claims.sql — the reviewer's own state is durable.
--
-- The CASES are chain-derived: a trial open for review is a fact the chain
-- holds, and the indexer re-reads it after a restart. What the chain does
-- NOT hold is the reviewer's side of it — who has claimed a case, who has
-- abstained from one, and why.
--
-- A queue that forgets its claims after a restart is a queue where two
-- reviewers believe they hold the same case, and the second one to finish
-- is refused by the platform for no stated reason.

CREATE TABLE IF NOT EXISTS review_claims (
  -- One case, one holder. The uniqueness is on the CASE, not on the pair:
  -- a pair's uniqueness would allow one reviewer to hold many cases while
  -- two reviewers could hold one.
  trial_id    INTEGER PRIMARY KEY,
  reviewer    TEXT NOT NULL,
  claimed_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS review_claims_reviewer_idx ON review_claims (reviewer);

CREATE TABLE IF NOT EXISTS review_abstentions (
  trial_id      INTEGER NOT NULL,
  reviewer      TEXT NOT NULL,
  -- Why the reviewer stepped away. Recorded verbatim: this is the reviewer's
  -- own words about their own conflict, and paraphrasing it would be the
  -- platform editing the reason.
  reason       TEXT NOT NULL,
  abstained_at BIGINT NOT NULL,
  PRIMARY KEY (trial_id, reviewer)
);

CREATE INDEX IF NOT EXISTS review_abstentions_reviewer_idx
  ON review_abstentions (reviewer);
