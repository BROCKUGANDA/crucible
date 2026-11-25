-- 0018_org_coi_entries.sql — the conflict-of-interest register is durable.
--
-- A conflict declared on Monday and forgotten by Tuesday — because the
-- process restarted — is a conflict that stopped being checked on Tuesday,
-- and the check is the whole point of the register.
--
-- A declaration is WITHDRAWN by setting active = false, never by deleting
-- it: the fact that a conflict was declared and then withdrawn is itself
-- part of the history a reviewer may need.

CREATE TABLE IF NOT EXISTS org_coi_entries (
  id            TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL,
  org_id        TEXT,
  type          TEXT NOT NULL
    CHECK (type IN ('employer', 'model-provider', 'cloud-account',
                    'sponsor-affiliation', 'reviewer-affiliation', 'other')),
  description   TEXT NOT NULL,
  disclosed_at  BIGINT NOT NULL,
  disclosed_by  TEXT NOT NULL,
  expires_at    BIGINT,
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

-- The two questions that are asked of the register: "what has this
-- principal declared?" and "who has declared an interest in this
-- organisation?".
CREATE INDEX IF NOT EXISTS org_coi_entries_principal_idx
  ON org_coi_entries (principal_id);
CREATE INDEX IF NOT EXISTS org_coi_entries_interest_idx
  ON org_coi_entries (type, org_id);

-- Row level security, as for the other tenant-owned tables: a declaration
-- is readable by the organisation it concerns. Like the organisation
-- tables' policies, it only bites for a connection that does NOT own the
-- table — see ADR-0037 for the role split, and for what is still open
-- behind it.
ALTER TABLE org_coi_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_coi_entries_read ON org_coi_entries;
CREATE POLICY org_coi_entries_read
  ON org_coi_entries FOR SELECT
  USING (
    org_id IS NULL
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = org_coi_entries.org_id
        AND m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );
