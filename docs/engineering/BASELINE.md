# Crucible — Baseline Inventory

**Date:** 2026-11-05  
**Branch:** `develop`  
**Baseline commit:** `abe7304` (HEAD at session start)  
**Chain:** local Anvil, chain id 31337  
**Indexer:** in-memory (ADR-0008)  
**API:** holds no chain key (ADR-0006)

## Source of truth
- `AGENTS.md` — load-bearing agent rules; money rules that do not bend.
- `crucible-contracts/docs/contract-spec.md` — contract specification; its own stated precedence.
- `docs/enterprise/roadmap.md` — build order S1–S5 with gates.
- `docs/enterprise/production-checklist-300.md` — 300-item evidence register (20 Verified, 98 Existing, 101 Partial, 76 Missing, 0 Unverified, 5 Blocked).
- `docs/since-submission.md` — dated record of everything shipped after the `cwf-submission` tag (`dd52c07`, 2026-10-12).

## Workspaces (19 total)
| # | Workspace | Package name | Test/script status |
|---|-----------|--------------|-------------------|
| 1 | `apps/api` | `@crucible/api` | test present |
| 2 | `apps/funder` | `@crucible/funder` | dev script |
| 3 | `apps/fork-host` | — | — |
| 4 | `apps/juror` | — | — |
| 5 | `apps/keeper` | `@crucible/keeper` | test present |
| 6 | `apps/web` | `@crucible/web` | test present |
| 7 | `packages/agent-security` | `@crucible/agent-security` | built, not wired to live path |
| 8 | `packages/arena-events` | `@crucible/arena-events` | — |
| 9 | `packages/argus` | `@crucible/argus` | — |
| 10 | `packages/cidstore` | `@crucible/cidstore` | test present |
| 11 | `packages/crypto` | `@crucible/crypto` | test present |
| 12 | `packages/datasets` | `@crucible/datasets` | — |
| 13 | `packages/eval` | `@crucible/eval` | test present (ratings, gates, orchestration) |
| 14 | `packages/forge-runner` | `@crucible/forge-runner` | test present |
| 15 | `packages/frame` | `@crucible/frame` | — |
| 16 | `packages/indexer` | `@crucible/indexer` | test present |
| 17 | `packages/registry` | `@crucible/registry` | test present |
| 18 | `packages/site-index` | `@crucible/site-index` | — |
| 19 | `packages/warden` | `@crucible/warden` | test present |
| 20 | `crucible-contracts` | — | Foundry; `forge test`, `forge build --sizes` |
| 21 | `grader` | `@crucible/grader` | test present (arena grading suites) |

## Runtime processes and boundaries
| Process | Responsibility | Holds keys? |
|---|---|---|
| `apps/api` | read model, `/health`, `/ready`, `/mcp` (11 tools), `/onramp/session`, `/content`, `/escrow/:wallet`, `/teams` | No chain key |
| `apps/keeper` | serial keeper, `settleBatch`, `reclaimExpired`, gas ledger, arena cranks | `KEEPER_PRIVATE_KEY` (signing, not chain admin) |
| `apps/juror` | dispute adjudication seat | — |
| `apps/funder` | CDP on-ramp sessions, ETH on Ethereum via Coinbase | CDP key (optional; degrades to 503 `configured:false`) |
| `apps/web` | Next.js frontend, Inertia + React + Tailwind | No chain key |

