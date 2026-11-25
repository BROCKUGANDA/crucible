# Ledger — 2026-11-20 — the dispute evidence bundle slice

## What was done

Closed the **proceeding**: the evidence a dispute is decided on is now
frozen, addressed, and states what it does not contain.

**The gap that started it.** Nothing froze the evidence. The chain records
who broke a trial, what they staked and the proof they filed, but the
evidence those facts point to lived in three places that each moved on
their own — the disclosure log, the off-chain stores (pinned spec, replay
manifest, scores: all process memory), and the content store. A committee
reading the evidence twice could read two different sets of facts, and an
omission was indistinguishable from a completeness.

**The slice.**

- `apps/api/src/evidence-bundle.ts` — `assembleBundle`, `buildBundle`,
  `chainFactsFor`, `predatesDispute`, `verifyBundleDigest`. The address is
  the digest of the bundle's own contents (`bundle_` + 32 hex); the GAPS
  are inside the digest.
- `apps/api/src/evidence-bundle-store.ts` — the store interface, the
  in-memory store, `configureEvidenceBundleStore` (chosen once at boot,
  ADR-0033), `evidenceBundleStoreKind`.
- `apps/api/src/evidence-bundle-pg.ts` — the durable store; append-only
  (`ON CONFLICT DO NOTHING`).
- `apps/api/src/evidence-bundle-routes.ts` — `POST /v1/disputes/:trialId/bundle`
  (seal), `GET /v1/disputes/:trialId/bundles`, `GET /v1/disputes/bundles/:id`.
  Refuses a caller-supplied `gaps`/`digest`/`chain`/`measurement`/`sealedAt`/
  `bundle`/`score`/`verdict` **by name**.
- `migrations/0015_dispute_evidence_bundles.sql` — `dispute_evidence_bundles`.
- `apps/api/src/app.ts` — mounted under `/v1/disputes`, wired to the chain's
  clock (`deps.indexStatus?.().headTimestamp`).
- `apps/api/src/server.ts` — the store is chosen at boot and the boot log
  says which one.
- Web: `apps/web/src/app/disputes/[trialId]/{page.tsx,dispute-evidence.tsx,site.ts}`,
  `apps/web/src/lib/useEvidenceBundles.ts`,
  `apps/web/test/evidence-bundle-view.test.ts`; the trial page links to the
  dispute (the route-coverage gate caught the orphan).
- `packages/site-index/src/generated.ts` — regenerated (67 entries).

## Two defects found on the way

1. **The seal was compared with the break across two clocks.** The chain's
   dispute time is in chain seconds; the seal was in host milliseconds. The
   comparison divided by 1000 — but the chain's clock and the host's wall
   clock are *different clocks* (the indexer's own rule is `max(headTimestamp
   + 1, now)`), so the answer could be wrong, not just scaled. Fixed: the
   bundle records `sealedAtChainSeconds` (the chain's clock at the seal,
   read from the indexer's head timestamp) and the comparison is
   chain-seconds against chain-seconds. When the chain's clock cannot be
   read the answer is **unknown**, never a guess across two clocks.
2. **`verifyPublicationDigest` was left uncommitted** by the publication
   slice — it was in the working tree, not in `9be6d37`. It is committed now.

## Proof

- API: 12 domain tests + 8 route tests + 5 tests against a real PostgreSQL.
- Mutations: **9/9 proven red** (`.scratch/mutate_evidence_bundle.py`).
  One was **green on the first attempt** — the "the suite was not disclosed"
  gap assertion matched a substring ANOTHER gap also contained ("the break's
  proof was not disclosed") — so the assertions now name the exact sentence.
- End to end over HTTP against the live chain (`.scratch/BundleProof.mjs`):
  trial 1's real facts (sponsor `0x976EA740…`, status settled, verdict paid,
  the committed spec digest, the break and its proof) sealed into a bundle
  with three stated gaps, re-sealed to the same address, read back, and a
  caller-supplied bundle refused (`caller-supplied-evidence-refused`).
- Browser verification of `/disputes/1` against the running API and a live
  PostgreSQL: the gaps are shown BEFORE the contents, the score that was
  never recorded shows an em dash and not a zero, and the bundle sealed
  after the break says so (`.scratch/shots/dispute-bundle.png`).
- Repo-wide: `npm run typecheck` clean; `npm test` → **4,220 tests passed**,
  0 FAIL; `apps/api` with `DATABASE_URL` → **77 files / 1,180 tests**.

## Records updated

`docs/adr/0035-a-dispute-reads-a-frozen-bundle.md` (+ README row),
`CRUCIBLE_AUDIT.md` (DISP-D1), `HARDENING.md`, `docs/since-submission.md`,
`docs/product/REPOSITORY_ASSESSMENT_2026-11-20.md` §M, this ledger.

## Next steps

1. **REPL-D1** — the replay manifest store is still in memory. The bundle
   freezes a measurement that a restart can lose: the bundle then records
   something that cannot be re-derived. This is the next slice.
2. **RLS role split** (ADR after 0035) — the API still connects as the
   table owner, so the policies are inert.
3. **Reviewer queue** — the consumer of these bundles: who may take a case,
   how a conflict is declared, how an abstention is recorded.
4. The content store is a host-local directory: "the bytes behind this CID"
   is available only on the host that pinned them.
