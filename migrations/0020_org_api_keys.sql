-- 0020_org_api_keys.sql — the organisation API keys are durable.
--
-- The defect that made this table necessary was not that a key was lost:
-- it was that a REVOKED key came back. The revocation lived in process
-- memory, so a restart un-revoked every key the organisation had revoked
-- — and the moment a credential is most likely to be tried again is right
-- after somebody rotated it in a hurry.
--
-- The secret is NEVER stored: only its hash (the secret is the HMAC key,
-- so the digest is a function of the secret and nothing else), and the
-- first eight characters in the clear — the prefix is how a key is FOUND
-- and how a reader tells two keys apart.

CREATE TABLE IF NOT EXISTS org_api_keys (
  id            TEXT PRIMARY KEY,
  -- the organisation the key acts for. The reference is deliberately not a
  -- foreign key: the organisation table is filled at boot from its own
  -- store, and a key that cannot be created because an organisation has
  -- not been seen yet is a key the tooling cannot create.
  org_id        TEXT NOT NULL,
  name          TEXT NOT NULL,
  -- the public half of the credential: the first eight characters of the
  -- secret, used for lookup and for display.
  prefix        TEXT NOT NULL,
  -- the hash of the secret. One-way, and compared in constant time.
  secret_hash   TEXT NOT NULL,
  -- the scopes this key may read. A key can never authorise a write
  -- (ADR-0006): writes require a wallet-signed session.
  scopes        TEXT[] NOT NULL DEFAULT '{}',
  -- the resources the key may reach, or NULL for the whole organisation.
  resource_scope TEXT[],
  expires_at    BIGINT,
  created_at    BIGINT NOT NULL,
  created_by    TEXT NOT NULL,
  last_used_at  BIGINT,
  -- the revocation. Durable, because a revocation that a restart undoes
  -- is not a revocation.
  revoked_at    BIGINT,
  -- the rotation chain: which key this one replaced, and which replaced it.
  rotated_from  TEXT,
  rotated_to    TEXT
);

-- The prefix is how a presentation is looked up, and it must be unique:
-- two keys with one prefix would make the credential ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS org_api_keys_prefix_key ON org_api_keys (prefix);

CREATE INDEX IF NOT EXISTS org_api_keys_org_idx ON org_api_keys (org_id);
