# 2026-11-20 — The published method (slice after ADR-0033)

## What this slice did

Closed the claim surface: a Studio run is now a **record** that can be
published, and a publication is a **content-addressed method card** carrying
what was measured and **what the score does not establish**.

- `apps/api/src/publication.ts` — the domain: the card, the DERIVED limits,
  the comparability verdict.
- `apps/api/src/publication-store.ts` — the store interface, the in-memory
  store, and the boot-time selection (ADR-0033's rule).
- `apps/api/src/publication-pg.ts` — the durable store (append-only,
  content-addressed).
- `apps/api/src/publication-routes.ts` — `/v1/publications` (publish, read,
  list) and `/v1/publications/compare`; refuses a caller-supplied score,
  verdict, status, limits or digest **by name**.
- `migrations/0014_published_methods.sql` — `published_methods`,
  `publication_comparisons`.
- `apps/api/src/evaluation-spec.ts` — `computeMeasurementKey()` (the
  measurement without the subject) and the module's hashing migrated to the
  repository's one canonical JSON door (gate 629).
- `apps/api/src/studio-routes.ts` — a Studio run now writes a replay manifest
  and one replay record per replay (including the replays that produced no
  evidence) and returns the identifiers needed to publish it.
- `apps/web/src/app/publications/**`, `apps/web/src/lib/usePublications.ts`
  and `apps/web/src/lib/publication-id.ts` — the reading surface.

## Three defects found on the way (all fixed)

1. `apps/api/src/suites-routes.ts:126` passed a principal **object** where a
   content address belongs (`createSuiteVersion(input, { principalId } as
   any)`), and `pgCreateSuiteVersion` never wrote the NOT NULL `spec_digest`
   column at all — the durable path could not insert. Now
   `computeSuiteVersionDigest()` hashes the version's content.
2. The evaluation spec hashed with a hand-rolled `JSON.stringify` — a second
   hashing convention. Now the one door.
3. `runMigrations()` took **no lock**: two processes migrating at once
   deadlocked ("tuple concurrently updated"), and the API migrates on boot.
   Now a PostgreSQL advisory lock, session-scoped, released on the same
   client.

## Proof

- 15 domain tests + 9 route tests + 8 tests against a real PostgreSQL 17.
- **8 mutations proven red** (`.scratch/mutate_publication.py`).
- End-to-end over HTTP (`.scratch/PublicationProof.mjs`): Studio →
  REPRODUCIBLE → publish → republish gives the SAME address → read back →
  compare → caller-supplied score refused 400.
- **Restart proof**: the API was killed and restarted; the cards were still
  there, read straight out of PostgreSQL.
- Browser verification (Edge headless, real URL): `/publications` and
  `/publications/<id]` — screenshots in `.scratch/shots/`.

## Environment

- Anvil `:8555` (PID 27268), PostgreSQL 17 `:5433` (PID 34876).
- API `:8787` with `.scratch/api.env` (DATABASE_URL set → durable).
- Web `:3210` (`next start`, built with `next build --webpack`).

## Next steps

1. **REPL-D1 — make the replay manifest store durable.** The card is
   durable; the measurement it describes is not. This is the next slice.
2. The RLS role split (ADR-0033's next step): the API must connect as a
   non-owning role and set the principal per request.
3. The org-scoped side models (budgets, audit, COI, webhooks, API keys) are
   still in memory.
4. Then the remaining P1 surfaces: dispute evidence bundle, reviewer queue
   with conflict declaration and abstention, comparison studio, agent
   directory, evidence inspector, trial timeline.
