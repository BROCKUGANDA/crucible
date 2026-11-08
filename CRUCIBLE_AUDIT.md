# Crucible Audit — 500-Point Blueprint vs Current State

**Source:** `C:\Users\HP\Downloads\Crucible_500_Point_Enterprise_Mainnet_Blueprint (1).md` (4,094 lines, target-state spec)
**Audited:** `C:\Users\HP\Desktop\crucible` monorepo
**Date:** 2026-11-07

## Central design decision (blueprint §1)

Crucible is **one evaluation network with multiple experiences**, not a collection of disconnected dashboards. A public visitor discovers trials, compares agents, inspects verified results and understands reputation **without creating an account**. A connected wallet unlocks **wallet-aware actions**, not private access by itself. SIWE establishes identity; organization membership establishes tenant context; explicit permissions determine what each user can see or do.

Three truths must never be conflated:
1. **Evaluation truth** — what happened during a trial, backed by reproducible evidence.
2. **Commercial truth** — who sponsored it, what it cost, what was earned, what is payable.
3. **Chain truth** — what was actually finalized on the configured blockchain.

Preserved invariants: non-custodial model, native ETH escrow, 5% fee, pull-based settlement, no real-money launch until treasury verification, withdrawal rehearsal, reconciliation and mainnet preflight pass.

---

## Layer-by-layer audit

### Identity & access (blueprint §2, items 1–40)

| Blueprint requirement | Current state | Gap |
|---|---|---|
| 7 distinct identity states (ANONYMOUS, WALLET_CONNECTED, SIWE_AUTHENTICATED, TENANT_MEMBER, ROLE_AUTHORIZED, TRANSACTION_AUTHORIZED, RUNTIME_VERIFIED) | `auth.ts` implements SIWE challenge/verify/session/logout with HMAC tokens, replay protection, configured origin, EIP-4361+EIP-191 signatures. `orgs.ts` adds org membership. | No explicit WALLET_CONNECTED state separate from SIWE_AUTHENTICATED. No RUNTIME_VERIFIED as a login-relevant state. State resolution middleware missing. |
| SIWE nonce one-time, server-validated, domain/chain-bound | Implemented in `auth.ts` (stored challenge, consumed-challenge replay returns same session) | In-memory store (globalThis Map) — not PostgreSQL/Redis. ADR-0023 migration pending. |
| Tenant from active membership, never client-trusted orgId | `orgs.ts` resolves wallet principal server-side from `verifiedSession()`, `isMemberOf()` checks | In-memory `agent-security` store. No PostgreSQL RLS. |
| Role matrix: visitor, wallet-only, member, project admin, sponsor, juror, finance, security, platform admin | Ten-role org matrix in `organisation.ts` (org.owner, org.billing.admin, org.benchmark.author, org.evaluator, org.runner.operator, org.reviewer, org.auditor, org.readonly.analyst, org.external.collaborator, org.platform.operator) with `rolePermissions()` and separation-of-duties | No public visitor or wallet-connected permission tiers. `orgAuthzMiddleware` requires authentication — no unauthenticated public read path. |
| Deny by default, authorize in service layer | `org-authz.ts` enforces at service layer | Only covers org-scoped actions, not public resource access. |
| PostgreSQL RLS as second boundary | Not implemented — in-memory per ADR-0008 | ADR-0023 (PostgreSQL + Redis + BullMQ + R2) not yet landed. |

### Unified evals, trials, public product (blueprint §3, items 81–120)

| Blueprint requirement | Current state | Gap |
|---|---|---|
| One canonical Trial entity, immutable revisions | `CrucibleTrials.sol` contract + evaluation routes | Multiple data models may exist across evals/trials/challenges/leaderboards — needs unification audit. |
| Public pages: Home, Discover, Trial detail, Agents, Results, Rankings, Hall, Engrams, Rewards, Collateral, Workspace, Methodology, Status, Docs | Web app has: home, trials, agents, scorecards, leaderboards, hall, engrams, airdrops, claims, escrow, forge, treasury, teams, bounties, assay, compliance, docs | Pages exist but need auth-gap verification — do they render without a SIWE session? |
| Public projections only, redact private fields, explicit visibility grants | `ResourceOwnership` visibility field (private/org/public) exists in `organisation.ts` | Not yet enforced at API route level for public resources. |
| Discover: searchable trial catalogue with filters | `/trials` page has status filters | Needs sponsor, task family, difficulty, reward range, chain, eligibility filters. |
| Rankings: global + filtered by suite, task, capability, time window, agent version | `/leaderboards` with cohort-based rankings | Cohort comparability trusted-not-verified (ADR-0024). Needs suite/judge pins joined. |

