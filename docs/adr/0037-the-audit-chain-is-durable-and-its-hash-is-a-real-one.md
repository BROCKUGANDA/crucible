# ADR-0037: The audit chain is durable, and its hash is a real one

- **Status:** accepted
- **Date:** 2026-11-20
- **Supersedes:** nothing
- **Relates to:** ADR-0023 (PostgreSQL is the app's data; the chain is the authority), ADR-0033 (the tenancy model is durable), ADR-0034 (a published score carries its limits)

## Context

The organisation audit log is what a buyer's compliance review reads: who
did what, in which organisation, and on whose authority. It was written to
be hash-chained and tamper-evident, and it was neither.

**Two defects, both found while making it durable.**

1. **The hash was not cryptographic.** The module asked for `sha256` through
   `require()` — and `require` does not exist in an ES module. The `try`
   threw, the `catch` swallowed it, and the chain was linked with a
   31-multiplier rolling hash, eight hex characters long, with a comment
   saying it was "not cryptographic but stable". A chain that is
   tamper-evident only because nobody read the code is not tamper-evident:
   anybody can recompute a forged chain. The stored hashes were eight
   characters long.

2. **The chain broke on its own redaction.** The write-time hash covered
   the RAW metadata while the entry stored the REDACTED metadata. The
   redaction list covers any key containing "key", so `{ keyId: "k-1" }` —
   an ordinary API-key issuance — was masked, and the hash no longer
   matched what was stored. `verifyChain` then reported the chain as
   **tampered after an entirely innocent write**. The raw metadata in the
   hash was a third, quieter problem: a digest of a secret is an oracle
   for that secret.

And the log was in process memory, like the rest of the side models: a
restart erased it, and a chain that restarted at "genesis" would orphan
every entry written before it.

## Decision

**1. One hashing door, over exactly what is stored.**

The entry hash is `hashCanonical` from `@crucible/crypto` (gate 629) over
the entry's own fields, its **redacted** metadata included. So:

- the hash is a real sha256 over canonical JSON — it depends on the
  CONTENT and not on the order the metadata's keys happen to be in;
- the redaction cannot break the chain, because the hash covers the
  redacted metadata that is stored;
- no secret reaches a digest, because the value that is hashed is the
  value that is stored — and that value is redacted.

**2. The chain is durable, and it continues across a restart.**

`org_audit_entries` (migration 0017) holds the entries. `seq` is the
chain's ORDER — a sequence, not the timestamp, because two entries written
in the same millisecond must still have a defined order. The chain's head
is **the last entry in the table**, not a field in a process's memory, so a
restart continues the chain instead of orphaning it.

**3. The append is serialised, and the link is checked inside the
transaction.**

The store takes a transaction-scoped advisory lock, reads the head, and
refuses an entry that does not link to it — all inside the transaction.
Two writers that both read the same head would otherwise both link to it
and fork the chain, and a forked chain verifies as broken, which is
exactly what a tamper must look like. The domain layer checks the link
too, before the store is called; the store's check is the one that stops
the fork, and it is the one that is proven.

**4. Append-only.** There is no UPDATE and no DELETE anywhere in the
application for this table.

**5. The store is chosen once, at boot**, and the boot log says which —
"postgresql (an audit entry survives a restart)" or the in-memory warning.

## Consequences

**What this buys.** The audit trail survives a restart and keeps its
integrity across one; a row edited behind the chain's back does not
verify; the log cannot accuse an operator of tampering with itself the
moment an API key is issued.

**What it costs.** The audit API is asynchronous — a write that cannot be
awaited cannot be durable. The chain is now a real chain: an entry whose
link is wrong is refused rather than appended.

**What it does not fix.** The remaining organisation side models —
budgets, conflict-of-interest declarations, webhooks and API keys — are
still in process memory, and they are named in `CRUCIBLE_AUDIT.md`. The
row-level-security policy on the audit table follows the organisation
tables' pattern, and — like theirs — it only bites for a connection that
does not own the table; the role split is still to come.

## Rejected

- **Keeping the `require()` with a fallback.** A fallback that is used by
  default is not a fallback; it is the implementation.
- **Hashing the raw metadata.** Nothing is gained and a secret reaches a
  digest.
- **Trusting the domain layer's link check alone.** It is a check outside
  the transaction, and two writers can pass it at the same time.
- **Ordering the chain by timestamp.** Two entries in the same millisecond
  would have no defined order, and the chain's order is the order things
  were appended.
- **Storing the chain head in memory.** A restart would orphan every entry
  written before it.

## Proof

- `packages/agent-security/test/org-audit.test.ts` — the hash is a real
  sha256 (64 hex) and not the fallback; it does not depend on the order of
  the metadata's keys; an entry whose metadata holds something that looks
  like a secret does not break the chain; the stored metadata never
  contains the secret; a changed entry does not verify.
- `packages/agent-security/test/org-audit-pg.test.ts` — against a real
  PostgreSQL: an entry survives a fresh read; the chain CONTINUES across a
  restart (the next entry's `prevHash` is the previous entry's hash, read
  from the table); the entries are ordered by insertion, not by the clock;
  an entry that does not link is refused; two writers cannot fork the
  chain; a row changed directly in the database is detected; the chain
  verifies after all of it.
- `.scratch/mutate_audit.py` — **six** mutations, all proven red: the
  trivial rolling hash, the hash over the raw metadata, a hash that
  depends on the key order, a volatile chain head, an append that does not
  check the link inside the transaction, and a verifier that accepts a
  changed entry.
  Two of them were **green on the first attempt** and had to be made
  honest before they proved anything: the key-order mutation was defeated
  by `hashCanonical` itself (so the mutation now hashes a plain
  `JSON.stringify`, which is what the old code did), and the
  transaction-check mutation was still caught by the domain layer's check
  (so the test now writes straight to the store, which is the only way to
  reach the check that stops the fork).
- The defect itself was reproduced against the built package before the
  fix: `verifyChain()` reported `hash_mismatch` on an innocent
  `api_key:create` entry, and the stored hash was eight hex characters.
