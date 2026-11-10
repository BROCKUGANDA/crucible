# Transaction Abstraction Architecture

**Status:** foundation (no Alchemy keys yet; submission path gated)  
**Owner:** Principal Engineer

## Direction

Keep EVM-first. Alchemy is infrastructure (RPC, bundler, indexing, optional
sponsorship), not a chain. Solana remains a separate devnet adapter until its
program is complete. Mainnet stays disabled until all readiness gates pass.

## Layers

1. **Authorization layer** (SIWE + scoped permissions) — who may act.
2. **Transaction orchestration** (provider-neutral) — typed requests, policy
   eval, idempotency, durable outbox, submission workers, receipt watchers,
   finality verification, reconciliation, audit log.
3. **Chain adapters** — EVM (Alchemy-backed), Solana (devnet).
4. **Settlement & evidence** — trial lifecycle, escrow, event verification,
   audit trail.

## Business actions

All business actions are named, schema-validated operations. No arbitrary
contract calldata by default. Persist transaction intent before external
submission. At-least-once processing with idempotent consumers; unique DB
constraints for idempotency and atomic state transitions.

## Alchemy integration (behind feature flag, no keys yet)

- Chain ID validation (server-side, never trust browser).
- RPC health checks, bytecode verification, gas estimation/simulation.
- Submission, receipt retrieval, timeout/error mapping.
- Bounded exponential backoff with jitter, circuit breakers, controlled fallback.
- Separate credentials per environment (demo/preview/production). Never in frontend.

## Sponsored transactions (Sepolia first)

- Separate Gas Manager policy per environment.
- Max total spend, per-sender, per-user-op, per-op count, allowlists,
  contract/method allowlists, expiry, custom approval webhook.
- Approval webhook validates principal, tenant, chain, target, method, operation,
  trial state, idempotency, rate limit, budget, policy version, deadline. Fails
  closed.
- Crucible-side sponsorship ledger + independent limits; reconcile estimated vs
  actual; alert at thresholds; manual emergency disable.

## Smart accounts / delegated execution

- Auth separate from tx authorization.
- Short-lived, scoped, revocable session authorization (least privilege,
  tenant-bound). Never treasury control, unrestricted transfers, unlimited
  approvals, ownership admin, arbitrary execution, withdrawal authority.

## Solana adapter (devnet only)

- RPC, tx construction, simulation, fee-payer abstraction, optional sponsorship
  behind flag, signature collection, submission, confirmation/finality,
  durable indexing, reconciliation.
- Verify Alchemy Enterprise access before depending on Solana sponsorship.
- Existing program uses SPL token accounts, not native-SOL escrow; native-SOL
  rewrite outstanding. No Solana mainnet until independent review.

## Distributed hardening

- Postgres source of truth, transactional outbox, durable queue, worker leases,
  DLQ, retry budgets, idempotent consumers, per-account nonce coordination,
  per-chain concurrency limits, provider health, stale-job recovery, event replay,
  reconciliation workers, immutable audit records.
- No in-memory state as production source of truth for auth/financial/settlement.
- Do not retry ambiguous submissions until reconciled.

## Mainnet readiness

Server-side evaluator; all gates must pass (see `MAINNET_READINESS.md`). If any
gate fails or is unknown, production financial ops stay disabled. No fabricated
deployment records.

## Files (foundation landed)

- `apps/api/src/mainnet-readiness.ts` + tests
- `apps/api/src/alchemy-adapter.ts` + tests
- `docs/runbooks/MAINNET_READINESS.md`

## Blocked on owner action

- Alchemy apps + keys (demo/preview/production).
- Treasury Safe + hardware signers.
- Independent audit sign-off.
- Legal/operational approval.
