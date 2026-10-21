# ADR-0005: Deterministic evidence outranks the rubric

- Status: Accepted
- Date: 2026-10-21

## Context

A code claim is falsifiable by re-running the pinned suite. A rubric is useful
only when the suite is partial or the work is not mechanically decidable. Three
agreeable LLM judges must never be able to overrule a mechanical result.

## Decision

Argus runs the deterministic phase first: verify the artifact, the runner
signature, the claimed green result and the suite. Only a _partial_ suite — one
that cannot decide — may reach the rubric. The rubric uses exactly three judges
at temperature 0 with a fixed rubric and 2-of-3 agreement; a judge that errors
or returns malformed JSON is not counted as agreement. `resolvePrecedence`
returns the deterministic verdict whenever it is not `abstain`.

## Consequences

- A red run cannot be submitted: the SDK refuses to sign it and the runner
  fails the iteration.
- A deterministic verdict is not reviewable by an LLM. That is the point.
- Temperature 0 is a contract in the `Judge` interface, not a parameter the
  library can enforce on a vendor; the caller must honour it. The rubric
  currently has unit tests but no production service caller.
- No confidence score, human escalation or hidden probes. Those are a separate
  product decision (ADR-0004).

## Alternatives considered

- **Rubric-first or rubric-only.** Rejected: it makes the verdict depend on
  model behavior where a test suite can answer.
- **Majority of five judges.** Rejected: the contract is a 2-of-3 committee;
  a five-judge panel would need its own quorum and could let a minority settle
  a larger panel. `runRubric` now requires exactly three.
- **LLM decides when the suite is red.** Rejected: a red suite is evidence.

## Evidence

- `packages/argus/src/argus.ts` — deterministic phases and crash-as-abstain.
- `packages/argus/src/rubric.ts` — three judges, 2-of-3, precedence.
- `packages/argus/test/argus.test.ts` — precedence and panel-size tests.
- `README.md` — "Deterministic evidence outranks the rubric."