## Contracts (EVM, `crucible-contracts/contracts/`)
| Contract | Purpose | Fee |
|---|---|---|
| `CrucibleTrials.sol` | legacy ETH escrow, state machine, pull ledger | `FEE_BPS = 500` (5%, from agent payout) |
| `Arena.sol` | v2 arena, sponsor-side posting | `ARENA_FEE_BPS = 1500` (15%, dormant config) |
| `ArgusCourt.sol` | bonded 2-of-3 committee, slash once per seat per panel | — |
| `AlloyRegistry.sol` | soulbound non-transferable reputation (Unforged→Damascus) | — |
| `ReputationBridge.sol` | reputation publishing, identity epochs | — |
| `RewardMath.sol` | pure math library for every reward-flow-table row | — |
| `VerificationReceipt.sol` | soulbound receipt minted on settlement | — |
| `CrucibleHall.sol` | read-only hall / leaderboard read model | — |
| `Params.sol` | generated from `params/crucible.params.json` | — |
| `TeamLedger.sol` | team credit ledger (deployment script `Teams.s.sol`) | — |

## Solana programs (`crucible-contracts/solana/programs/`)
| Program | Status | Notes |
|---|---|---|
| `work-escrow` | Anchor 0.30.1 source present | native-SOL intent; SPL concepts remain in source (CRU-008 blocked); SBF build blocked — no reachable `cargo-build-sbf 3.0.0` |
| `crucible-arena` | Anchor source present | — |

## Deployment matrix
| Item | Value |
|---|---|
| Demo chain | Anvil, chain id 31337, local |
| Mainnet RPC | `MAINNET_RPC_URL` empty by default; `.env.example` carries the key unset |
| Verified deployments | `assert-deployment.sh` checks 12 chain assertions (fee 500 bps, bond 1/5, threshold 2, 10.04 ETH held vs 8.44 ETH liabilities) |
| Mainnet deployment | **None.** `docs/mainnet/sign-off` templates are `signed: false`. |
| Deterministic deployer | lands at the same two addresses on chain reset |

## Signing keys and access
| Component | Key type | Access |
|---|---|---|
| Keeper | `KEEPER_PRIVATE_KEY` | signs keeper transactions; shaped `0x` + 64 hex; never printed |
| Deployer | deterministic deployer | reproducible addresses; no mainnet deployer key in repo |
| API | no chain key | ADR-0006 |
| Funders | CDP key | optional; `/health` reports `configured:false` when absent |
| Argus seats | individually controlled dispute-voting keys | no privileged minter/settler role |

## API mutation routes and authentication
Routes that perform writes (must be SIWE-session guarded per CRU-001 audit):
- `/faucet`, `/onramp/session`, `/identity/risk`, `/mcp`, `/faucet/applications`
- Wallet-signed writes only; API holds no chain key (ADR-0006)
- No client-supplied `orgId` trusted as proof of membership (S4 gate)

## Data stores / state
| Store | Type | Persistence |
|---|---|---|
| Indexer read model | in-memory (ADR-0008) | none across restart |
| Cursor | in-memory, `head + 1` = caught up | — |
| Event gateway | `/stream` + `/snapshot` SSE, one shared tick | in-memory model |
| Content store | `CidStore` | read-only in compose; explicit read-only mode |
| No Postgres / queue / ORM | — | ADR-0008 defers persistent store |

## Existing checks (run at session start, unaltered)
| Check | Command | Status |
|---|---|---|
| Typecheck | `npm run typecheck` | — |
| Tests | `npm test` | 2752 total (2423 TS + 329 Foundry) at last measurement |
| Edge suite | `npm run test:edge` | 15 tests (RPC gate, live probe, installer) |
| Forge build | `cd crucible-contracts && node ../scripts/run-forge.mjs build --sizes` | — |
| Forge test | `cd crucible-contracts && node ../scripts/run-forge.mjs test` | — |
| Coverage gate | `node scripts/run-forge.mjs coverage --ir-minimum --report summary` + `scripts/coverage-gate.mjs` | per-contract floors |
| Lint | `npm run lint -w @crucible/web` | ESLint 9 flat config |

## Pre-existing failures (distinguished from regressions)
None recorded as of session start. Any new failure must be compared against this baseline before being classified.

## No secrets in documentation
No private keys, seed phrases, RPC credentials, or privileged API keys appear in this file or any baseline document.