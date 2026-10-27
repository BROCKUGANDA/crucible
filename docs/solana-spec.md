# Solana Work-Escrow Spec

Cross-chain port of the CRUCIBLE work-escrow to Solana via Anchor (0.30.1).
Native SOL escrow (no SPL token), same state machine and fee flow as the EVM
`CrucibleTrials`/`WorkEscrow`, with the verdict hash byte-identical across chains
(gate 712).

## Domain constants

| Constant | Value | Notes |
|---|---|---|
| `FEE_BPS` | 500 | 5% protocol fee, frozen at post time, collected only on pass — mirrors EVM `RewardMath.sol`, not the v2 arena's `ARENA_FEE_BPS` 1500 |
| `BPS` | 10_000 | basis-point denominator |
| `K_FLOOR` | 3 | minimum stake: `stake >= k * estimated verification cost` |
| `SLOTS_PER_SECOND_ESTIMATE` | 2 | documented deviation from EVM block time |
| Program PDAs | `escrow = ["escrow", worker, work_id]`; `vault = ["vault", escrow]` | PDA-derived escrow account holds reward + stake |
| Verdict hash | sha256 over JCS | byte-identical to EVM `settleVerified` input (gate 712) |

## State machine (single machine)

`Open -> Running -> Disputed -> Terminal` (Posted and VerdictPending are transitional states
absorbed into the post_work and settle instructions; see instructions.rs)

Terminal: `Settled-Pass`, `Settled-Fail`, `Settled-Split`, `Expired`.

Guard rules:
- `settle` rejects non-`Running` escrows (must be in Running state) — gate 704
- every transition checks status → effects → interactions
- conservation asserted after each hop (gate 647)
- one in-flight transition per escrow

## Instructions

| Instruction | Signer | Pre-state | Post-state | Moves |
|---|---|---|---|---|
| `open` | client | — | `Open` | client → escrow: reward + stake (frozen fee) |
| `post_work` | worker | `Open` | `Running` | result hash + verdict hash committed |
| `settle` | authority | `Running` | `Settled-*` | worker ← share + stake; feeVault ← fee |
| `dispute` | skeptic | `Running` | `Disputed` | dispute fee deposited to ghost ledger |
| `resolve` | resolver | `Disputed` | `Settled-*` | approve → pass; reject → fail; 50/50 slash |
| `expire` | client | any pre-terminal past deadline | `Expired` | funder ← full refund (pull); worker ← stake |

## Fee mechanics (gate 641)

- 5% assessed at `post_work`, frozen inside escrow, transferred only on pass
- fee and gas always shown as separate lines — "the network's toll vs the network's fuel"
- on fail: fee returns to funder in full (verification never charged when it finds failure)

## Dispute economics (gate 646)

- flat dispute fee held in escrow; winner refunded + loser's fee to feeVault
- overturned verdict → full worker restitution; spam disputes self-punishing

## Conservation (gate 647)

`deposited == vault_now + withdrawn + swept` asserted inside every transition,
where `vault_now = reward + stake + dispute_fee` (fees and pending are parked
subsets of the vault, not additive ledgers). Foundry stateful-fuzz campaign
hammers every flow-table row nightly.

## Gates (701–720)

701. Anchor program `work-escrow` with six instructions; program-id placeholder
     replaced by real keypair before devnet deploy.
702. RewardMath flow table ported: `assess_fee`, `settle_pass`, `settle_fail`,
     `resolve_dispute`, `check_stake_floor` (host unit tests green).
703. Error codes mirror the EVM custom-error set (13 codes).
704. `settle` rejects non-`Running` escrows; resolve required first for disputed.
705. Dispute fee reflected in `GhostLedger` as deposited.
706. Vault init via standard `system_program::transfer` constraints (no illegal
     `TokenAccount` literal).
707. Checked-u64 arithmetic everywhere; `overflow-checks = true` in workspace.
708. PDAs: `escrow = ["escrow", worker, work_id]`; deterministic addressing.
709. `expire` is pull-pattern refund (client signs); no push payments.
710. One in-flight transition per escrow; idempotency key `work_id:phase:attempt`.
711. Finality policy: showtime 1-conf safe; realism depth-2; cursor stores blockHash.
712. Verdict hash byte-identical to EVM across chains (golden-vector fixture).
713. Event-schema parity: Solana event fields ≡ EVM ABI events (parity table test).
714. Error-code parity: 13 Solana codes ≡ EVM custom-error set (parity table test).
715. `check_stake_floor` enforces `stake >= K_FLOOR`; keeper enforces the estimate.
716. Invariant tests: conservation holds after every mutation (Foundry mirror + Rust proptest).
717. Deadline math: `SLOTS_PER_SECOND_ESTIMATE = 2` documented estimate; gate for
     runtime-updatable clock parameter.
718. Devnet deploy + program id published (after toolchain install).
719. Deterministic-build check (`.so` artifact reproducible).
720. Program logs emit the verdict-hash field for cross-chain auditors.

## New gates (721–725)

721. Upgrade-authority policy: multisig or immutable at deploy.
722. Devnet deploy + program id published.
723. Deterministic-build check.
724. Program logs emit verdict-hash field.
725. Event-schema snapshot test proving Solana event fields ≡ EVM ABI events.

## Notes

The Anchor program source ships complete but uncompiled — this environment has no
Rust/Solana/Anchor toolchain. Install per the toolchain steps in the
implementation prompt (§Workstream A, t1–t3), then:

```bash
cd contracts/solana
anchor build          # downloads SBF platform-tools, compiles .so
anchor test           # localnet, rewrites tests/work-escrow.ts end-to-end
```
