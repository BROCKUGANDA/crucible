# ADR-0040 — A revoked key must not come back

- **Status**: accepted
- **Date**: 2026-11-20
- **Deciders**: platform engineering
- **Supersedes**: none
- **Relates to**: ADR-0006 (the API holds no chain key), ADR-0008 (no database, by design — now superseded), ADR-0033 (stores are chosen once at boot)

## Context

The organisation API keys existed, were created, were listed and were revoked — and
**nothing authenticated with them**. `validateApiKey` had no caller outside its own
tests. A credential that no door accepts is a credential that only exists on a
spreadsheet.

The keys themselves lived in process memory, behind a `globalThis` map. The defect
that made them durable was not that a key was lost (a lost key is an inconvenience;
the organisation can make another one). It was that **a revoked key came back**:

- the revocation was a field in memory;
- the process restarted — a deploy, a crash, an Octane worker recycling;
- the key was valid again.

The moment a credential is most likely to be tried again is right after somebody
rotated it in a hurry, because that is when somebody asks "did the old key really
stop working?" — and the platform's answer was a restart-dependent yes.

## Decision

**The keys are durable, and the revocation is the reason.**

- `org_api_keys` (migration `0020`) holds the keys. The store is chosen once at boot
  (ADR-0033's rule) and the boot log says which:
  `[crucible] api keys: postgresql (a revocation survives a restart)`.
- The API is asynchronous throughout: `createApiKey`, `getApiKey`,
  `getApiKeyByPrefix`, `listApiKeysForOrg`, `validateApiKey`, `revokeApiKey` and
  `rotateApiKey` all return promises. A write that cannot be awaited cannot be
  durable.
- **The durable store says the same things the in-memory store says**, in the same
  words: a duplicate id is `org-api-key: key already exists: <id>` and a colliding
  prefix is `org-api-key: prefix collision: <prefix>`. PostgreSQL's `23505` is
  translated rather than leaked.
- **A second revocation has nothing to revoke** and says so in both stores
  (`false`), because the second call changed nothing.

### The hash is slow and salted

The old hash was `HMAC-SHA256(key = secret, message = "")` — a fast one-way function
of the secret with **no salt**. A stolen table of those digests is a gift to a GPU:
billions of SHA-256 candidates a second, and no two keys share a salt to slow a
lookup.

The hash is now **scrypt** (N=16384, r=8, p=1) with a per-key random salt, and the
stored form describes itself: `scrypt$16384$8$1$<salt>$<hash>`. A hash in another
format is **not** accepted as "valid with a different algorithm" — it is a hash this
code does not understand, and saying yes would be a guess.

The comparison is constant-time, and it goes through the package's existing
`secretEquals` rather than a second copy of it.

### The scope guard is part of the statement

A caller revoking within one organisation must not revoke another organisation's key
(CRU-IAM-002). In the durable store the guard is in the SQL
(`WHERE id = $1 AND org_id = $3`), not a check outside it — a check outside a
statement is a check that a concurrent write can slip between.

## Consequences

**Good**

- A revoked key stays revoked across a restart, a deploy and an Octane worker
  recycling. Proven against a real PostgreSQL: a claim written, a revocation
  written, a **fresh store object over the same table** reads the revocation back and
  the key refuses to authenticate.
- A stolen table of key hashes is no longer a dictionary attack.
- The organisation's credential inventory survives a restart.

**Bad, and named**

- **Nothing authenticates with the key yet.** `validateApiKey` still has no caller in
  the API: the key is created, listed and revoked, and the door that would accept it
  is not written. That is the next piece, and until it is written the commercial
  promise ("your team polls the API with a key") is not yet true.
- There is **no server-side pepper**: the salt is per key and stored beside the hash,
  so an attacker with the table still attacks the secret alone. A pepper belongs in
  the environment, not in the database, and adding one changes the hash format — so
  it is a change, not a tweak, and it is named rather than smuggled in.
- Scrypt costs ~80 ms per verification. That is the right price for a credential
  check, and it is also a denial-of-service surface if an unauthenticated endpoint
  verifies keys without a rate limit.
- The keys are read-only by construction: a key cannot authorise a write, because
  writes require a wallet-signed SIWE session (ADR-0006). A key that could write
  would be a key that could move money.

## References

- `packages/agent-security/src/org-api-key.ts` — the keys, the hashing, the store
  interface
- `packages/agent-security/src/org-api-key-pg.ts` — the durable store
- `migrations/0020_org_api_keys.sql`
- `apps/api/src/orgs.ts` — the create/list/revoke routes (now awaited)
- `packages/agent-security/test/{org-api-key,org-api-key-pg}.test.ts`
