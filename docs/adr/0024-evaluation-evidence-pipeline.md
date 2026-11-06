# ADR-0024 — Evaluation Evidence Pipeline: a parallel surface, adopted deliberately

**Status:** Accepted
**Date:** 2026-11-06
**Branch:** `develop`
**Gates:** 919-929 (register entries added with this slice)

## Context

An externally-authored specification ("CRU-002: Evaluation Evidence Pipeline — Locked
Implementation Contract") proposed a canonical `EvaluationRecord`, an immutable
`VerificationReportEnvelope` chain, an indexer projection, six public routes and nine test
gates. It was written against this repository and named real files, so it was close enough to
the truth to be tempting and far enough to be dangerous.

Audited before implementing (the whole document is not reproduced here; the verdict is):

| Claim | Verdict |
| --- | --- |
| `RunSubmitted` / `VerdictFinalized` as the source of run facts | **already exists** — `CrucibleTrials.sol:251,256`, already indexed (`packages/indexer/src/scribe.ts:61`) |
| `EvalManifest`, JCS canonicalisation, keccak `runHash` | **already exists** — `packages/smith-sdk/src/manifest.ts:292`, `eip712.ts:16-21`, on-chain mirror `CrucibleTrials.sol:119,533`, and ADR-0017 already prescribes it |
| manifest + digest integrity gate, evidence digests | **already exists** — `apps/api/src/scorecards.ts:100-107,126,162,243` |
| identity fields (chain, trial, agent, runner, tx, block, time) | **already exists** — `RunRow` `packages/indexer/src/model.ts:137-143`, `AgentRow.runner :112` |
| score with confidence bounds | **already exists** — `grader/src/eval/abstention.ts:449,507`, invoked on a runtime path at `grader/src/eval/scorer.ts:195` |
| cohort identity and filtering | **already exists** — `packages/smith-sdk/src/scorecard-publication.ts:87`, `apps/api/src/scorecards.ts:308-324` |
| deterministic rebuild of the projection | **already exists and is proved** — `replay()` `model.ts:638`, `attachCids :692`, `packages/indexer/test/convergence.test.ts:729` |
| published verification report, versioned chain, conflict rejection | **genuinely absent** — Argus returned a report and nothing kept it; the seat's durable record is one-per-trial and overwritten (`apps/juror/src/state.ts:105-107`) |
| published manifest per run | **genuinely absent** — the runner computed a manifest and no caller anywhere pinned or announced it |
| per-run evaluation record and its read surface | **genuinely absent** |
| `ArgusPhase` / `ArgusReplayability` as exported types | **wrong about the tree** — the phase union is inline at `argus.ts:65`; no `ArgusReplayability` exists |
| replayability as `deterministic \| partial \| nondeterministic` | **would regress ADR-0013** — the durable classes are `artifact-replayable \| generation-attested \| undecided` (`apps/juror/src/state.ts:35`, derived at `policy.ts:249-252`) |
| `evaluationId = keccak256(chainId, trialId, runHash)` beside `scorecardPublicationId` | **duplicates an existing identity**, in a weaker form: the existing one is an EIP-712 typed hash with a signer |
| cursor ordered by `(timestamp, evaluationId)` | **contradicts ADR-0010** as written for chain-positioned rows, and is correct for these rows |
| `identity.funderId` as a run fact | **dead on arrival** — "funder" in this contract set is the party that *receives* a refund (`RewardMath.sol:15-16`), not a field of `submitRun` |
| `HallRow` | **a rename of the wrong thing** — the projection is `HallEntry` (`model.ts:753`); `HallRow` is a React component in `apps/web/src/app/hall/page.tsx:59` |

Thirteen of twenty-four atomic claims already existed, several in stronger shape than
proposed. Four would have undone a recorded decision. The owner chose to implement the
specification as written rather than take only the gap, so this ADR records what that buys and
what it now costs.

## Decision

Adopt the pipeline as a **parallel surface**, additive, with nothing existing rewritten.

1. **`EvaluationRecord`** (`packages/smith-sdk/src/evaluation-record.ts`) is the per-run
   evaluation document. It does not replace `EvalManifest`, `ScorecardPublication` or
   `VerifyReport`; it names them by CID and digest. Its `evaluationId` is
   `keccak256(abi.encode(chainId, trialId, runHash))` — `abi.encode`, not packed, because
   packed integers of unbounded width let `(1,23)` and `(12,3)` collide on a key a public
   route dereferences.
2. **`VerificationReportEnvelope<TReport>`** (`verification-envelope.ts`) is generic, because
   `@crucible/argus` depends on `@crucible/smith` and importing `VerifyReport` the other way
   would close a cycle the build refuses. It is closed as
   `VerificationReportEnvelope<VerifyReport>` in `packages/argus/src/persistence.ts`, where
   the verifier's own type is in scope.
3. **Two vocabularies for replayability are allowed, with one translation.** The durable
   class (ADR-0013) stays the fact; the record carries a wire value derived by
   `replayabilityFromClass`, and `generation-attested` becomes `partial`, not
   `nondeterministic`. The direction is one-way: a record is derived from a seal, never the
   reverse. Because `packages/argus` must restate the derivation (a package cannot import an
   app), `apps/juror/test/policy.test.ts` asserts the two agree for every phase.
4. **The cursor may be `(timestamp, evaluationId)` only for this endpoint.** ADR-0010's
   item-id cursor is correct where rows are ordered by chain position; evaluation rows are
   ordered by verification time, which collides on whole seconds and needs a tie-breaker.
   ADR-0010 is left as written and this is the exception, stated here, rather than an edit to
   make the old ADR agree with new code.
5. **Nothing here can hold money.** No field of an evaluation record is a wei amount, no
   projection reads the settlement ledger, and a test asserts the absence structurally. This
   is ADR-0011's purity clause and ADR-0003's pull ledger wearing an evaluation hat.
6. **The read surface is mounted before it is fed.** `/evaluations` and `/leaderboards` answer
   503 with a reason when the host supplies no source, rather than an empty list that would
   read as "nothing was verified".
7. **The version-chain store lives in `@crucible/cidstore`, not in the evaluator, and the
   envelope declares what its payload must say.** Two halves of one decision, both forced by a
   consumer rather than by taste. The store started in `@crucible/argus`; the first thing that
   needed to *read* published reports was the API host serving `GET /evaluations/:id/history`,
   and depending on argus for a class that never verifies would have pulled
   `@crucible/forge-runner` — the sandbox SDK — into a reader's process. The store needs a
   `CidStore` and the envelope contract, nothing more, so it moved beside the content it indexes
   and argus re-exports it; a test asserts the two references are the same class, because the
   failure mode of a re-export is a fork that every suite passes. The other half: the envelope
   was generic over its payload because `VerifyReport` cannot be imported downward without a
   cycle, and a reader handed `unknown` either casts or cannot read the verdict — the one field
   it came for. So `VerificationReportResult` declares the minimum (`verdict`, `phase`, `steps`,
   `reason`) and the validator enforces it, which turns out to matter on disk: an envelope read
   from a content store has never passed through a compiler.

## What is not claimed

- **The join is assembled and fed, and one half of the identity it names is not recovered.**
  `apps/api/src/evaluations-source.ts` is the host-side join, and the two facts this ADR first
  said the read model could not supply were both wrong as stated, so they are corrected here
  rather than quietly dropped:
  - *a block number on `RunRow`* — `RunRow` already carried one, under the name `submittedAt`,
    which nothing read. It is renamed `blockNumber`, because the join is that field's first
    consumer and a chain position under an `At` suffix is how a block height gets printed as a
    date. The run's wall clock comes from `trial.runAt`, which `hydrateTimestamps` turns into
    Unix **seconds**; `assertEvaluationRecord` now refuses a value that looks like milliseconds,
    which is the mixed-unit bug three fixtures were carrying.
  - *the signer recovered from the EIP-712 signature the chain kept* — **the chain keeps no
    signature.** `submitRun` recovers it, compares it with the registered runner key and reverts
    `BadSigner()` on a mismatch (`CrucibleTrials.sol:533-548`); the surviving copy is in the
    disclosure record, which is why `RunRecord` has `signature` and `sigDeadline` at all
    (`packages/cidstore/src/disclosure.ts:22-26`), and why `LiveVerifier.verify` already does
    the recovery (`packages/argus/src/live.ts:157-175`). So the join does not need a new chain
    read — but it still does not perform the recovery: every viem entry point for it
    (`recoverTypedDataAddress`, `recoverAddress`, `recoverPublicKey`) resolves a promise and
    these routes are synchronous, and the alternative is a second secp256k1 implementation. The
    consequence is stated in `RUN_SIGNER_NOT_RECOVERED` and asserted by a test: from this host,
    `IDENTITY_MISMATCH` is unreachable and an agent with no registry row yields **no record**
    rather than a `RUNNER_UNREGISTERED` finding. The attribution question is answered by Argus's
    steps 4 and 5 and by the chain's own revert; closing this half properly means the seat that
    recovered the signer writing it into the envelope as a structured field at schema version 2.
- **No cohort has real members yet.** The projection carries `cohortId` only when the host
  supplies one, and the host does not: scorecards are keyed by their own subject id, not by
  `runHash`, and inventing that mapping would put a second identity beside the chain's. Until it
  exists `/leaderboards/cohorts` answers an empty list, truthfully, and records carry no `score`
  and no `uncertainty` — absent fields, not zeros.
- **The seat publishes its envelope before it votes, on the host that runs a seat.** The append
  is wired into `apps/juror` (`operator.ts` `publish`, ahead of both the abstention record and
  the seal) and a failure to publish stops the ballot. What is *not* claimed is that any seat has
  done so in production: no run on any host has yet published a manifest or an envelope, so the
  endpoints answer 503 or an empty page depending on whether a content directory is mounted.
- **Comparability is claimed, not verified.** The refusal is on the cohort *name*, not on the
  suite and judge pins, because the record does not carry them to the comparison. A cohort
  that asserts a name it has not earned would rank. Gate 927 says so in its own text.

## Consequences

**Bought.** A verifier can now answer "which conditions produced this number, and has the
answer changed?" — the manifest is pinned and announced before any pointer is written
(gate 923), each verification is a version naming the digest of the one before (921, 922), and
the history of a run is a route rather than a memory. Absent, damaged and present evidence
stop being the same answer (926), and an abstention or a lost break cannot appear as a rank
(920).

**Cost, stated plainly.** There are now two identifiers for evaluation evidence — the EIP-712
`scorecardPublicationId` with a signer, and this unsigned `evaluationId` — and three
vocabularies for reproducibility: the seat's class, the record's wire value, and
`VerifyReport.phase`. Nothing in the tree forces a reader to pick the right one; what forces
it is the translation being one-directional and tested at both ends. If a third producer ever
writes an `EvaluationRecord` by hand, the guard is `assertEvaluationRecord`, not prose.

**Exit path.** When the host join lands (the two missing facts above), `/evaluations` stops
returning 503 and the cohort surface becomes populated. If at any point the signed scorecard
publication is judged the single evidence identity, retiring `evaluationId` is a route change
and a projection change — not a contract change — because nothing on chain references it.
That asymmetry is the reason adopting the parallel identity was survivable.

## Not in this decision

No contract, constant, fee or deployed address moved. `FEE_BPS` is still 500 = 5% on the v1
escrow; 1500 remains the Arena's sponsor-paid fee (ADR-0011, ADR-0019). The escrow does not
read an evaluation record, and an evaluation record cannot move ETH.
