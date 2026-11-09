# Arena + Transaction Abstraction — Implementation Plan (staged)

Combines the two principal-engineer directives into one ordered plan. Stages are sized so
each lands green through the promotion ladder (develop → staging → main → deploy).
Evidence rule from the directives applies throughout: never claim a stage done without
commit-SHA + environment-specific test results.

## Already landed (this branch)

- Stage A audits: `docs/design/ARENA_CURRENT_STATE_AUDIT.md`,
  `docs/engineering/TRANSACTION_ABSTRACTION_BASELINE.md`.
- Truthfulness fixes on the landing hero (real-money / on-chain / sealed-sandbox wording).
- Arena information architecture in navigation (Arena / Codex / Warden / Forge /
  Workspace, dual naming with plain glosses).
- `--arena-*` semantic token layer (aliases, no palette fork).

## Stage order

### 1. Brand foundations (design)
Master seal + trial/tribunal/challenge emblems as SVG in `apps/web/public/brand/`; wordmark
variants; document rules in `docs/design/CRUCIBLE_BRAND_SYSTEM.md`. Reuse the vendored
Cinzel/mono stack; no new font dependencies.

### 2. Homepage (Stage C of Arena directive)
Rebuild hero within the existing `ScrubStage` six-act structure: decisive first screen
("THE ARENA DOES NOT REWARD PROMISES." + ENTER THE ARENA / READ THE CODEX), live activity
strip from `useSnapshot`, keep all six acts. Update `claims-registry.ts` in the same
commit as any copy change (see audit §8).

### 3. Signature screens
- Trial card fields: name, sponsor, bond, verification method (gap list in audit §5) —
  backend already exposes these or they are derivable; verify per field.
- Tribunal surface: wrap `/bounties` + trial-detail verdict panels into a named route
  with an honest "what exists today" scope (no committee UI until reviewer endpoints exist).
- Hall: decay/standing visualization from existing snapshot data only.

### 4. Game-theory layer (The Strategium)
Trial economics panel sourced from `/clock` contract reads (reward, bond, challenger
stake, window, fee). No invented probabilities — "Not enough historical data" label.
This is additive and high-value for Product Hunt: the payoff math is real and on-chain.

### 5. Transaction abstraction (engineering)
Follow `TRANSACTION_ABSTRACTION_BASELINE.md` §10 order: relayer ADR → durable
nonce/revocation/queue state → per-chain server client → Alchemy behind the edge gate →
idempotency + outbox extension → Gas Manager policy on Sepolia → Solana devnet adapter.
**Owner actions required before any of it:** three Alchemy apps + keys (see baseline §11).

### 6. Motion, hardening, release
Seal/verdict animations with reduced-motion variants; accessibility pass (WCAG 2.2 AA
spot-checks); performance measure before/after; E2E journeys from the directive §17.

## Definition of done

Per directive §21 — the homepage looking impressive is not done. Done is: coherent brand
across major routes, all visible actions work, mock data labeled, security boundaries
preserved (ADR-0006 intact outside the sponsored path), tests green, deployment state
documented with commit SHA.

## Deliberately not scheduled

Solana mainnet (program rewrite outstanding); Engram on-chain minting (ADR-gated);
seasons/tournaments/houses beyond the nav label (no product state behind them yet —
"Houses · Teams" is a label over the real teams ledger, nothing more).
