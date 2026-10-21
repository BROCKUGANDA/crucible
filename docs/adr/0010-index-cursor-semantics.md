# ADR-0010: The index cursor means "next block"; `head + 1` is caught up

- Status: Accepted
- Date: 2026-10-21

## Context

`Scribe` stores a cursor and reports it as `indexedTo`. The cursor is the next
block to read, so after a quiet chain it advances to `head + 1`. A chain reset
(a shorter chain, a rebuilt devnet) also leaves the cursor above the head, so
the indexer must distinguish "caught up" from "reset".

The first reset check used `cursor > head`. That matched the normal caught-up
state (`head + 1`), cleared the model and restarted the backfill on every idle
tick. The hall emptied and refilled, `/ready` flipped between true and false,
and the site looked half-alive. The API was answering 200 while the read model
was being wiped.

## Decision

- The cursor is the **next block to read**.
- `cursor === head + 1` is caught up: clear the sync error, keep the model.
- `cursor > head + 1` is a reset: clear the model, reset the cursor to
  `fromBlock`, and set the rebuild error.
- `cursor <= head` reads the range as before.

Readiness treats `indexedTo > head` as lag zero. A future change to the cursor
meaning must update `status`, `/ready`, the reset check and the tests together.

## Consequences

- A caught-up indexer is stable and does not rebuild itself.
- A genuinely shorter chain still resets and rebuilds.
- A same-height chain replacement (same head, different history) is not
  detected by this check. Detecting it requires storing block hashes, which is
  a separate change.
- The regression test `keeps its model when the cursor is simply one past the
head` pins the boundary.

## Alternatives considered

- **Store the last processed block instead of the next block.** Cleaner name,
  but it changes `indexedTo` semantics, the readiness math and the existing
  tests. Rejected for this fix; it is a possible future refactor.
- **Never reset automatically.** Rejected: the indexer would serve a frozen
  pre-reset model forever.

## Evidence

- `packages/indexer/src/scribe.ts` — the caught-up and reset branches.
- `packages/indexer/test/scribe.test.ts` — `rebuilds when the chain is reset
under it` and `keeps its model when the cursor is simply one past the head`.
- `docs/runbooks/indexer-stalled-or-reset.md`.
