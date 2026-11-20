# ADR-0038: The conflict register is durable

- **Status:** accepted
- **Date:** 2026-11-20
- **Supersedes:** nothing
- **Relates to:** ADR-0033 (the tenancy model is durable; the store is chosen once, at boot), ADR-0034 (a published score carries its limits), ADR-0037 (the audit chain is durable)

## Context

The conflict-of-interest register records the affiliations between
principals and organisations, model providers, cloud accounts and other
economic interests. It is consulted before an Argus seat is assigned and
before a reviewer grades a submission from an affiliated principal, and a
match produces a **reviewable risk signal** — not a determination of
collusion.

It was in process memory. A conflict declared on Monday and forgotten by
Tuesday — because the process restarted — is a conflict that stopped being
checked on Tuesday, and the check is the whole point of the register. The
audit trail that records the declaration was itself in memory (ADR-0037),
so the two failures compounded: the declaration and its record both
disappeared together.

The register was also **dead**: nothing in the API called it. Its own
tests passed because they called it directly.

## Decision

**1. The register is durable.** `org_coi_entries` (migration 0018) holds
the declarations. The store is chosen once, at boot (ADR-0033's rule), and
the boot log says which — "postgresql (a declaration survives a restart)"
or the in-memory warning.

**2. A withdrawal is not a deletion.** `revoke` sets `active = false`.
The fact that a conflict WAS declared and then withdrawn is part of the
history a reviewer may need; a register that erases its own declarations
is a register that cannot be audited.

**3. The durable store says the same things the in-memory store says.** A
duplicate declaration is refused in the same words in both, so a caller
cannot tell which store it is talking to by the error it gets.

**4. The interest key stays derived.** Two principals conflict when they
share an interest key — `${type}:${orgId}` or `${type}:${description}`.
The key is computed, never written, so two declarations of the same
interest cannot be recorded in two spellings and then fail to match.

**5. The store is still not wired into a surface.** The register is now a
record rather than a memory, but the reviewer surface that would consult
it — the seat assignment and the review queue — does not exist yet. That
is named below rather than left implied: **the register is durable; the
check that depends on it is still to come.**

## Consequences

**What this buys.** A declaration outlives the process that made it, and
the conflict check keeps working after a restart — on the same data.

**What it costs.** The register's API is asynchronous, like the audit
chain's.

**What it does not fix.** Nothing yet calls the register from a route, so
no seat assignment or review is actually being screened by it. The
row-level-security policy follows the organisation tables' pattern, and —
like theirs — it only bites for a connection that does not own the table.

## Rejected

- **Deleting a withdrawn declaration.** The withdrawal is part of the
  history.
- **Letting the caller state the interest key.** A derived key cannot
  disagree with the data it describes; a written one can.
- **Wiring the register to a route in this change.** A half-built review
  surface would be a surface that announces a check it does not perform.

## Proof

- `packages/agent-security/test/org-coi.test.ts` — the register's
  behaviour: declarations, duplicates, withdrawal, and the conflict check
  (shared interest, not shared principal).
- `packages/agent-security/test/org-coi-pg.test.ts` — against a real
  PostgreSQL: a declaration survives a fresh read; the conflict is still
  found after a restart (a fresh store over the same table); a duplicate is
  refused in the same words as the in-memory store; a withdrawal leaves
  the entry in place but stops it counting; the principal's declarations
  and the organisation's are listed; the seat check says which side a
  candidate is conflicted against.
- `.scratch/mutate_coi.py` — **four** mutations, all proven red: the
  store forgets a declaration, a withdrawn declaration still counts, the
  conflict check compares principals instead of interests, and the store
  forgets the interest an entry belongs to.
