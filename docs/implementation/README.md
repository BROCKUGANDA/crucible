# Crucible implementation programme

Consolidated execution index for prior Crucible prompts. This is a programme, not a claim that every target feature exists.

## Start here
- [Prompt catalogue](PROMPT_CATALOG.md)
- [Dependency roadmap](ROADMAP.md)
- [CRU-002–CRU-014](cru-workstreams.md)
- [Adaptive Forge](adaptive-forge.md)
- [Forge Watch](forge-watch.md)
- [Platform experience](platform-experience.md)

## Status vocabulary
Existing = verified in code/tests; Partial = foundations exist; Planned = specification only; Blocked = ADR/security/external dependency/product decision required; Verified = acceptance and operational evidence passed on exact revision. Documentation or a passing unit test alone does not make a feature Verified.

## Hard boundaries
Preserve native-ETH trial escrow, legacy 5% fee, dormant distinct 15% Arena schedule, pull-payment settlement, permissionless finalization and exact conservation invariant unless a new ADR and contract review approve change. No API chain private key. No unsupported claims of Sybil resistance, game-theoretic security, alignment or safety. Postgres is durable source of truth only after ADR/migration; Redis/BullMQ coordinate, never become source of truth; persist outbox before queue. SPL-token escrow is not native SOL. No mainnet, merge to develop or deployment without approval; merging to develop is deployment.

## Execution protocol
Inspect current implementation, define bounded diff, record invariants/touched files, implement one vertical slice, add positive/negative/abuse/failure/regression tests, mutation-prove gates, run prescribed checks, update index/roadmap/HARDENING/since-submission where applicable, and commit verified work. Stop when prerequisite, ADR, security property or human approval is missing.
