# The organisation API keys are durable — and a revoked key does not come back

**Date**: 2026-11-20
**Branch**: `develop`
**ADR**: 0040 (`docs/adr/0040-a-revoked-key-must-not-come-back.md`)

## Why this slice

AUTHZ-D1's remaining in-memory org side models. The API keys were the
commercially urgent one (an enterprise customer authenticates with a key),
and they carried a defect that the "in memory" label hid: **a revoked key
came back**. The revocation was a field in a `globalThis` map; a restart
un-revoked it.

## What was built

| File | What it is |
|---|---|
| `packages/agent-security/src/org-api-key.ts` | the keys, a pluggable store, the async API |
| `packages/agent-security/src/org-api-key-pg.ts` | the durable store |
| `migrations/0020_org_api_keys.sql` | `org_api_keys` |
| `packages/agent-security/src/credentials.ts` | `secretEquals` exported — one comparison door |
| `apps/api/src/{orgs,server}.ts` | the call sites awaited; the boot wiring |

## The decisions

- **The revocation is the reason the keys are durable**, not the key.
- **Asynchronous throughout**: a write that cannot be awaited cannot be
  durable.
- **The durable store says the same things the in-memory store says**, in
  the same words: `org-api-key: key already exists: <id>` and
  `org-api-key: prefix collision: <prefix>`; PG's `23505` is translated.
- **A second revocation has nothing to revoke** → `false` in both stores.
- **The scope guard is inside the SQL** (`WHERE id = $1 AND org_id = $3`).
- **The hash is slow and salted**: scrypt N=16384, r=8, p=1, per-key salt,
  self-describing `scrypt$16384$8$1$<salt>$<hash>`. A hash in another
  format is refused, not guessed at. The comparison is constant-time via
  the package's existing `secretEquals` (now exported — one door).

## Evidence

- 13 unit tests (`org-api-key.test.ts`) and 13 against a real PostgreSQL
  (`org-api-key-pg.test.ts`) — 26.
- **11/11 mutations proven red** (`.scratch/mutate_api_key.py`).
- One was **green on the first attempt** because the test that should have
  caught it did not exist: the cross-organisation revocation was only
  tested against the durable store, so the in-memory guard was
  unmeasured. The test now exists (M11).

## Still open, named

- **Nothing authenticates with a key yet** — `validateApiKey` has no
  caller in the API. The door is the next piece, and until it is written
  the commercial promise is not true.
- **No server-side pepper** — an attacker with the table attacks the
  secret alone. A pepper changes the hash format: a change, not a tweak.
- Scrypt's ~80 ms per verification is a DoS surface on an unrated
  endpoint.
- Budgets and quotas, and webhook endpoints: still in process memory.
- REPL-D2, the RLS role split, the review verdict, hold timeouts.
