-- 0017_org_audit_entries.sql — the audit chain is durable.
--
-- An audit trail that evaporates on restart is not an audit trail. The
-- entries also have to CONTINUE across a restart: the head is the last
-- entry in this table, so a chain that restarted at "genesis" after a
-- restart would orphan every entry written before it.
--
-- `seq` is the chain's ORDER. It is a sequence, not the timestamp: two
-- entries written in the same millisecond must still have a defined
-- order, and the hash chain's order is the order they were appended.
--
-- There is no UPDATE and no DELETE anywhere in the application for this
-- table. The chain is append-only, and the columns that make it a chain
-- (prev_hash, hash) are the reason a reader can believe it.

CREATE TABLE IF NOT EXISTS org_audit_entries (
  seq          BIGSERIAL PRIMARY KEY,
  id           TEXT NOT NULL UNIQUE,
  org_id       TEXT,
  principal_id TEXT NOT NULL,
  action       TEXT NOT NULL,
  resource     TEXT,
  at           BIGINT NOT NULL,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL
);

-- The chain is read in order, and an organisation's entries are read by
-- organisation in order.
CREATE INDEX IF NOT EXISTS org_audit_entries_org_seq_idx
  ON org_audit_entries (org_id, seq);

-- Row level security, as for the other tenant-owned tables: an entry is
-- readable by the organisation it belongs to. The policy is written here
-- but, like the organisation tables', it only bites for a connection that
-- does NOT own the table — see ADR-0037 for the role split, and for what
-- is still open behind it.
ALTER TABLE org_audit_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_audit_entries_read ON org_audit_entries;
CREATE POLICY org_audit_entries_read
  ON org_audit_entries FOR SELECT
  USING (
    org_id IS NULL
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = org_audit_entries.org_id
        AND m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );
