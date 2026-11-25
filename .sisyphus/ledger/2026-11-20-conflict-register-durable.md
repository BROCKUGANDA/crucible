# Ledger — 2026-11-20 — the conflict register is durable

## What was done

ADR-0038: the conflict-of-interest register is a record, not a memory.

**Why it mattered.** The register decides who may judge whom: it is
consulted before an Argus seat is assigned and before a reviewer grades a
submission from an affiliated principal, and a match produces a reviewable
risk signal. It was in process memory — so a conflict declared on Monday
and forgotten by Tuesday (the process restarted) was a conflict that
stopped being checked on Tuesday. The failure compounded, because the
audit record of the declaration was itself in memory (ADR-0037).

**What changed.**

- `packages/agent-security/src/org-coi.ts` — the store is pluggable and
  chosen once at boot; the register's API is async; the domain logic
  (interest key, conflict check, seat check) is unchanged and still
  derived.
- `packages/agent-security/src/org-coi-pg.ts` — the durable register.
  A duplicate declaration is refused in the SAME WORDS as the in-memory
  store, so a caller cannot tell which store it is talking to by the
  error it gets.
- `migrations/0018_org_coi_entries.sql` — `org_coi_entries`, with an RLS
  policy that follows the organisation tables' pattern (and, like theirs,
  only bites for a connection that does not own the table).
- A **withdrawal is not a deletion**: `revoke` sets `active = false`. The
  fact that a conflict was declared and then withdrawn is part of the
  history a reviewer may need.
- The interest key stays **derived** (`${type}:${orgId}` or
  `${type}:${description}`), so two declarations of the same interest
  cannot be recorded in two spellings and then fail to match.
- Boot wiring in `apps/api/src/server.ts`: `[crucible] conflict register:
  postgresql (a declaration survives a restart)`.

## Proof

- `packages/agent-security/test/org-coi.test.ts` — 11 tests.
- `packages/agent-security/test/org-coi-pg.test.ts` — 8 tests against a
  real PostgreSQL: survives a fresh read; the conflict is still found
  after a restart; a duplicate is refused in the same words; a withdrawal
  leaves the entry in place but stops it counting; the principal's and the
  organisation's declarations are listed; the seat check says which side a
  candidate is conflicted against.
- **Four mutations proven red** (`.scratch/mutate_coi.py`). **One was
  green on the first attempt because the anchor no longer matched the
  code** — the store had gained a `try` around the insert — so the
  mutation was skipping its own test rather than passing it. The same
  shape of failure as a wiring check that reads the wrong file.
- Repo-wide: `npm run typecheck` clean; `npm test` → **4,238 tests
  passed**, 0 FAIL.

## Records updated

`docs/adr/0038-the-conflict-register-is-durable.md` (+ README row),
`CRUCIBLE_AUDIT.md` (AUTHZ-D1 narrowed), `HARDENING.md`,
`docs/since-submission.md`,
`docs/product/REPOSITORY_ASSESSMENT_2026-11-20.md` §P, this ledger.

## Next steps

1. **The reviewer surface** — the register is durable but **nothing calls
   it from a route**. The next piece of product work: the review queue,
   the seat assignment screened by the interest check, the conflict
   declaration, and the abstention. That is a P1 surface, and it is where
   this register earns its place.
2. **Budgets and quotas, webhooks, API keys** — the remaining in-memory
   side models (AUTHZ-D1).
3. **The RLS role split** — the policy on the COI and audit tables, like
   the organisation tables', only bites for a connection that does not own
   the table.
