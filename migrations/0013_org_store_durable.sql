-- 0013_org_store_durable.sql — the tenancy model, durable.
--
-- The organisation, its workspaces, its memberships, its invitations and its
-- resource ownership were process memory (`packages/agent-security/src/org-
-- store.ts`), which meant two things:
--
--   1. a restart lost them;
--   2. under Octane — where every worker process has its own `globalThis` —
--      two workers could disagree about who is a member of what, and the
--      answer depended on which worker answered.
--
-- The tables already existed (migration 0002). They were never written to,
-- because nothing in the repository ever inserted an organisation. This
-- migration makes them usable as the backing for the store.
--
-- Two changes, both small and both about the schema matching the domain:
--
--   * `organisations.created_by` — the domain has an author as well as an
--     owner (`newOrganisation` takes both), and the table had only the
--     owner. The author is recorded in `metadata` today, which is a place
--     nobody looks.
--
--   * the membership uniqueness constraint. The old one was UNIQUE over
--     (org_id, principal_id) — ANY second membership for a principal in an
--     organisation, including a REVOKED one. So a member who was removed
--     and came back could not be recorded: the row already existed. The
--     domain is explicit that revocation takes effect and the membership
--     can be granted again ("revocation takes effect at the next request"),
--     and the store keeps revoked memberships as history. The constraint
--     becomes a PARTIAL unique index over the ACTIVE memberships, which is
--     the rule the domain actually means: one live membership per
--     principal per organisation, with the history kept.
--
-- The row-level policies are left exactly as migration 0002 wrote them.
-- They are inert while the API connects as the table's owner (PostgreSQL
-- does not apply RLS to the owner) and they become the database's own
-- expression of the tenant boundary the day the API connects as a
-- separate, non-owning role. The policies read
-- `current_setting('crucible.current_principal_id', true)`, so the
-- principal has to be set per request for them to mean anything; that
-- wiring is the remaining step of ADR-0033 and is recorded there.

-- ---------------------------------------------------------------------------
-- The author of an organisation
-- ---------------------------------------------------------------------------

ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT '';

-- An organisation that predates the column has no recorded author; its
-- owner is the closest true answer.
UPDATE organisations
   SET created_by = owner_id
 WHERE created_by = '';

-- ---------------------------------------------------------------------------
-- One ACTIVE membership per principal per organisation
-- ---------------------------------------------------------------------------

ALTER TABLE memberships
  DROP CONSTRAINT IF EXISTS memberships_one_active_per_principal_org;

CREATE UNIQUE INDEX IF NOT EXISTS memberships_one_active_per_principal_org
  ON memberships (org_id, principal_id)
  WHERE revoked_at IS NULL;

-- The RLS policies read `expires_at`; an index on the live membership
-- lookup keeps the check cheap now that the constraint is partial.
CREATE INDEX IF NOT EXISTS memberships_principal_idx
  ON memberships (principal_id, org_id);