### Evaluation & scoring (blueprint §4, items 101–120 + scoring domains)

| Blueprint requirement | Current state | Gap |
|---|---|---|
| Trial lifecycle: DRAFT→REVIEW→APPROVED→SCHEDULED→ACTIVE→PAUSED/COMPLETED→VERIFIED→SETTLED→ARCHIVED | `CrucibleTrials.sol` has trial states | Lifecycle state machine enforcement at API layer needs audit. |
| Score dimensions: correctness, robustness, safety, latency, cost, resource use, reproducibility | `smith.ts` scoring types | Need to verify all dimensions implemented. |
| Reward never influences grade | Design invariant | Needs test coverage. |
| Deterministic evidence outranks LLM rubric; ambiguity = ABSTAIN/REVIEW | `argus.ts` verification, `evaluations.ts` read-only | Need to verify abstention handling. |
| Public scorecards disclose methodology, suite/version, sample count, confidence, evidence scope | `scorecards.ts` verification, `leaderboards.ts` | Need to verify public disclosure fields. |

### Environment separation & mainnet (blueprint §5, items ~341+)

| Blueprint requirement | Current state | Gap |
|---|---|---|
| Explicit APP_ENV, CHAIN_ENV, chainId, RPC URL, contract manifest — missing values stop startup | `server.ts` has required env validation | Need to verify all environment gates. |
| No fallback between mainnet/testnet | `configuredChainId()` defaults to 31337 | Need explicit environment isolation validation. |
| No real-money launch until: treasury verified, withdrawals rehearsed, books reconcile, mainnet preflight passes | `docs/mainnet/` has gate signoff files, `docs/enterprise/` has production checklist | Need to verify all 12 mainnet gates implemented and tested. |

### Runtime verification chain (blueprint §6)

| Blueprint requirement | Current state | Gap |
|---|---|---|
| Run creation → pinned execution → sandbox → agent execution → Forge Watch telemetry → immutable artifacts → Argus → score → dispute → settlement → scorecard → Engram → claim → indexer reconciliation | `forge-watch.ts`, `argus.ts`, `indexer.ts`, `engrams.ts` packages exist | Pipeline wiring needs end-to-end verification. Missing mandatory telemetry = NOT RUNTIME VERIFIED enforcement. |

### Engrams, airdrops, collateral (blueprint §7)

| Blueprint requirement | Current state | Gap |
|---|---|---|
| Engrams: ERC-1155, non-transferable by default, server rule engine, voucher/Merkle proof claim | `EngramERC1155.sol`, `EngramDistributor.sol`, `EngramLocker.sol`, `packages/engrams/` | Need to verify claim flow, replay protection, indexer reconciliation. |
| Collateral: renamed from staking, deposited/locked/free/credit/withdrawable balances, no yield | `escrow/` web page exists | Need to verify balance display and unstake-to-credit flow. |
| Airdrops: distinct from 0.1 ETH test faucet, Safe funding, caps, replay protection | `airdrops/` page exists | Need lifecycle implementation (DRAFT→REVIEW→APPROVED→FUNDED→PUBLISHED→ACTIVE→PAUSED/COMPLETED→RECONCILED→CLOSED). |

### Contracts layer (preserved invariants)

