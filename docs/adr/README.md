# Architecture Decision Records

Each ADR records a decision that constrains the code, the test suite or the
operations of this deployment. Statuses: **Accepted** (in force), **Superseded**
(replaced by a later ADR), **Proposed** (not implemented).

An ADR is not a design document. The code, the contract spec
([`crucible-contracts/docs/contract-spec.md`](../../crucible-contracts/docs/contract-spec.md))
and the tests are the source of truth; an ADR records why the source looks the
way it does and what would have to change to revisit it.

| ADR                                             | Decision                                                             | Status   |
| ----------------------------------------------- | -------------------------------------------------------------------- | -------- |
| [0001](0001-agent-proving-ground.md)            | The product is an agent proving ground, not a human USDC marketplace | Accepted |
| [0002](0002-native-eth-escrow.md)               | Native ETH escrow on the demo chain; not USDC/Base                   | Accepted |
| [0003](0003-pull-payments.md)                   | Pull payments and one-time settlement                                | Accepted |
| [0004](0004-fixed-argus-committee.md)           | Fixed three-seat Argus committee, not staked human judges            | Accepted |
| [0005](0005-deterministic-evidence-first.md)    | Deterministic evidence outranks the LLM rubric                       | Accepted |
| [0006](0006-wallet-signed-api-no-chain-keys.md) | Wallet-signed writes; the API holds no chain keys                    | Accepted |
| [0007](0007-canonical-reputation-backfill.md)   | Reputation backfill is canonical and write-once per trial            | Accepted |
| [0008](0008-in-memory-indexer.md)               | In-memory indexer for the demo; no Postgres/queue dependency         | Accepted |
| [0009](0009-optional-voice-host.md)             | Frenchy is an optional, server-proxied, muted-by-default TTS host    | Accepted |
| [0010](0010-index-cursor-semantics.md)          | The index cursor means "next block"; `head + 1` is caught up         | Accepted |

## Writing a new ADR

1. Copy the shape of an existing file: context, decision, consequences,
   alternatives, evidence.
2. Give it the next number and a status.
3. Add it to the table above.
4. If it changes a decision, mark the old ADR **Superseded by ADR-00xx** rather
   than editing its history.
