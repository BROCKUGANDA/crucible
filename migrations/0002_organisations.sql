-- 0002_organisations.sql
-- Tenancy foundation (ADR-0022, ADR-0023): organisations, workspaces, memberships,
-- invitations and resource ownership, each tenant-scoped with PostgreSQL RLS.
-- Idempotent: runMigrations executes all .sql files in order without a tracking table.

-- Organisations are the tenant boundary. Every row carries org_id (tenant_id)
-- and composite foreign keys prevent cross-tenant references.
CREATE TABLE IF NOT EXISTS organisations (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  owner_id      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at    BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  metadata      JSONB NOT NULL DEFAULT '{}'::JSONB,
  CONSTRAINT organisations_slug_lower CHECK (slug = lower(slug))
);

CREATE INDEX IF NOT EXISTS organisations_owner_id_idx ON organisations (owner_id);
CREATE INDEX IF NOT EXISTS organisations_status_idx ON organisations (status);

-- Workspaces sit inside one organisation.
CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  created_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  created_by  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  metadata    JSONB NOT NULL DEFAULT '{}'::JSONB,
  CONSTRAINT workspaces_slug_lower CHECK (slug = lower(slug)),
  CONSTRAINT workspaces_one_per_org_slug UNIQUE (org_id, slug)
);

CREATE INDEX IF NOT EXISTS workspaces_org_id_idx ON workspaces (org_id);
CREATE INDEX IF NOT EXISTS workspaces_status_idx ON workspaces (status);

