# ADR-0036: The three replays must come from three workers, and the measurement is durable

- **Status:** accepted
- **Date:** 2026-11-20
- **Supersedes:** nothing
- **Relates to:** ADR-0030 (one worker, one process), ADR-0034 (a published score carries its method and its limits), ADR-0035 (a dispute reads a frozen bundle), ADR-0023 (the chain is the authority; PostgreSQL is the app's data)

## Context

The network's rule has been quoted since the beginning: **three
independent replays of the same pinned task must produce the same result**.
Two things made that quotation decorative.

**1. Nothing checked independence.** The reproducibility state machine
counted three completed replays and compared their output hashes. It never
looked at who ran them. A worker running the same verifier three times
could agree three times and still be wrong three times — a sticky seed, a
cached artefact, a bug in that worker, a shared environment that fails the
same way. The published card quoted the rule ("Three independent replays
of the same pinned task must produce the same result") and, beside it,
listed each replay's `workerIdentity` — which the Studio filled with **the
caller's own label** for the replay. A caller could therefore satisfy any
independence check by naming its three replays `worker-a`, `worker-b` and
`worker-c`.

Meanwhile the Studio did exactly what a caller controls: one process ran
the pinned task three times on the caller's observations, and the answer
was called `REPRODUCIBLE`.

**2. The measurement was in memory.** The replay manifest — what was run,
in which environment, by which worker, and what each replay produced — was
a module map. A restart erased it. A published card (ADR-0034) and a frozen
dispute bundle (ADR-0035) are both built from it, so after a restart they
described a measurement that could no longer be re-derived. A card that
outlives its measurement is a claim with no record.

## Decision

**1. Independence is decided on the WORKER, and the worker is derived.**

A replay's worker identity is the party the observation came from, as the
platform knows it — never a name the caller chose. The caller's name for a
replay is kept, shown, and never consulted: `label` is a name,
`workerIdentity` is who ran it.

The state's rule is now two thresholds, and the second decides what the
first means:

- `REQUIRED_REPLAYS` (3) completed replays with the same output; **and**
- `REQUIRED_REPLAY_WORKERS` (3) **different** workers behind them.

Three agreeing replays from one worker are `INCONCLUSIVE`, and the
manifest says which of the two reasons it is: the replays disagreed, or
they agreed and did not come from enough different workers. "INCONCLUSIVE"
alone is a shrug; a reader should not have to guess which.

**2. The Studio says what it actually established.**

The Studio runs the three replays in one process on the caller's
observations, so they come from one worker and the agreement is **not**
independent reproduction. Its answer now reports the two facts separately:

- `verdict` — the AGREEMENT: `AGREED`, `NOT_AGREED` or `INCONCLUSIVE`.
  The names were changed from `REPRODUCIBLE`/`NOT_REPRODUCIBLE` because a
  verdict must not claim more than the decision established: this surface
  decides agreement, and nothing else.
- `independence` — whether the agreement is independent: the number of
  workers, the number the rule needs, whether the rule is met, and why in
  words.

The web page shows the independence next to the verdict, because a reader
who sees only "the three replays agreed" would read more into it than the
platform established.

**3. The published card carries the independence, and its address covers it.**

A card's `repetitions` now report `workers` and `independent`, and a
derived **limit** says so in words when the repetitions came from fewer
workers than the rule needs: "The completed repetitions came from 1
worker, not 3 different ones, so this is agreement, not independent
reproduction." A limit that is not in the address can be edited after the
fact; this one is inside the digest, so two cards that differ only in
independence have different addresses.

**4. The rule lives in one place.** `replay-policy.ts` owns
`REQUIRED_REPLAYS` and `REQUIRED_REPLAY_WORKERS`. The replay number bound
and the completeness threshold in `replay-manifest.ts` read them instead of
hard-coding a `3` — a second place to change the rule is a second place to
get it wrong.

**5. The measurement is durable.**

`replay_measurements` and `replay_measurement_records` (migration 0016)
hold the manifest and its replay records. The store is chosen once at boot
(ADR-0033's rule) and the API's replay API is asynchronous, because a write
that cannot be awaited cannot be durable.

Two details matter:

- The replay record stores the **worker identity as a column of its own**.
  The independence rule is decided on it, so it should not be something a
  reader has to dig out of a JSON blob to find.
- An update to a replay record may move only its **status** and **output**.
  Its identity — which manifest it belongs to, which number it is, which
  worker ran it — never moves. A record whose worker could be rewritten
  after the fact would be a record that could not be trusted about
  independence.

**6. The tables are NOT the ones migration 0008 defines.**

Migration 0008 already defines `replay_manifests` and `replay_records`,
with a different and richer model: every row there must name an
`evaluation_spec_id` and a `trial_revision_hash`, carry a
`manifest_digest`, and its `replay_status` is CHECKed against a set that
does not include `RUNNING`. The live manifest has no evaluation spec id
and no trial revision hash, and its status set is wider. Nothing in the
codebase writes the 0008 tables.

Reusing them would mean inventing values for columns the live model does
not have, and fabricating data to satisfy a NOT NULL is exactly the kind of
lie this repository does not tell. So the durable store has its own tables,
and the divergence is named in `CRUCIBLE_AUDIT.md` (REPL-D2) instead of
being quietly papered over.

## Consequences

**What this buys.** The headline claim — three independent replays agree —
is now something the platform checks rather than something it prints. A
card says how many workers its repetitions came from. The measurement
survives a restart, so a card and a bundle can always be traced back to
the run that produced them.

**What it costs.** The Studio can no longer report `REPRODUCIBLE`, because
it cannot establish independence — it runs the replays itself. The
multi-worker fleet that would make the rule satisfiable is ADR-0030's
"one worker, one process" working at scale, and it does not exist yet. The
Studio's answer is therefore narrower and truer.

**What it does not fix.** The result of a replay is still the caller's
reported evidence, verified by the platform's verifier — the fingerprint
is of the evidence, not of an independently executed run. And the content
store that holds the bytes behind a CID is still a host-local directory.

## Rejected

- **Checking independence on the caller's labels.** A rule a caller can
  satisfy by naming things differently is not a rule.
- **Keeping the names `REPRODUCIBLE` / `NOT_REPRODUCIBLE` and adding a
  caveat line.** A verdict and a caveat in the same body invite a reader to
  quote the verdict. The names now say what was decided.
- **Reusing migration 0008's tables and filling the gaps.** Fabricating a
  spec id to satisfy a NOT NULL is a lie with a foreign key.
- **Keeping the replay API synchronous over a durable store.** A write
  that cannot be awaited cannot be durable; the API became async instead.
- **Dropping the replays that did not agree.** A measurement that hides
  its own failures is a measurement that cannot be trusted.

## Proof

- `apps/api/test/replay-manifest.test.ts` (21 tests) — the state machine:
  three workers agreeing is `REPRODUCIBLE`; three agreeing replays from one
  worker is `INCONCLUSIVE` and the note says "1 worker"; two workers is
  `INCONCLUSIVE` and the note says "2 workers"; three replays labelled
  `worker-a`, `worker-b`, `worker-c` from one worker are still one worker;
  the replay number bound comes from the policy, not from a literal `3`.
- `apps/api/test/publication.test.ts` (19 tests) — the card reports the
  workers and the independence verdict; the derived limit says "agreement,
  not independent reproduction" when the repetitions were not independent;
  two cards that differ only in independence have different addresses.
- `apps/api/test/studio-routes.test.ts` (12 tests) — the answer carries the
  independence block and says the agreement was not independent; three
  different labels do not become three workers; the **recorded** manifest
  attributes every replay to the caller, so the card built from it says the
  same thing the answer did.
- `apps/api/test/studio-reproducibility.test.ts` — the decision on its own.
- `apps/api/test/replay-pg.test.ts` (8 tests, against a real PostgreSQL) —
  the manifest survives a fresh read; the worker identity survives it as a
  column; a caller's label is kept without being mistaken for a worker; two
  replays with the same number are refused; a replay's status moves as it
  completes while its identity does not.
- `.scratch/mutate_independence.py` — **nine** mutations, all proven red:
  the state machine ignoring the worker count, the worker count taken from
  the labels, the rule needing only one worker, the manifest not saying why,
  the card stopping to say anything about independence, the derived limit
  dropped, the card claiming independence whatever the replays came from,
  the Studio attributing a replay to the label, and the Studio's answer
  claiming independence whatever it was.
  **One was green on the first attempt** — the mutation that made the card
  stop saying anything about independence, because the card's *limits* also
  carried the distinction and masked it. The mutation now removes both, and
  the address of the two cards then collides — which is what the mutation
  was about.
- Repo-wide: `npm run typecheck` clean; `npm test` → **4,233 tests passed**,
  0 FAIL; `apps/api` against a real PostgreSQL → **78 files / 1,197 tests**.
