# Crucible — System Map

**Date:** 2026-11-05  
**Branch:** `develop`

## Evaluation engine (System A)

### Frontend model evaluation
- `apps/web` — Next.js + Inertia + React + Tailwind. Landing, trials, agents, hall, bounties, forge, escrow, teams, replay, `/assay`, `/claims`, `/compliance`, `/escrow`, `/verticals`.
- `packages/smith-sdk` — manifest (`manifest.ts`), ABI (`abi.ts`), EIP-712 parity, standing (`standing.ts`), run artifact signing.
- `packages/forge-runner` — sandbox, runner, manifest emission, injection guard (default-on), tool guard, agent capabilities.

### Grading / verification
- `grader/` — frontier guard, spend ledger, egress scrub, model cards, adapter cap (4 files: stub/openai-compat/anthropic/google), break-mutants, cascade routing, ensemble, shadow promotion, GraderRegistry, scorer.
- `packages/argus` — rubric (`rubric.ts`), live execution, Argus committee integration.

### Statistical / adversarial
- `packages/eval` — `ratings.ts` (TrueSkill-style, `conservative`, `defaultRating`, `decayRating`, `tierFor` T0–T4, `SkillNode`/`SkillState`/`nodeStatus`), `gates.ts` (`rankBoard`, `rankBoardFull`, `targetDifficulty`, `applyCaps`, `circuitFrozen`, `gasInBand`, IRT holdout linter, Merkle airdrop, checkpoint chain, abstention scoring, sybilAdjust, EventGateway model), `orchestration.ts` (DAG compiler, role contracts, hash-chained bus), `splits.ts`, `train.ts`, `trajectories.ts`.
- `packages/crypto` — one-crypto-door, JCS canonicalization (RFC 8785), hybrid AEAD (X25519 + ML-KEM-768), CSPRNG-only randomness.

## Web3 economic verification (System F — existing, preserved)

### Legacy escrow (5%)
- `CrucibleTrials.sol` — sponsor funds, agent stakes bond (20%), submits signed run, skeptic challenges, Argus adjudicates, settlement, pull `withdraw()`.
- Conservation invariant: `address(trials).balance == totalStakes + totalPending + escrowed`.

### v2 Arena (15%, dormant)
- `Arena.sol` — sponsor pays 15% on top of reward, 20% bond at claim, runner + attestor EIP-712 signature, break sealing, holdout reveal, O1–O8 settlement with pull ledger + ghost ledger.
- `ArgusCourt.sol` — bonded seats, sponsor/agent/skeptic exclusion, slash once per seat per panel.

### Reputation
- `AlloyRegistry.sol` — soulbound Alloy (Unforged, Iron, Bronze, Steel, Damascus), identity epochs (ADR-0012), `Record` widened to nine fields.
- `ReputationBridge.sol` — canonical reputation backfill, epoch transitions.

## Commercial / billing (Systems B–E — NOT IMPLEMENTED, CRU-009→014 blocked)
No `CrucibleBilling.sol`, no commercial catalogue, no quote/invoice engine, no subscription ledger, no CEU metering, no dual-chain indexing, no double-entry ledger, no checkout flow. Blocked by `BLOCKED_FOR_HUMAN.md` items 13–14 (approved pricing policy, payment contracts, legal review, independent audit).

## Observability / operations
- `apps/api/src/app.ts` — `/health`, `/ready`, `/healthz`, `/readyz`, `/mcp`, rate limiting, SIWE auth.
- `apps/keeper/src/main.ts` — keeper loop, `reclaimExpired`, gas ledger, `/health`.
- `packages/indexer/src/scribe.ts` — cursor, backfill, reorg handling, chain-reset detection.
- `docs/gates.yml` — 244+ gates × 11 frameworks, compliance matrix at `/compliance`.
- `HARDENING.md` — verified findings and still-open items.

## Boundaries that must not be crossed without an ADR
- No database / queue / second source of truth (ADR-0008).
- No ERC-20 / SPL token on escrow (ADR-0001, ADR-0002).
- No new fee constant without an approved ADR (AGENTS.md).
- No chain key in the API (ADR-0006).
- No push-with-try/catch settlement (ADR-0003).
- No privileged minter/settler role (deleted on purpose).