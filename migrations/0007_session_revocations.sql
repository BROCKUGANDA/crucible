-- Persistent SIWE session revocation.
--
-- Logout previously cleared the cookie and kept an in-memory denylist, so a
-- revoked session came back to life on the next process restart (and on every
-- other API instance). The denylist is now mirrored here; the in-memory set is
-- still the fast path, loaded from this table at boot.
CREATE TABLE IF NOT EXISTS session_revocations (
  token_hash TEXT PRIMARY KEY,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);