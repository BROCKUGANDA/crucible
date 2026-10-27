# Crucible — Roadmap

> Phases, not gate numbers. The gate register (`docs/gates.yml`) already
> occupies ids 817–875, so any pasted plan numbering in that range collides
> and is refused. Next free gate id at last read: **881** — re-read the
> register tail before assigning. Milestones below graduate into gates only
> when they become buildable work.

## Shipped (see `docs/since-submission.md` for the dated log)

- v1 escrow + AlloyRegistry on-chain, 5% canonical fee, full trial lifecycle.
- Keeper sweeps, Argus juror seats, gas ledger, trace spine.
- Funder service with honest degraded mode (no key → `configured:false`).
- MCP agent surface (11 tools + subscriptions), PayFi/RWA grader suites.
- Live deployment, pitch + demo videos, one-command e2e (`npm run test:e2e`).

## Phase 1 — Mainnet readiness (gated, not dated)

Nothing here ships by writing code alone. Each item is a human fact:

1. **External audit** (gate G-867 scope) — contracted, completed, findings closed.
2. **Legal entity + counsel** — formed, terms reviewed.
3. **Funded multisig deployer** — signers named, genesis funded.
4. **Named on-call + monitoring** — humans, pagers, runbooks.
5. **Genesis cohort** — committed sponsors with real ETH.
6. **Timelock + progressive exposure caps** — deployed, preflight green.

Exit criterion: `node scripts/mainnet-preflight.mjs` exits 0 on the real
tree. Today it exits 1, and that red is the gate working.

## Phase 2 — v2 arena (designed, not built)

Per ADR-0011: frontier-model bench with its own economics
(`ARENA_FEE_BPS = 1500`, break prize 3000 bps), Argus court draws, seat
bond floors. Contracts exist with forge coverage; the demo posts one trial
but no panel has been drawn against it (O1–O8 proven in `forge test` only).

## Phase 3 — Adjacent chains and settlement edges

- **Solana work-escrow:** port mirrors EVM `RewardMath` at `FEE_BPS = 500`.
  Current state: untracked work-in-progress, does not compile (Anchor
  lifetime/ID errors outside the fee module). Compile → parity tests →
  commit, in that order.
- **PayFi/RWA settlement:** explicitly requires a NEW ADR and contract
  review. Stablecoin or tokenized-asset flows entering escrow would be a
  product pivot, not a feature flag.

## Never (doctrine)

- No ERC-20, no bridge, no custody on the settlement path (ADR-0001).
- No fee confusion: v1 500 bps vs v2 arena 1500 bps stay in separate
  constants, separate laws, separate tests.
- No fake shapes on runtime paths: unconfigured services report
  `configured:false`; ungated claims stay design-only in the register.
