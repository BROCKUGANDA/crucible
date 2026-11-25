# Ledger — 2026-11-20 — the independence rule, and the measurement that survives a restart

## What was done

Closed the rule that every published score rests on (ADR-0036), and made
the measurement behind it durable.

**The rule was decorative.** The network quotes "three INDEPENDENT replays
of the same pinned task must produce the same result". The state machine
counted completed replays and compared their outputs; it never looked at
who ran them. The Studio filled each replay's `workerIdentity` with the
CALLER's own label — so a caller could satisfy any independence check by
naming its replays `worker-a`, `worker-b`, `worker-c`, and the published
card quoted the rule while listing those labels as though they were
workers.

**The measurement was in memory.** The replay manifest was a module map: a
restart erased it, and a published card and a frozen dispute bundle were
left describing a measurement that could no longer be re-derived.

**Now.**

- `replay-policy.ts` owns `REQUIRED_REPLAYS` and `REQUIRED_REPLAY_WORKERS`
  (the hard-coded `3`s in `replay-manifest.ts` are gone).
- The worker identity is DERIVED — the party the observation came from —
  and the caller's label is kept, shown, never consulted.
- `REPRODUCIBLE` requires three agreeing replays from three different
  workers; otherwise `INCONCLUSIVE`, with the manifest saying WHICH of the
  two reasons it is (`reproducibilityNote`).
- The published card carries `workers` and `independent`, and a derived
  limit ("this is agreement, not independent reproduction") — inside the
  digest, so two cards differing only in independence have different
  addresses.
- The Studio's verdict names became `AGREED` / `NOT_AGREED`, and the
  response carries an `independence` block (workers, required, independent,
  reason) next to the verdict. The web page shows it next to the verdict.
- The measurement is durable: `replay_measurements` and
  `replay_measurement_records` (migration 0016), the store chosen once at
  boot, and the replay API is **async** — a write that cannot be awaited
  cannot be durable. A replay record's identity can never be rewritten;
  only its status and output may move.

## Defects and collisions found on the way

1. **Migration 0008 already owns `replay_manifests` / `replay_records`**,
   with a different, spec-bound model (NOT NULL `evaluation_spec_id`,
   `trial_revision_hash`, `manifest_digest`; a `replay_status` CHECK that
   excludes `RUNNING`) and **nothing in the codebase writes them**. The
   first attempt at migration 0016 collided with those tables and the
   migration failed on a real PostgreSQL: *"column trial_id does not
   exist"*. Reusing them would have meant inventing values the live model
   does not have. The durable store has its own tables and the divergence
   is audit row **REPL-D2**.
2. **The Studio's three replays are one worker.** Even with the rule fixed,
   the Studio runs all three in one process on the caller's observations,
   so it can never claim independent reproduction. It now says so instead
   of calling the result `REPRODUCIBLE`.
3. **The local two-port stack needs `ALLOW_CREDENTIALS=1`** for the
   browser's credentialed calls (`/auth/session`) to work: the API's CORS
   policy is deliberately "credentials off by default", so the web app on
   :3210 talking to the API on :8787 was blocked. The deployed stack is
   same-origin behind the proxy. Set locally in `.scratch/api.env`.

## Proof

- 21 manifest tests, 19 publication tests, 12 studio-route tests, the
  decision on its own, and **8 tests against a real PostgreSQL**
  (`apps/api/test/replay-pg.test.ts`).
- **Nine mutations proven red** (`.scratch/mutate_independence.py`).
  **One was green on the first attempt** — the mutation that made the card
  stop saying anything about independence, because the card's *limits* also
  carried the distinction and masked it. The mutation now removes both, and
  the two cards' addresses then collide, which is what it was about.
- **Browser-verified at `/studio`** against the running API and a live
  PostgreSQL (Playwright, `.scratch/studio-independence.spec.ts`): the
  screen shows "Yes — the three replays agreed." and, right below it, "No
  — the replays did not come from different workers." with the reason
  (`.scratch/shots/studio-independence.png`).
- Repo-wide: `npm run typecheck` clean; `npm test` → **4,233 tests passed**,
  0 FAIL; `apps/api` against a real PostgreSQL → **78 files / 1,197 tests**.

## Records updated

`docs/adr/0036-the-three-replays-must-come-from-three-workers.md` (+ README
row), `CRUCIBLE_AUDIT.md` (REPL-D1 closed, **REPL-D2 added**),
`HARDENING.md`, `docs/since-submission.md`,
`docs/product/REPOSITORY_ASSESSMENT_2026-11-20.md` §N, this ledger.

## Note on a mistake

`git checkout apps/api/src/studio-routes.ts` was used to undo a mutation
and **reverted the whole slice** in that file. It was re-applied from the
same edit script (`.scratch/reapply_studio.py`) and re-verified end to end
(typecheck, the 12 studio-route tests, the 9 mutations, the browser
proof). Lesson for this repo: in a tree shared with other sessions, undo a
mutation by re-writing the original text, never by `git checkout` — the
file may hold uncommitted work from this session.

## Next steps

1. **The multi-worker fleet** (ADR-0030) — without it, no surface can claim
   independent reproduction. The rule is now honest about that; making it
   satisfiable is the next engineering step.
2. **REPL-D2** — reconcile the 0008 schema with the live store (or retire
   the dead tables and their RLS policies).
3. **RLS role split** — the API still connects as the table owner, so the
   policies are inert.
4. The evidence-bundle slice and this slice leave the content store a
   host-local directory: "the bytes behind this CID" is available only on
   the host that pinned them.
