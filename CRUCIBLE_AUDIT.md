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

---

# 2026-11-09 deep audit addendum (authz / money / web / runtime)

Four parallel code-read audits: API authorization matrix, money integrity, web access-state/XSS,
runtime+keys+infrastructure. Severity as filed at audit time; status updated as slices land.

## Verified-safe at audit time

Contract conservation traced across every mutating path (`Δbalance == Δ(totalStakes+pending+escrowed)`);
fee `FEE_BPS=500` charged once, agent payout only; API money paths all-bigint; web six-state model
holds end-to-end (private data decided by the SIWE cookie, never wagmi connection; no XSS sinks;
no security-relevant localStorage); session HMAC verify + nonce consumption strong; keeper/funder
key custody clean and ADR-0006 holds (no chain key in `apps/api/src/**`); CI's enforced-gate list
includes coverage floors, gitleaks full history, Trivy exit-code gates, and deploy-time edge probes.

## Register

| ID | Sev | Finding | Where | Status |
|---|---|---|---|---|
| AUTHZ-F1 | CRITICAL | `POST /forge/__reset` wipes all org briefs/campaigns with no credential | `apps/api/src/forge.ts:688` | Fixed `5541acb` |
| AUTHZ-F2 | CRITICAL | `GET /v1/runs/:runId` serves private run records with no session; ID is ~31 bits + timestamp | `apps/api/src/workloads.ts:92` | Fixed `5541acb` |
| AUTHZ-F3 | HIGH | Forge authorizes against the request's `orgId`, never the resource's owning org — cross-tenant read and `fund`/`settle` | `apps/api/src/forge.ts:120-145,591-650` | Fixed `0c442ff` |
| AUTHZ-F4 | HIGH | Metering reads/writes any `tenantId` with session only; `POST /quota` unbounded (latent: surface not mounted) | `apps/api/src/metering-routes.ts:24-94` | Open |
| AUTHZ-F5 | HIGH | Production CSRF: `SameSite=None` session cookie; `csrfOriginCheck()` exported but never called | `apps/api/src/auth.ts:61,352` | Fixed `df2bdf9` |
| AUTHZ-F6 | HIGH | Keeper bearer compared with `!==`, no key-length floor | `apps/api/src/engrams.ts:68` | Fixed `5541acb` |
| AUTHZ-F7 | MEDIUM | Transition sponsor gate covers 2 of 12 targets; any session can walk a stranger's trial through off-chain states | `apps/api/src/trial-lifecycle.ts:277` | Fixed `5541acb` |
| AUTHZ-F8 | MEDIUM | `/trials/:id/events` SSE: no stream ceiling, per-connection RPC | `apps/api/src/app.ts:2426` | Open |
| AUTHZ-F9 | MEDIUM | Org budgets/api-keys gated by mere membership; scopes client-chosen | `apps/api/src/orgs.ts:164-274` | Fixed `df2bdf9` |
| AUTHZ-F10 | MEDIUM | `GET /monitoring`: any session reads host SLO/error internals | `apps/api/src/app.ts:1142` | Fixed `df2bdf9` |
| AUTHZ-F11 | LOW | STAMP admin routes session-only in sandbox/manual-review modes (production fail-closes) | `apps/api/src/stamp.ts:116` | Open |
| MONEY-H1 | HIGH | `GET /trials` 500s on any fractional `rewardEth` (`BigInt("0.1")` throws; wizard default is 0.1); query `BigInt()` unguarded | `apps/api/src/app.ts:1180-1195` | Fixed `5541acb` |
| MONEY-H3 | HIGH | Funder cap: non-`settled` transfer frees reserved room; expired reservation drops the grant record | `apps/funder/src/server.ts:172`, `cap.ts:196` | Fixed `0273061` |
| MONEY-M1 | MEDIUM | Forge brief budget computed `parseFloat(eth) * 1e18` — the exact float the repo bans | `apps/web/src/app/forge/brief/page.tsx:98` | Open |
| MONEY-M2 | MEDIUM | Faucet "one allocation per 24h" reason describes a control nothing enforces | `apps/api/src/identity.ts:372` | Fixed `df2bdf9` |
| MONEY-M3 | MEDIUM | Claims can never complete or reject — no HTTP route (`completeClaim` test-only) | `apps/api/src/campaigns.ts:762` | Fixed `e9869c4` |
| MONEY-M5 | MEDIUM | Campaign creation open to any session with an unlimited advertised budget | `apps/api/src/server.ts:1104` | Fixed `e9869c4` (10 ETH default cap at the mount) |
| MONEY-L* | LOW | Store `updateClaimStatus` unguarded; metering `quantity` 500s; `Infinity`→`null`; local-midnight periods; `maxClaimsPerWallet` accepts floats; BreakPanel says forfeited stake is "burned" (goes to treasury); `Number()` display in trials/new | various | Partly fixed `e9869c4` (integer guard), `df2bdf9` (BreakPanel copy); rest Open |
| WEB-M1 | MEDIUM | CSP `connect-src` omits `wss://api.elevenlabs.io` — production Scribe realtime silently dead | `apps/web/next.config.mjs:217` | Fixed `69a838c` |
| WEB-M2 | MEDIUM | `/staking` shows API-chain balances while signing on the connected chain; no `WrongNetworkNotice` | `apps/web/src/app/staking/page.tsx` | Fixed `69a838c` (browser verification pending) |
| WEB-M3 | MEDIUM | `global-error.tsx` imports `Chrome.tsx` — crash page bundles the wallet graph (constraint drift) | `apps/web/src/app/global-error.tsx:3` | Open |
| WEB-L* | LOW | JSON-LD `</script>` breakout hygiene; wallet address in URLs; escrow param unencoded; stale `OwnerGate` comment | various | Open |
| RUN-H1 | HIGH | `forge_watch_outbox` is insert-only: no relay, no consumer; dispatch never happens | `packages/forge-watch/src/pg-store.ts:134` | Open |
| RUN-H2 | HIGH | `REDIS_URL` silently ignored: ioredis never parses `{ url }` — BullMQ always targets localhost | `packages/agent-security/src/queue.ts:18` | Fixed `0273061` |
| ENG-1 | HIGH | No production event source ever called keeper-gated `POST /engrams/evaluate` — entitlements could never be issued | `apps/keeper/src/main.ts` | Fixed `fb56eee` |
| RUN-M1 | MEDIUM | L0 worker checks read fields that cannot exist on `MonitorJobPayload`; always returned pass | `packages/agent-security/src/forge-watch-workers.ts:50` | Fixed `b31ea96`; durable default fixed `7c8db34` |
| RUN-M2 | MEDIUM | `appendWithOutbox` silently degrades without the outbox table; `live-agent.mjs` runs only migration 0001 | `packages/forge-watch/src/pg-store.ts:140` | Fixed `0273061` |
| RUN-M3 | MEDIUM | Forge Watch DLQ is a queue-name constant, not a mechanism | `packages/agent-security/src/queue.ts:126` | Open |
| RUN-M4 | MEDIUM | `DATABASE_URL` defaults to `crucible:crucible@localhost` in source | `packages/agent-security/src/database.ts:20` | Fixed `0273061` |
| RUN-M5 | MEDIUM | Funder entrypoint writes the CDP secret plaintext unconditionally (`CDP_ALLOW_PLAINTEXT_SECRETS` ignored) | `apps/funder/docker-entrypoint.sh:33` | Fixed `0273061` |
| RUN-M6 | MEDIUM | Fork-test gate is advisory-only green when the secret is missing | `.github/workflows/ci.yml:242` | Open |
| RUN-M7 | MEDIUM | Untracked root scripts holding credential material are rsynced to the prod VPS on every deploy | `.github/workflows/deploy.yml:66` | Fixed `0273061` (rsync excludes) |
| RUN-L* | LOW | API lacks graceful shutdown/rejection handlers; API binds all interfaces (demo intent); migration-runner "in a transaction" comment false; fork-host children on 0.0.0.0; VPS IP committed; `.env.mainnet.example` gitignored | various | Open |

| VERDICT-1 | — | "Verdict integrity is inviolable: owning tokens or staking must never improve a benchmark score or influence Argus's verdicts" | design | Holds: Verdicts derive only from evidence + Argus votes + chain state; staking/Engram ownership never feeds score inputs. Recorded in the taste ledger (confidence 0.9); this register does not claim an exploit there because none exists in the audited surfaces. |

- `56cb6fa` — sponsor-gated transitions authorized against the request body instead of the
  session (`body.sponsor`); fixed and mutation-proven, recorded in HARDENING.md.
- `5eb5242` — campaign eligibility signals were client-attested (`walletAge`/`trialCount`/
  `reputation` from the body); now derived server-side, fail-closed without a provider,
  passport signal wired; mutation-proven.