-- Memberships bind a wallet principal to an organisation, optionally scoped to a workspace.
CREATE TABLE IF NOT EXISTS memberships (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  role         TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  created_at   BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  created_by   TEXT NOT NULL,
  revoked_at   BIGINT,
  expires_at   BIGINT,
  CONSTRAINT memberships_one_active_per_principal_org UNIQUE (org_id, principal_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS memberships_one_active_per_principal_org_uq
  ON memberships (org_id, principal_id) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS memberships_org_id_idx ON memberships (org_id);
CREATE INDEX IF NOT EXISTS memberships_principal_id_idx ON memberships (principal_id);
CREATE INDEX IF NOT EXISTS memberships_workspace_id_idx ON memberships (workspace_id);
CREATE INDEX IF NOT EXISTS memberships_revoked_expires_idx ON memberships (revoked_at, expires_at);

-- Invitations are time-boxed, single-use, optionally domain-restricted.
CREATE TABLE IF NOT EXISTS invitations (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  project_id   TEXT,
  email        TEXT,
  domain       TEXT,
  role         TEXT NOT NULL,
  inviter_id   TEXT NOT NULL,
  created_at   BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  expires_at   BIGINT NOT NULL,
  accepted_at  BIGINT,
  accepted_by  TEXT,
  revoked_at   BIGINT,
  nonce        TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
  used         BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS invitations_org_id_idx ON invitations (org_id);
CREATE INDEX IF NOT EXISTS invitations_nonce_idx ON invitations (nonce);

-- Resource ownership: a run, benchmark, dataset, evaluation or artifact owned inside a tenant.
CREATE TABLE IF NOT EXISTS resources (
  resource_id        TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  workspace_id       TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  owner_principal_id TEXT NOT NULL,
  created_at         BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  visibility         TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','org','public'))
);

CREATE INDEX IF NOT EXISTS resources_org_id_idx ON resources (org_id);
CREATE INDEX IF NOT EXISTS resources_owner_principal_id_idx ON resources (owner_principal_id);
CREATE INDEX IF NOT EXISTS resources_visibility_idx ON resources (visibility);

-- ------------------------------------------------------------------
-- Row Level Security: every tenant-owned row carries org_id and every
-- query is tenant-scoped. RLS is the second boundary, service-layer
-- scoping is the first. Policies are permissive-by-default only when
-- a session's org_id matches the row's org_id.
-- ------------------------------------------------------------------

ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;

-- Organisations: readable only by members of that org.
DROP POLICY IF EXISTS organisations_member_read ON organisations;
CREATE POLICY organisations_member_read
  ON organisations FOR SELECT
  USING (
    owner_id = current_setting('crucible.current_principal_id', true)
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = organisations.id
        AND m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );

DROP POLICY IF EXISTS organisations_owner_write ON organisations;
CREATE POLICY organisations_owner_write
  ON organisations FOR ALL
  USING (
    owner_id = current_setting('crucible.current_principal_id', true)
  )
  WITH CHECK (
    owner_id = current_setting('crucible.current_principal_id', true)
  );

-- Workspaces: readable by org members, writable by org owners/admins.
DROP POLICY IF EXISTS workspaces_member_read ON workspaces;
CREATE POLICY workspaces_member_read
  ON workspaces FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = workspaces.org_id
        AND m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );

DROP POLICY IF EXISTS workspaces_admin_write ON workspaces;
CREATE POLICY workspaces_admin_write
  ON workspaces FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = workspaces.org_id
        AND m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.role IN ('org.owner','org.billing.admin')
        AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = workspaces.org_id
        AND m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.role IN ('org.owner','org.billing.admin')
        AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );

-- Memberships: readable by org members, writable by org owners.
DROP POLICY IF EXISTS memberships_member_read ON memberships;
CREATE POLICY memberships_member_read
  ON memberships FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM memberships m2
      WHERE m2.org_id = memberships.org_id
        AND m2.principal_id = current_setting('crucible.current_principal_id', true)
        AND m2.revoked_at IS NULL
        AND (m2.expires_at IS NULL OR m2.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );

DROP POLICY IF EXISTS memberships_owner_write ON memberships;
CREATE POLICY memberships_owner_write
  ON memberships FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM memberships m2
      WHERE m2.org_id = memberships.org_id
        AND m2.principal_id = current_setting('crucible.current_principal_id', true)
        AND m2.role = 'org.owner'
        AND m2.revoked_at IS NULL
        AND (m2.expires_at IS NULL OR m2.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM memberships m2
      WHERE m2.org_id = memberships.org_id
        AND m2.principal_id = current_setting('crucible.current_principal_id', true)
        AND m2.role = 'org.owner'
        AND m2.revoked_at IS NULL
        AND (m2.expires_at IS NULL OR m2.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );

-- Invitations: readable by org members, writable by org owners.
DROP POLICY IF EXISTS invitations_member_read ON invitations;
CREATE POLICY invitations_member_read
  ON invitations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM memberships m2
      WHERE m2.org_id = invitations.org_id
        AND m2.principal_id = current_setting('crucible.current_principal_id', true)
        AND m2.revoked_at IS NULL
        AND (m2.expires_at IS NULL OR m2.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );

DROP POLICY IF EXISTS invitations_owner_write ON invitations;
CREATE POLICY invitations_owner_write
  ON invitations FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM memberships m2
      WHERE m2.org_id = invitations.org_id
        AND m2.principal_id = current_setting('crucible.current_principal_id', true)
        AND m2.role = 'org.owner'
        AND m2.revoked_at IS NULL
        AND (m2.expires_at IS NULL OR m2.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM memberships m2
      WHERE m2.org_id = invitations.org_id
        AND m2.principal_id = current_setting('crucible.current_principal_id', true)
        AND m2.role = 'org.owner'
        AND m2.revoked_at IS NULL
        AND (m2.expires_at IS NULL OR m2.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );

-- Resources: public resources readable by all, org/private resources restricted.
DROP POLICY IF EXISTS resources_public_read ON resources;
CREATE POLICY resources_public_read
  ON resources FOR SELECT
  USING (visibility = 'public');

DROP POLICY IF EXISTS resources_org_member_read ON resources;
CREATE POLICY resources_org_member_read
  ON resources FOR SELECT
  USING (
    visibility IN ('org','public')
    AND EXISTS (
      SELECT 1 FROM memberships m2
      WHERE m2.org_id = resources.org_id
        AND m2.principal_id = current_setting('crucible.current_principal_id', true)
        AND m2.revoked_at IS NULL
        AND (m2.expires_at IS NULL OR m2.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );

DROP POLICY IF EXISTS resources_owner_write ON resources;
CREATE POLICY resources_owner_write
  ON resources FOR ALL
  USING (
    owner_principal_id = current_setting('crucible.current_principal_id', true)
  )
  WITH CHECK (
    owner_principal_id = current_setting('crucible.current_principal_id', true)
  );
