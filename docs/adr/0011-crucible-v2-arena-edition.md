# ADR-0011: CRUCIBLE v2 — the Arena Edition, as parameters beside the legacy law

- **Status:** accepted (2026-10-24)
- **Decides:** the product pivot AGENTS.md names — and how it lands without rewriting a single settled truth
- **Supersedes:** nothing. Extends ADR-0001 (agent proving ground) and ADR-0002 (native ETH escrow); their contracts are untouched.

## Context

The v2 build bible (2026-10-24, pasted planning doc; §31 of that doc is its reference set)
specifies CRUCIBLE as an on-chain arena: sponsors post trials with sealed holdouts, agents
bond and submit signed run artifacts, paid skeptics file sealed breaks, and a randomly drawn
bonded Argus panel settles disputes — with reputation, leaderboards, an agent surface (MCP/
SDK/CLI) and a frontier-model bench. It carries its own fee number: **FEE_BPS = 1500 (15%)**
of the reward, plus a 30%-of-bond break prize (its D-1).

AGENTS.md is explicit that this is a product pivot, not a feature request: *"A change that
'fixes' the fee to 15%, adds USDC, or bolts an ERC-20/ERC-721 onto the escrow… requires a
new ADR and a new contract review."* This is that ADR.

## Decision

1. **Two economic laws, one repo.** The legacy law stays byte-for-byte: `CrucibleTrials.sol`
   and the Solana `work-escrow` keep `FEE_BPS = 500` (5%), the 50/50 fail-row stake slash,
   and their 677-and-below gate regime. Nothing in `crucible-contracts/contracts/` or
   `programs/work-escrow/` changes. The v2 arena — `crucible-arena` (Anchor) and `Arena.sol`
   (Foundry) — is **added beside them** (the bible's D-9), under its own parameter source.
2. **Fees become parameters, not constants.** `params/crucible.params.json` is the single
   source of every v2 number (`FEE_BPS: 1500`, `BREAK_PRIZE_BPS: 3000`, windows, seats,
   slashes); codegen generates Rust and TS constants, CI fails on drift and on any violated
   derived invariant (gate 732). The 15% therefore lives in data with a recorded derivation
   — not as a "fix" to the 5% the legacy code carries. The legacy 500 bps is recorded in the
   same file as a frozen, non-v2 constant so the two laws are readable side by side.
3. **The v1 spec-precedence rule survives:** where the v2 bible and this repo's code, tests
   and `contract-spec.md` disagree, the repo wins *for the artifacts that already exist*;
   the bible wins *for the things it newly specifies* (arena state machine, Argus panel,
   Harena, Standing, the agent surface). Conflicts are logged in `DECISIONS.md`, per the
   bible's own §0.3.
4. **Scope guards carried forward:** devnet and testnets only; settlement never on
   assertion; conservation asserted after every money-moving instruction; every state has a
   permissionless time-based exit; verdict bodies stay pure (no floats, no timestamps, no
   model metadata in hashes).
5. **Chains:** Solana (Anchor 0.30.1, the toolchain pinned in
   `crucible-contracts/solana/Anchor.toml`) is first; EVM parity follows as `Arena.sol`
   beside the existing Foundry suite. Chain ids and addresses are recorded per-deployment
   in `AS_BUILT.md`.

## Consequences

- The bible's phases P1 (legacy green) is already satisfied in this repo — `work-escrow`
  builds and passes 10/10 on a live localnet validator; P0 (params, decisions, restore
  gate) lands with this ADR. P2+ (parity vectors, the arena programs, Harena, Argus,
  Standing, the agent surface, the app) proceed phase by phase under the bible's §25.
- `docs/gates.yml` absorbs the v1 carry-over gates 721–730 and the v2 register 731–795
  beside the existing 302, so the compliance page stays the single public register.
- Reviewers reading only the legacy code still find a coherent 5% protocol; reviewers
  reading the arena find its numbers pinned to one file with machine-checked invariants.
  The trap AGENTS.md warned about is defused not by deleting the 15% but by making both
  numbers explicit, derived, and impossible to confuse.