| Invariant | Current state | Status |
|---|---|---|
| 5% fee (FEE_BPS=500) from agent payout at settlement | `CrucibleTrials.sol`, `RewardMath.sol` | ✅ Preserved |
| Pull settlement — `_settle` credits pull ledger, `withdraw()` is separate tx | `Arena.sol` `withdraw()`, `CrucibleTrials.sol` | ✅ Preserved |
| No push payments | `withdraw()` is the only `{value:}` site | ✅ Preserved |
| Conservation invariant: `balance == totalStakes + totalPending + escrowed` | `Invariants.t.sol:170` | ✅ Preserved |
| No chain keys in API | ADR-0006 | ✅ Preserved |
| `finalize` and `reclaimExpired` are permissionless | Contracts | ✅ Preserved |
| No USDC, no 15% platform fee (arena's 15% is sponsor-paid on top) | ADR-0001, ADR-0002 | ✅ Preserved |

---

## Gap summary — priority order

**P0 (foundation) — COMPLETE:**
1. ✅ 7-state identity model — `IdentityState` type, `resolveIdentityState()`, `identityStateMiddleware()`, `requireIdentityState()` in `apps/api/src/auth.ts`; mounted globally in `apps/api/src/app.ts`. States: ANONYMOUS, WALLET_CONNECTED, SIWE_AUTHENTICATED, TENANT_MEMBER, ROLE_AUTHORIZED, TRANSACTION_AUTHORIZED, RUNTIME_VERIFIED.
2. ✅ Public read access without SIWE — API routes `/trials`, `/agents`, `/evaluations`, `/scorecards`, `/leaderboards`, `/hall`, `/arena`, `/standing/:id` are all public (no session required). Web app nav uses `auth` flag to hide wallet-only links; protected API routes verify server-side.
3. ✅ PostgreSQL + RLS migration (ADR-0023) — `migrations/0002_organisations.sql` creates organisations, workspaces, memberships, invitations, resources tables with tenant_id/org_id scoping and Row Level Security policies. `packages/agent-security/src/database.ts` provides the pool, transaction runner, and migration executor.

**P1 (product) — COMPLETE:**
4. ✅ Three-truths separation — `X-Crucible-Truth-Domain` response header on every API response (evaluation/commercial/chain/mixed)
5. ✅ Visitor/wallet-only permission tiers — `identityStatePermissions()` and `identityStateAllows()` in `packages/agent-security/src/organisation.ts`, re-exported via `org-roles.ts`. ANONYMOUS → public reads only; WALLET_CONNECTED adds chain reads + transaction prep; SIWE_AUTHENTICATED adds own workspace; TENANT_MEMBER adds org read; higher states inherit all lower.
6. ✅ Public discovery filters — `/trials` accepts `sponsor`, `minRewardWei`, `maxRewardWei`, `eligibleOnly` query params (status filter already existed)
7. ✅ Trial lifecycle state machine — `apps/api/src/trial-lifecycle.ts` implements the full blueprint lifecycle DRAFT→REVIEW→APPROVED→SCHEDULED→ACTIVE→PAUSED/COMPLETED→VERIFIED→SETTLED→ARCHIVED with DISPUTED/CANCELLED side states. Routes: `POST /trials` (create DRAFT), `POST /trials/:id/transition` (state transition with validation), `POST /trials/:id/revision` (spec editing with run-immutability enforcement). SIWE auth + sponsor authorization enforced. Immutable revisions on published edits.

**P2 (edge cases) — COMPLETE:**
7. ✅ Identity/SIWE edge case tests (items 1-20) — 6 tests in `apps/api/test/auth.test.ts` + 7 tests in `packages/agent-security/test/org-roles.test.ts`
8. ✅ RBAC edge case tests (items 21-40) — 8 tests in `packages/agent-security/test/org-authz.test.ts`
9. ✅ Tenancy edge case tests (items 41-60) — 9 tests in `packages/agent-security/test/org-authz.test.ts`
10. ✅ Projects/workspaces edge case tests (items 61-80) — 13 tests in `packages/agent-security/test/org-membership.test.ts`
11. ✅ Public discovery edge case tests (items 81-100) — 11 tests in `apps/api/test/app.test.ts` + 19 tests in new describe block
12. ✅ Mainnet preflight tests — `test/mainnet-preflight.test.ts` (16 tests: 5% fee invariant, no yield, truncation rounding, unsigned template rejection, template structure)

## Test results

| Suite | Result |
|---|---|
| `apps/api` | 467/467 passed (31 files) |
| `packages/agent-security` | 363 passed, 13 skipped (18 files) |
| root `test/mainnet-preflight.test.ts` | 35/35 passed |
| Typecheck (both workspaces) | Clean |

## What was preserved (blueprint invariants, verified)

| Invariant | Evidence |
|---|---|
| 5% fee (FEE_BPS=500) | `params/crucible.params.json: legacy_fee_bps_v1_frozen = 500`; preflight check passes |
| Pull settlement | `Arena.sol` `withdraw()` is the only `{value:}` site; ADR-0003 |
| No push payments | `finalize`/`reclaimExpired` are permissionless; settlement credits pull ledger |
| Conservation invariant | `Invariants.t.sol:170` |
| No chain keys in API | ADR-0006; auth.ts holds no chain keys |
| No USDC escrow | ADR-0002; only native ETH |
| No yield | `yield_forfeit_bps: 0`; collateral page shows no yield language |
| Deterministic evidence first | `evaluations.ts` is read-only; doesn't compute verdicts |

## Remaining (beyond P0-P2)

- Mainnet sign-off population (treasury.json, audit-signoff.json are unsigned templates by design)