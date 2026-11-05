# Crucible — Environment Matrix

**Date:** 2026-11-05  
**Branch:** `develop`

| Field | EVM (legacy escrow) | EVM (v2 Arena) | Solana (work-escrow) |
|---|---|---|---|
| Chain/network | Local Anvil | Local Anvil | Localnet (Anchor) |
| Environment | Local / testnet / mainnet | Local / dormant config | Localnet / devnet / mainnet |
| Native asset | ETH | ETH | SOL |
| Base unit | Wei | Wei | Lamports |
| Decimal precision | 18 | 18 | 9 |
| Contract/program ID | `CrucibleTrials` (deterministic deployer) | `Arena` (built, not wired to app) | `work_escrow` (Anchor.toml program id) |
| Deployment environment | Local demo chain | Not deployed | Not deployed |
| Bytecode/program verification | `forge build` green | `forge build --sizes` green (20,155 bytes) | SBF build blocked — no reachable `cargo-build-sbf 3.0.0` |
| Treasury | configured per deploy (TREASURY_ADDRESS) | not wired | not wired |
| Escrow | verified deployment | contract built | source present |
| Billing receiver | none (blocked CRU-010) | none | none (blocked CRU-011) |
| Indexer | in-memory (ADR-0008) | not wired | none |
| Finality policy | Anvil immediate | not defined | not defined |
| Admin authority | deterministic deployer | not defined | program upgrade authority not resolved |
| Emergency controls | permissionless `finalize`/`reclaimExpired` | not defined | not defined |
| Deployment status | Proven (demo) | Built, not deployed | Code present, not compiled to SBF |

## Native-asset accounting rule
- ETH amounts in wei (checked `bigint`), never floats.
- SOL amounts in lamports (checked `u64`), never floats.
- Never convert reward liability into another asset.
- Reference USD may be displayed with rate source + timestamp, but payable amount remains exact native asset.

## Mainnet truth
- No mainnet deployment exists.
- `MAINNET_RPC_URL` empty by default; `.env.example` carries the key unset.
- Mainnet preflight gate fails closed on: unsigned audit, legal, genesis, timelock, monitoring sign-offs; missing or non-mainnet RPC.
- ERC-8004 fork tests pass 4/4 through `eth.drpc.org` at pinned block 24,846,426; `publicnode` prunes that block and fails in `setUp`.
- Mainnet launch requires: independent audit, legal entity, funded multisig (2-of-3 Safe), named on-call, genesis sponsors, timelock (>=48h), monitoring. These are human facts no code can sign (`BLOCKED_FOR_HUMAN.md` items 1–7, 12).