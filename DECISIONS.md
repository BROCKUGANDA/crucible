# DECISIONS — resolved or defaulted, with the reading chosen

Gate 733 (v2 bible §28). Every D-entry carries its default, the reason, and — where the
bible and this repository's existing law met — which one won and why. Authority order:
ADR/AGENTS.md law → params → existing code+tests → the bible's new specifications.

| Id | Decision | Default taken | Reading / note |
| --- | --- | --- | --- |
| D-1 | Break-landed split | **Arena: 30% skeptic / 70% treasury** (`break_prize_bps: 3000`). Legacy `work-escrow` keeps 50/50, frozen as `LEGACY_BREAK_SPLIT_BPS_V1` | The copy's stage-IV promise wins for v2; v1 semantics never change (ADR-0011) |
| D-2 | Failed-break stake | **Treasury** (`FAILED_BREAK_SINK`) | Agents must never profit from their own alt wallets' junk breaks |
| D-3 | Forfeits | Timeout 10% of B to the sponsor; yield 0% + cooldown | `claim_timeout_forfeit_bps: 1000`, `yield_cooldown_seconds: 86400` |
| D-4 | Reward floors | 0.01 ETH · 10 USDC · 0.1 SOL | In `params.json` as per-mint base-unit strings — never floats |
| D-5 | Vote reveal window | **24 h**, matching commit | Both windows 86400 s |
| D-6 | Seat economics | 50 bps/seat/break fee; bond ≥ 5× earnable; 20% slash for no-shows only; minority votes never slashed | Invariant 1 proves seats payable from the minimum bond |
| D-7 | Decay & seasons | Half-life 45 d; season 42 d | Standing display = 500 + 250×Standing |
| D-8 | Clock | **Unix timestamps** (`Clock::unix_timestamp` / `block.timestamp`) | v1's `SLOTS_PER_SECOND_ESTIMATE = 2` stays in `work-escrow` as legacy, UI-estimates only — this corrects a real drift bug (G14) |
| D-9 | Program layout | New `crucible-arena` + `Arena.sol` beside untouched v1 | Never rename v1 identifiers (AGENTS.md rule 17 agrees) |
| D-10 | Reputation home | **Both chains**: ERC-8004 on Base Sepolia + Solana Agent Registry, indexer-mirrored, no bridge | Publish is best-effort + `republish`, never blocks settlement |
| D-11 | Target event | **Colosseum Eternal** (November window) first; next Colosseum hackathon second | World's Fair closed 2026-10-12 — do not build to it |
| D-12 | Randomness | VRF both chains (Switchboard/ORAO; Chainlink v2.5); slot-hash fallback devnet-only and labelled | Deterministic randomness acceptable in P3/P4 tests |
| D-13 | Anchor version | **Stay on 0.30.1** | Amended for this machine in `crucible-contracts/solana/Anchor.toml`: solana-labs v1.18.26 replaces the unreachable agave pins — the era-correct pairing, proven green 10/10 |
| D-14 | `K_FLOOR` vs new invariants | **Report only** | Legacy `math.rs` formula recorded, never silently changed |
| D-15 | Patron vaults | **Deferred** (stretch, needs legal review) | Not in the hackathon build |

## Conflicts found between the bible and this repo, and the readings taken

1. **Fee (the big one).** Bible: 1500 bps arena fee. Repo law: 500 bps, 15% named as the
   trap. Reading: both are true in their spheres — resolved by ADR-0011 (params-driven
   arena fees; legacy frozen at 500 and machine-checked against drift by gate 732's
   legacy-freeze assertion, proven to fail red on mutation).
2. **"EVM contracts never compiled" (bible G6).** False here: this repo's Foundry suite is
   green (144 tests, coverage-gated). The bible described the *other* environment's tree.
   Reading: P3 starts from a compiled, tested base; `Arena.sol` is additive.
3. **Program id `7Tvrs…` "gone green" (bible §10.7).** In this repo that id's keypair never
   existed; the local e2e went green on a re-synced id recorded in `Anchor.toml`.
   Reading: ids are per-environment; the toolchain is the pin (AGENTS-recorded).
4. **Layout.** Bible paths (`download/crucible`, Bun) map to this repo (npm workspaces,
   `crucible-contracts/solana`). Reading: this repo's structure wins; the bible's
   *contents* are adopted, not its directory names.
5. **Arena mints.** Bible §7.4 and D-4 want an allowlist of wrapped SOL, devnet USDC, Base Sepolia
   USDC and native ETH. Reading: **native ETH only**, in the arena too. ADR-0002 and
   contract-spec.md:20-21 are the repo's law, and the balance-delta token policy the bible asks
   for exists to defeat fee-on-transfer tokens — a hazard this chain does not have. `reward_floor`
   keeps its usdc/sol entries as data with no consumer, and `REWARD_FLOOR_WEI` is the Eth one.
6. **Partial quorum at the round cap.** §6.4.5 says "still unresolved after MAX_ARGUS_ROUNDS: O8,
   everyone is refunded", and a trial can reach the cap with some breaks decided and one hung.
   Reading: **O8 for the whole trial**. A verdict nobody could finish is not a verdict, and paying
   out a bond against a partial ballot is where an agent loses money to a jury that gave up.
7. **A retry needs a bigger pool than the first round.** §6.4.1 excludes round-1 seats from
   round 2, so a three-seat pool cannot retry a hung jury at all. Reading: the draw **fails
   closed** (`NotEnoughSeats`) and the docket waits for O8's exit rather than reusing a jury.
   Recorded because it is a real operating constraint on whoever runs seats.
8. **Seat bond floor.** `SEAT_BOND_MIN` is "5 × the fees a seat can earn on the trial", and one
   trial can put a seat on MAX_DOCKET breaks. Reading: `share × MAX_DOCKET × 5` — the worst case,
   so invariant 1 (seats always payable from the bond) holds on-chain and not only in the
   codegen test. `_settleLanded` reverts `BondShortfall` rather than pay a bond it does not have.
9. **Filing is unlimited, judging is bounded, and both need a number.** §6.3.2 wants unlimited
   filing; `freezeDocket` ranks with a bounded selection pass, so an unbounded filing list is an
   unbounded gas bill for whoever cranks it. Reading: **`MAX_FILING = 64`** breaks may be filed
   per trial; past that the deposit is refused. 8 of those 64 are judged.
10. **Ghost-ledger convention.** `paidOut` counts every wei the trial routed out, including the
    bond's three exits (prize, seat pools, treasury remainder) as one whole, so
    `paidOut == deposited` at settlement is a check and not an approximation.
