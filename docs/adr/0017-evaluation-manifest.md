# ADR-0017: The evaluation manifest is separate from the run artifact

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** principal engineer
- **Relates to:** ADR-0005 (deterministic evidence first), ADR-0011 (v2 arena edition), ADR-0013 (receipt replayability class), ADR-0014 (challenge bond priced to verification)

## Context

`RunArtifact` (`packages/smith-sdk/src/types.ts`) records what an agent
**produced**: the spec, suite and repo digests, the commit, the suite command,
the test results, the model string, the runner, the chain and the verifying
contract. It is signed by the runner (`computeRunHash` → EIP-712 → on-chain
`submitRun`) and it is what a skeptic re-verifies.

It does not record what was **evaluated**. Two runs of the same model against
the same suite can differ because the model changed, or because the rubric
changed, or because the scaffold changed, or because the sampling parameters
changed, or because the environment image changed — and `RunArtifact` cannot
tell those apart. A published score without that binding is a number, not
evidence: "0.90" says nothing about what produced it.

The engagement's brief asks for versioned, immutable evaluation manifests
pinning task/dataset/suite/evaluator/model/scaffold/prompt/tool/image/seed/
sampling/limits, and for results to point at the exact inputs that produced
them. That is a real gap — but the shape of the answer matters, because the
repository already has two very deliberate designs that a manifest must not
break.

**Two things a manifest must not do.**

1. **It must not alter what is signed.** `RunArtifact` is the runner's
   attestation and the chain's input. Adding fields to it would change
   `computeRunHash`, change every signature, and require a contract change
   (`submitRun` takes `runHash` and re-derives the digest) — for a schema
   question that has no business touching money movement.
2. **It must not become a second place the economics live.** The fee is read
   off the deployed contract at runtime (`apps/api/src/server.ts` →
   `readProtocolFee`), precisely so the host does not carry a copy that can
   drift from the chain. A manifest that carried `feeBps` as a number would
   reintroduce exactly the drift that design removes.

## Decision

**Add `EvalManifest` to `@crucible/smith` as a separate, hashed document.**

- `packages/smith-sdk/src/manifest.ts` — the schema, `manifestDigest`,
  `buildEvalManifest`, `compareManifests`, `manifestsComparable`.
- It is **hashed, not signed**. The manifest is derived from inputs that are
  themselves content-addressed (digests of task, dataset, suite, image), so
  nobody needs to vouch for it. Changing it changes the digest; it does not
  change the signature, the artifact, or anything on chain.
- The digest is `keccak256` over RFC 8785 canonical JSON — the same
  discipline as `computeRunHash`, for the same reason: every party must land
  on byte-identical input.
- **Every field is a string.** Manifests cross languages and process
  boundaries; a number one implementation renders `0.5` and another renders
  `0.50` is a digest mismatch with no diagnosis. Numbers are carried as
  exact decimal text and `assertCanonicalNumber` refuses a value that is not
  its shortest round-trip form.
- **The fee is recorded as a schedule identity, not an amount.**
  `scoring.feeSchedule` + `scoring.feeScheduleVersion` say *which* economics
  priced the run. The amount still comes from the chain. This is what lets
  the manifest distinguish the legacy 5% schedule from the Arena's 15%
  without either being duplicated into TypeScript.
- **`compareManifests` reports the field that moved**, by dotted path, and
  distinguishes *absent* from *present-but-undefined* — "the tool set was
  pinned" and "the tool set was not" are different evaluations.
- `manifestsComparable` refuses a comparison across different fee schedules,
  different rubrics, or different environments, and permits one across
  timestamps alone, because two runs of the same manifest are a repeat
  measurement, not two games.

The manifest is **not yet** wired into the runner, the grader or the
contract. This ADR decides the schema and its semantics; the wiring is a
separate slice.

## Consequences

**Good.**

- A score can finally be attributed. "The model improved" becomes a claim
  with a digest behind it: `compareManifests` names the field that moved.
- The economics stay where they are — on the chain — and the manifest
  records *which* schedule applied without duplicating its amount.
- Nothing on chain moves. `RunArtifact`, `computeRunHash`, `submitRun` and
  every settlement path are untouched, so no signature, no escrow and no
  receipt changes.
- The schema is the natural home for the brief's remaining statistical work:
  leaderboard eligibility rules and cross-protocol warnings are now
  expressible as manifest comparisons rather than as conventions.

**Bad, and accepted.**

- Two documents describe a run, and a consumer must hold both to interpret a
  score. That is the cost of not touching the signed artifact, and it is
  smaller than the cost of invalidating every signature.
- The manifest is currently produced by nobody. Until the runner emits one,
  it is a schema with tests and no users — which is honest, but it is not yet
  a feature.
- String-typed numbers are awkward to consume. The alternative — typed
  numbers with a canonical renderer — reintroduces the "two renderings, one
  number" problem that made the field a string in the first place.

**Neutral.**

- The moving-alias refusal duplicates a rule the grader already enforces for
  model cards (gate 504). That is deliberate: a manifest that accepted
  `gpt-latest` would let a published evaluation become uncomparable the
  next time the alias moves, and the manifest is exactly where that check
  belongs.

## Alternatives rejected

**Extend `RunArtifact` with the evaluation fields.** Rejected: it changes
`computeRunHash`, invalidates every signature and the on-chain `runHash`,
and couples an evaluation-schema question to a money-moving path. The brief
warns against exactly this ("do not change deployed contract semantics ...
without an ADR and migration plan"); the cost here is the same without the
benefit.

**Store the manifest as a CID in the artifact.** Rejected as the first
move: it needs a content store write on every run, and the artifact's CID
fields are already `bytes32` commitments with a disclosure log behind them
(`packages/cidstore`) — a real design, but a larger change than the gap
requires. The manifest's digest is the same idea without the storage.

**Let the manifest carry `feeBps` as a number.** Rejected: it duplicates a
constant the chain already holds, and the host reading it from the chain is a
deliberate fix (`apps/api/src/server.ts` — a failed constant read once
published a zero fee and a full payout as though measured). The manifest
records the *schedule*, never the amount.

**Sign the manifest.** Rejected: nobody needs to vouch for a document whose
inputs are all content-addressed, and a signature would put it on the same
path as the artifact — the coupling this ADR exists to avoid.
