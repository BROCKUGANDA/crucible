# ADR-0034: A published score carries its method and its limits

- **Status:** accepted
- **Date:** 2026-11-20
- **Supersedes:** nothing
- **Relates to:** ADR-0023 (PostgreSQL is app data; the chain is money authority), ADR-0030 (one worker, one process), ADR-0031 (funding is a chain fact), ADR-0032 (the sponsor's ledger is durable), ADR-0033 (the tenancy model is durable)

## Context

The Evaluation Studio runs a pinned task three times and says whether the
result would repeat (ADR-0028's reproducibility rule). That verdict was a
number in a response body:

```
{"verdict": "REPRODUCIBLE", "explanation": "All 3 replays produced evidence and agreed on it."}
```

It was never recorded, never compared with anything, and never published. A
score that lives only in the response of the request that produced it is a
claim with no evidence behind it — and a claim that cannot be compared with
another claim is not a measurement either.

Three questions were unanswered by the product as it stood:

1. **What was this score measured against?** A score without its suite
   version, rubric and judge is a number floating free of its method.
2. **What does this score NOT establish?** A score published without its
   limits is marketing; the limits are the difference between a measurement
   and an advertisement.
3. **May these two numbers be compared at all?** Two scores of 0.82 measured
   against different suites are two different numbers. Subtracting them
   would produce a difference between two different things — and the product
   had no way to say so, because it kept no record of how anything was
   measured.

The commercial framing is the same problem in a different costume: a sponsor
pays for a claim, and a reader of that claim needs to know what it rests on.
"0.82" without a method card is not something an enterprise buyer can put in
front of their own risk committee.

## Decision

**1. A publication is a method card, and it is content-addressed.**

A published method carries the suite version it was measured against, the
rubric with each dimension's weight and methodology, the judge, the
repetitions and their agreement, the score with its uncertainty, and — the
point of the whole thing — **the LIMITS**.

The card's address is the digest of its own contents (`pub_` plus the first
32 hex characters of that digest). Consequences:

- publishing the same card twice yields the same row, so the store cannot
  accumulate duplicates;
- a published method **cannot be edited**. Any change to any part of it
  produces a different address and therefore a different row. The append-only
  store enforces this at the database, not by convention.

The address covers one measurement of one subject. Two runs of the same task
by the same agent are two measurements and get two addresses; what makes
them comparable is the measurement key below, not the address.

**2. The limits are DERIVED, never written by hand.**

`deriveLimits()` reads the measurement and produces, in plain words, what the
score does not establish:

- always: it establishes only what was measured, and does not transfer to
  another measurement;
- the suite version's own published limitations, in its author's words;
- a dimension with no published methodology, with the share of the score it
  leaves unexplained;
- a provisional, disputed or revoked score;
- a score with no confidence interval;
- fewer repetitions than the agreement rule requires, and repetitions that
  did not agree.

Each line is the consequence of something a reader would otherwise have to
know to interpret the number. A limit written by hand is a promise; a limit
derived from the data is a fact about that data.

**3. Comparability is keyed on the MEASUREMENT, not on the subject and not on the spec digest.**

`computeMeasurementKey(spec)` hashes everything that describes what was
measured — the suite version, the protocol, the fixtures, the environment,
the judge configuration, the scoring methodology, the repetition policy and
the randomness configuration — and deliberately **excludes** the trial, the
agent and the timestamps: they say *who* and *when*, not *what*.

The spec digest cannot be the key, because the spec digest includes the
agent: two agents measured against the same suite would have different spec
digests, and a comparison that refused exactly the comparison the product
exists for would be worse than no comparison. The subject cannot be the key
for the same reason.

The comparability key is the measurement key, the rubric and the judge.
Two cards are comparable when the key matches; when it does not, the
comparison says **"not comparable"** and gives the reason. It never subtracts
two numbers that came from different measurements.

**4. The card is durable; the store is chosen once, at boot.**

`published_methods` and `publication_comparisons` are PostgreSQL tables
(migration 0014). The store is selected at boot, never per request
(ADR-0033's rule): a record written to one store and read from another is a
record that lies. Without `DATABASE_URL` the API runs on the in-memory store
and **says so** in the boot log and in every publish response
(`"store": "memory"`).

**5. A publication states what the platform measured. The caller may not state it.**

`POST /v1/publications` accepts a subject (`trialId` or `runId`) and refuses
a body carrying `score`, `verdict`, `status`, `limits`, `digest`,
`comparabilityKey`, `aggregateBps`, `scoreBps` or `publishedAt` — by name,
whatever the value. A caller who can supply the measurement is not
publishing one.

**6. The Studio records a measurement, so that it can be published.**

A Studio run now writes a replay manifest (the pinned task's digest, the
profile, the judge, the environment) and one replay record per replay,
including the replays that produced no evidence — "this replay reported no
evidence" is part of the finding, not a gap in it. The response carries the
identifiers needed to publish, look up and compare the measurement.

## Consequences

**What this buys.** A sponsor, an enterprise buyer or a researcher can be
shown a number and the method behind it, including what it does not prove.
Two scores can be compared only when they were measured the same way, and
the refusal to compare is explicit, reasoned, and recorded. The Studio's
verdict stops being a response body and becomes a record.

**What it costs.** The card is a record of one measurement; every change to a
published method is a new address, so the store grows and there is no
"unpublish". A revoked score stays published and says so in its limits. That
is the point — a score that quietly disappears is a score somebody cannot
audit.

**What it does not fix.** The replay manifest store is still in process
memory: a measurement can be lost on restart even though its published card
survives. The card is then a record of something that cannot be re-derived,
and that gap is named in `CRUCIBLE_AUDIT.md` (REPL-D1). Making the replay
store durable is the next slice on this road.

## Rejected

- **Publishing free-text limits.** A hand-written limit is a promise, and it
  goes stale the moment the measurement changes. Derived limits cannot
  disagree with the data they describe.
- **Keying comparability on the spec digest.** It includes the agent, so it
  refuses the comparison the product is for.
- **Keying comparability on the suite digest.** It ignores the judge and the
  rubric: the same suite scored by two different judges is two different
  measurements.
- **Letting the caller state the score.** A publication that can be asserted
  is a claim with extra steps.
- **Storing the card only in memory.** A published method that evaporates on
  restart is a claim with no record, which is the problem this ADR exists to
  fix.

## Proof

- `apps/api/test/publication.test.ts` — the card carries the method, the
  limits are derived from the data, the address is content-addressed, two
  subjects measured the same way are comparable and two measurements are
  not.
- `apps/api/test/publication-routes.test.ts` — the route refuses a
  caller-supplied score, verdict or limit; publishing twice yields one card;
  the comparison is explicit.
- `apps/api/test/publication-pg.test.ts` — against a real PostgreSQL: the
  card survives a fresh read, is append-only (a later write with the same id
  cannot rewrite it), and the comparison is recorded.
- `packages/agent-security/test/database.test.ts` — two migrators at once do
  not deadlock (the advisory lock this slice needed).
- `.scratch/mutate_publication.py` — eight mutations, all proven red: dropping
  the "did not agree" limit, dropping the "not enough repetitions" limit,
  ignoring a different measurement, assuming the repetitions agreed, keying
  the suite digest instead of the suite version's own digest, accepting a
  caller-supplied score, overwriting a published card, and leaving the suite
  version's digest uncomputed.
- Browser verification at the real URL: `apps/web/src/app/publications/` and
  `apps/web/src/app/publications/[id]/` against the running API and a live
  PostgreSQL (screenshots in `.scratch/shots/`).
