# Ledger — 2026-11-20 — the audit chain is durable, and its hash is a real one

## What was done

Closed the record that the claim, the proceeding and the rule all rest on
(ADR-0037).

**The log claimed to be hash-chained and tamper-evident, and it was
neither.**

1. **The hash was not cryptographic.** The module asked for `sha256`
   through `require()` — `require` does not exist in an ES module, so the
   `try` threw, the `catch` swallowed it, and the chain was linked with a
   31-multiplier rolling hash, **eight hex characters** long. The stored
   hashes really were eight characters: reproduced against the built
   package before the fix.
2. **The chain broke on its own redaction.** The write-time hash covered
   the RAW metadata while the entry stored the REDACTED metadata. The
   redaction list covers any key containing "key", so an ordinary
   `api_key:create` entry (`{ keyId: "k-1" }`) produced a hash that no
   longer matched what was stored — and `verifyChain` reported the chain
   as **tampered after an innocent write**. Reproduced:
   `{ valid: false, brokenAt: "e2", reason: "hash_mismatch" }` on a chain
   of two ordinary entries. The raw metadata inside the hash was also a
   digest of a secret, which is an oracle for that secret.
3. **The log was in process memory**, and a chain that restarted at
   "genesis" would orphan every entry written before it.

**Now.** The hash is `hashCanonical` from `@crucible/crypto` (the
repository's one hashing door) over exactly what is stored — a real sha256
over canonical JSON, over the REDACTED metadata. The chain is durable
(`org_audit_entries`, migration 0017), ordered by a **sequence** rather
than by the clock, and it CONTINUES across a restart: the head is the
last row in the table. The append takes a transaction-scoped advisory
lock and checks the link INSIDE the transaction, so two writers cannot
both link to the same head and fork the chain.

## Proof

- `packages/agent-security/test/org-audit.test.ts` — the hash is 64 hex,
  not the fallback; it does not depend on the metadata's key order; a
  secret-looking key does not break the chain; the stored metadata never
  holds the secret; a changed entry does not verify.
- `packages/agent-security/test/org-audit-pg.test.ts` — 8 tests against a
  real PostgreSQL: survives a fresh read; the chain continues across a
  restart; insertion order, not clock order; an entry that does not link is
  refused; two writers cannot fork the chain; a row changed directly in
  the database is detected; the chain verifies after all of it.
- **Six mutations proven red** (`.scratch/mutate_audit.py`).
  **Two were green on the first attempt and had to be made honest before
  they proved anything**: the key-order mutation was defeated by
  `hashCanonical` itself (so the mutation now hashes a plain
  `JSON.stringify` — what the old code did), and the transaction-check
  mutation was still caught by the domain layer's check (so the test now
  writes straight to the store, the only way to reach the check that
  stops the fork).
- Repo-wide: `npm run typecheck` clean; `npm test` → **4,238 tests
  passed**, 0 FAIL; `apps/api` against a real PostgreSQL → 78 files / 1,197
  tests; `packages/agent-security` → 23 files / 442 tests.

## Records updated

`docs/adr/0037-the-audit-chain-is-durable-and-its-hash-is-a-real-one.md`
(+ README row), `CRUCIBLE_AUDIT.md` (**AUDIT-D1**), `HARDENING.md`,
`docs/since-submission.md`,
`docs/product/REPOSITORY_ASSESSMENT_2026-11-20.md` §O, this ledger.

## Next steps

1. **The remaining organisation side models** — budgets, COI declarations,
   webhooks, API keys — are still in process memory. The audit trail is
   durable; the things it audits are not. This is the same slice, still
   open, and it is the last of AUTHZ-D1.
2. **The RLS role split** — the policy on the audit table, like the
   organisation tables', only bites for a connection that does not own the
   table.
3. **The multi-worker fleet** (ADR-0030) — without it, no surface can
   claim independent reproduction.
4. The RLS role split and the remaining side models are the same
   conversation: who may see what, and whether the database enforces it.
