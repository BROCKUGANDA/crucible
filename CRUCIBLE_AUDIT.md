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
| MONEY-H4 | HIGH | A sponsor's funding was an API claim: `depositToEscrow(programId, amountWei)` believed the deposit because the API wrote it down, so a console could report a programme as funded that never received a wei; the programme scaffolding was in process memory and did not survive a restart | `apps/api/src/sponsor-onboarding.ts:358` | Fixed 2026-11-20 for the funding truth — claims and chain receipts are durable (`migrations/0011_sponsor_funding_chain_truth.sql`) and verified against the arena over public RPC; the sponsor's escrow is `reward + fee` as read from the chain, never `deposited`; an unreadable chain is `unverifiable`, never `mismatch`. The programme scaffolding is STILL in memory — see the open note in HARDENING.md |
| MONEY-H5 | HIGH | The sponsor console's ledger total was always zero: the funding summary was built from the chain's receipts with each receipt's claimed amount dropped on the way in, so a programme with a 1.15 ETH claim showed "the ledger claims 0 ETH" beside "the escrow holds 1.15 ETH" | `apps/api/src/sponsor-funding-routes.ts` | Fixed 2026-11-20 — the summary is built from the claims and the receipts separately (`summarizeProgrammeFunding`), an unchecked claim is its own column rather than a contradiction, and four mutations are proven red in `apps/api/test/programme-funding-summary.test.ts` |
| DOC-M2 | MEDIUM | The panel shown when the API is unreachable said "Couldn't reach the chain", pointing the reader at the wrong machine; it is shown on the reference, Studio and console pages, all of which read the API | `apps/web/src/components/Chrome.tsx:452` | Fixed 2026-11-20 — `SignalLost` takes what could not be reached; chain pages keep "the chain", API pages say "the host" |
| MONEY-H6 | HIGH | A sponsor's funding claim could not be recorded in ANY real deployment: `sponsor_funding_claims.org_id REFERENCES organisations(id)` and nothing in the repository ever writes an organisation (the tenancy model is in process memory, `packages/agent-security/src/org-store.ts`), so every claim died at the foreign key | `migrations/0011_sponsor_funding_chain_truth.sql` | Fixed 2026-11-20 — the constraint is dropped in `migrations/0012_sponsor_ledger_durable.sql`; the tenant boundary is enforced in the route against the in-memory membership model, which is the real source of truth today, and the row-level policies are kept for when that model becomes durable. Measured against a real PostgreSQL 17, not inferred |
| MONEY-H7 | HIGH | The sponsor's ledger was process memory: sponsors, programmes, the eight budget counters and the budget's own ledger were `Map`s, so a restart lost every programme and the durable funding claims hung off programmes that no longer existed | `apps/api/src/sponsor-onboarding.ts` (before this slice) | Fixed 2026-11-20 — the records live in PostgreSQL behind a `SponsorStore` interface (`apps/api/src/sponsor-programme-pg.ts`), the API says which ledger it is using at boot, and a sponsor, a programme, its budget and its ledger entries were written through the API, the process killed, a new one started, and all of it read back |
| MONEY-M1 | MEDIUM | The budget's ledger had no defined order (two movements written in the same millisecond sorted by a random id, so the order changed every run), and `paid` was decremented by a withdrawal while the module's own published invariant requires `paid >= withdrawn` | `migrations/0009_sponsor_and_commercial.sql`, `apps/api/src/sponsor-onboarding.ts` | Fixed 2026-11-20 — the ledger and the funding receipts carry a `BIGSERIAL` `seq` and are read by it; `paid` and `withdrawn` are both cumulative, so a withdrawal no longer contradicts the invariant, and two withdrawals that would pay out more than was paid are refused |
| MONEY-M2 | MEDIUM | The programme and budget-entry routes returned domain objects holding `bigint`; `JSON.stringify` throws on a bigint, so those routes failed outright, and the console's programme list was never rendered | `apps/api/src/sponsor-routes.ts` | Fixed 2026-11-20 — every wei leaves as a decimal string, through explicit serializers rather than a cast |
| AUTHZ-D1 | MEDIUM | The organisation and membership model was process memory by design (ADR-0008's spirit; `org-store.ts` said persistence was deferred): a restart lost it, and under Octane — one `globalThis` per worker process — two workers could disagree about who is a member of what, which is how a tenancy check decides who may read a sponsor's funding ledger | `packages/agent-security/src/org-store.ts` | Fixed 2026-11-20 — the tenancy model is durable; the store is a cache over PostgreSQL, written before it is visible and refilled at boot (ADR-0033), and the non-durable path is refused while a backing is attached. **The row-level policies are still inert**: they need the API to connect as a non-owning role and the principal to be set per request, which is the next step of ADR-0033 | | Partly fixed 2026-11-20 — the MEMBERSHIP model (ADR-0033), the AUDIT CHAIN (ADR-0037), the CONFLICT REGISTER (ADR-0038), the REVIEW QUEUE (ADR-0039) and the API KEYS (ADR-0040) are now durable; the register's declarations survive a restart, the conflict check keeps working on them, and a conflict now **bars** a reviewer from a case (AUDIT-D1/REVIEW-D1). **Still in memory:** budgets and quotas, and webhook endpoints |

| MONEY-L* | LOW | Store `updateClaimStatus` unguarded; metering `quantity` 500s; `Infinity`→`null`; local-midnight periods; `maxClaimsPerWallet` accepts floats; BreakPanel says forfeited stake is "burned" (goes to treasury); `Number()` display in trials/new | various | Partly fixed `e9869c4` (integer guard), `df2bdf9` (BreakPanel copy); rest Open |
| WEB-M1 | MEDIUM | CSP `connect-src` omits `wss://api.elevenlabs.io` — production Scribe realtime silently dead | `apps/web/next.config.mjs:217` | Fixed `69a838c` |
| WEB-M2 | MEDIUM | `/staking` shows API-chain balances while signing on the connected chain; no `WrongNetworkNotice` | `apps/web/src/app/staking/page.tsx` | Fixed `69a838c` (browser verification pending) |
| WEB-M3 | MEDIUM | `global-error.tsx` imports `Chrome.tsx` — crash page bundles the wallet graph (constraint drift) | `apps/web/src/app/global-error.tsx:3` | Open |
| WEB-L* | LOW | JSON-LD `</script>` breakout hygiene; wallet address in URLs; escrow param unencoded; stale `OwnerGate` comment | various | Open |
| RUN-H1 | HIGH | `forge_watch_outbox` is insert-only: no relay, no consumer; dispatch never happens | `packages/forge-watch/src/pg-store.ts:134` | Fixed 2026-11-20 — the relay existed but ran nowhere; a production pipeline (`packages/agent-security/src/forge-watch-telemetry.ts`) and a runnable service (now `packages/agent-security/src/worker-service.ts`, run as `npm run worker:service`) now claim rows, dispatch them to the L0 queue and persist the findings the monitor detects. Proven end-to-end against a real Redis and a real BullMQ worker (`packages/agent-security/test/forge-watch-telemetry.e2e.test.ts`) |
| RUN-H4 | HIGH | `apps/api/src/worker.ts` was a stub: six processors returned success-shaped answers without doing the work (`{status:"scheduled"}`, `{delivered:true}`, `{cleaned:true}`, `{reset:true}`, `{reconciled:true}`); its self-re-arming repeat pattern ran "hourly" jobs exactly once (BullMQ keeps completed jobs, so the re-added id was swallowed); nothing ran it — the compose `worker` service started a second API server because the entrypoint ignored its argument | `apps/api/src/worker.ts`, `apps/api/docker-entrypoint.sh` | Fixed 2026-11-20 — one worker entrypoint (`apps/api/src/worker.ts` over `packages/agent-security/src/worker-service.ts`), BullMQ's `upsertJobScheduler` for recurring jobs, a real final drain on shutdown, an explicit role switch in the entrypoint that refuses an unknown role. The stub jobs that could not do their work (`quota_reset`, `cache_cleanup`) are not registered at all |
| RUN-H2 | HIGH | `REDIS_URL` silently ignored: ioredis never parses `{ url }` — BullMQ always targets localhost | `packages/agent-security/src/queue.ts:18` | Fixed `0273061` |
| ENG-1 | HIGH | No production event source ever called keeper-gated `POST /engrams/evaluate` — entitlements could never be issued | `apps/keeper/src/main.ts` | Fixed `fb56eee` |
| RUN-M1 | MEDIUM | L0 worker checks read fields that cannot exist on `MonitorJobPayload`; always returned pass | `packages/agent-security/src/forge-watch-workers.ts:50` | Fixed `b31ea96`; durable default fixed `7c8db34` |
| RUN-M2 | MEDIUM | `appendWithOutbox` silently degrades without the outbox table; `live-agent.mjs` runs only migration 0001 | `packages/forge-watch/src/pg-store.ts:140` | Fixed `0273061` |
| RUN-M3 | MEDIUM | Forge Watch DLQ is a queue-name constant, not a mechanism | `packages/agent-security/src/queue.ts:126` | Fixed 2026-11-20 — a dead letter is now a durable PostgreSQL row in `forge_watch_dead_letters` (`packages/forge-watch/src/dead-letter.ts`) with operator list / replay / resolve, not a Redis object that a flush erases. The relay's attempt ceiling quarantines a poison message instead of retrying it forever |
| RUN-M4 | MEDIUM | `DATABASE_URL` defaults to `crucible:crucible@localhost` in source | `packages/agent-security/src/database.ts:20` | Fixed `0273061` |
| RUN-M5 | MEDIUM | Funder entrypoint writes the CDP secret plaintext unconditionally (`CDP_ALLOW_PLAINTEXT_SECRETS` ignored) | `apps/funder/docker-entrypoint.sh:33` | Fixed `0273061` |
| DOC-M1 | MEDIUM | No machine-readable description of the API's own rules; the developer portal documented limits in prose that could not drift-gate | `apps/api/src/app.ts` | Fixed 2026-11-20 — `GET /v1/contract` serves the pagination rules, rate limit, auth schemes, webhook signing and every error code, read from the modules that enforce them; a test reads the routes' source and fails on an undocumented or phantom code. It found 31 undocumented codes when written |
| RUN-M6 | MEDIUM | Fork-test gate is advisory-only green when the secret is missing | `.github/workflows/ci.yml:242` | Open |
| RUN-M7 | MEDIUM | Untracked root scripts holding credential material are rsynced to the prod VPS on every deploy | `.github/workflows/deploy.yml:66` | Fixed `0273061` (rsync excludes) |
| REPL-D1 | HIGH | The reproducibility rule — "three INDEPENDENT replays must agree" — was never checked for independence: the state machine counted completed replays and compared their outputs, and the Studio filled each replay's `workerIdentity` with the CALLER's own label for it, so a caller could satisfy any independence check by naming its three replays `worker-a`, `worker-b` and `worker-c`. The published card quoted the rule while proving nothing about it. The measurement (the replay manifest) was also a module map: a restart erased it, so a card or a bundle described a measurement that could no longer be re-derived | `apps/api/src/replay-manifest.ts`, `apps/api/src/studio-routes.ts`, `apps/api/src/publication.ts` | Fixed 2026-11-20 — **independence is now decided on the WORKER, and the worker is derived** (ADR-0036): a replay's identity is the party the observation came from, the caller's label is kept and never consulted, and `REPRODUCIBLE` requires three agreeing replays from three DIFFERENT workers. The manifest says WHICH of the two reasons it is not (they disagreed, or they agreed and did not come from enough workers). The card carries the worker count, the independence verdict and a derived limit — inside its digest, so two cards that differ only in independence have different addresses. The Studio's verdict names changed to `AGREED` / `NOT_AGREED` and it reports the independence separately, because it runs the replays itself and cannot establish independence. The measurement is durable (`replay_measurements`, migration 0016); the replay store is chosen once at boot. **Still open:** the multi-worker fleet that would make independent replays possible does not exist (ADR-0030), so no surface can yet claim independent reproduction |
| DATA-D1 | MEDIUM | The suite version's "digest" was not a digest: the in-memory route passed a principal object where the field asks for a content address (`createSuiteVersion(input, { principalId } as any)`), and the PostgreSQL route did not write the column at all — `spec_digest` is NOT NULL with no default, so `pgCreateSuiteVersion` could not insert | `apps/api/src/suites-routes.ts:126`, `apps/api/src/suites-pg.ts` | Fixed 2026-11-20 — `computeSuiteVersionDigest()` hashes the version's own content through the repository's one hashing door (gate 629), the route no longer passes an object, and the PostgreSQL insert writes the digest and every content column it was dropping. Without this the comparability key of a published method would have compared an object against a string |
| HASH-D1 | LOW | The evaluation spec's digest was computed with a hand-rolled `JSON.stringify`, a second hashing convention beside the repository's canonical JSON hash (gate 629) | `apps/api/src/evaluation-spec.ts` | Fixed 2026-11-20 — the module now hashes through `@crucible/crypto`'s canonical JSON hash like everything else; the digest string changes, the content set does not, and nothing outside the module consumed it |
| MIG-D1 | MEDIUM | `runMigrations()` took no lock, so two processes migrating at once deadlocked or raised "tuple concurrently updated" — and the API migrates on boot, so a multi-worker boot could crash-loop | `packages/agent-security/src/database.ts` | Fixed 2026-11-20 — the migration run takes a PostgreSQL advisory lock (`pg_advisory_lock`) and releases it on the same session, so migrators serialise across processes. Found by running two database-backed suites at once, and proven by a test that migrates twice concurrently |
| BUILD-D1 | MEDIUM | The `fork-host` workspace cannot be built: its `build` script is `tsc -p tsconfig.build.json` and that file does not exist, so `npm run build` (which builds every workspace) fails there. The workspace runs from source in development and its `start` script expects a `dist/` that the build never produces | `apps/fork-host/package.json`, `apps/fork-host/` | Open — not introduced by any of the 2026-11-20 slices (the file is absent in the committed tree). It needs either a `tsconfig.build.json` or a different build script, and it matters for deployment: a host image that builds the workspaces cannot produce the fork host |
| DISP-D1 | MEDIUM | Nothing froze the evidence a dispute is decided on: the disclosure log, the off-chain spec/manifest/score stores and the content store each moved on their own, so a committee reading the evidence twice could read two different sets of facts, and an omission was indistinguishable from a completeness | `apps/api/src/disclosure.ts`, `apps/api/src/replay-manifest.ts`, `apps/api/src/content.ts` | Fixed 2026-11-20 — a dispute now reads a FROZEN BUNDLE (ADR-0035): content-addressed, append-only, durable, and stating in its own contents what it does NOT contain (the suite not disclosed, no replay manifest, no score, fewer than three replays, replays that did not agree). The seal is compared with the break on the CHAIN's clock, and the order is "unknown" rather than a guess when that clock cannot be read. **Still open:** the off-chain stores the bundle reads are in process memory (REPL-D1), and the content store is a host-local directory in this deployment |
| REPL-D2 | MEDIUM | Migration 0008 defines `replay_manifests` and `replay_records` with a different, spec-bound model (every row must name an `evaluation_spec_id` and a `trial_revision_hash`, carry a `manifest_digest`, and a `replay_status` CHECKed against a set that excludes `RUNNING`), and **nothing in the codebase writes them**: the tables were designed and never connected, while the live manifest lived in a module map under different names. Two replay models, one of them dead but still in the schema | `migrations/0008_evaluation_integrity.sql`, `apps/api/src/replay-manifest.ts` | Open — the durable store uses its own tables (`replay_measurements`, `replay_measurement_records`, migration 0016) rather than reusing the 0008 ones, because reusing them would mean inventing values the live model does not have and fabricating data to satisfy a NOT NULL. The two schemas are reconciled in a later change; until then the 0008 tables are dead weight with RLS policies attached, and a reader of the schema could reasonably think they are the live ones |
| AUDIT-D1 | HIGH | The organisation audit log claimed to be hash-chained and tamper-evident, and was neither. It asked for `sha256` through `require()`, which does not exist in an ES module — the error was swallowed and the chain was linked with a **31-multiplier rolling hash, eight hex characters long**, so anybody could recompute a forged chain. And the write-time hash covered the RAW metadata while the entry stored the REDACTED metadata, so an ordinary `api_key:create` entry (the redaction list covers any key containing "key") produced a hash that no longer matched what was stored and `verifyChain` reported the chain as **tampered after an innocent write**; the raw metadata in the hash was also a digest of a secret, which is an oracle for that secret. The log was in process memory, so a restart erased it, and a chain that restarted at "genesis" would orphan every entry written before it | `packages/agent-security/src/org-audit.ts` | Fixed 2026-11-20 — the hash is `hashCanonical` over exactly what is stored (ADR-0037): a real sha256 over canonical JSON (so it depends on the content, not on the key order), over the REDACTED metadata (so the redaction cannot break the chain and no secret reaches a digest). The chain is durable (`org_audit_entries`, migration 0017) and CONTINUES across a restart — the head is the last row, not a field in memory — and the append is serialised with an advisory lock that checks the link INSIDE the transaction, so two writers cannot fork the chain. **Still open:** budgets, conflict-of-interest declarations, webhooks and API keys are still in process memory, and the row-level-security policy on the audit table follows the organisation tables' pattern — it only bites for a connection that does not own the table, and the role split is still to come |
| REVIEW-D1 | MEDIUM | The reviewer's own side of a review — who holds a case, who stepped away from one, and why — was not modelled at all, while the conflict register and the audit chain that would hold it were durable and had **no consumer**: a declaration could be recorded and then change no decision anywhere in the platform. A conflict of interest that changes no behaviour is a decoration, and the same holds for the register's whole reason for existing (ADR-0038 named it as dead) | `apps/api/src/review-queue.ts`, `apps/api/src/review-store.ts` | Fixed 2026-11-20 — a real review queue (ADR-0039): the cases are chain-derived (a trial `judging` or `challenged`), the reviewer's own state is durable (`review_claims`, `review_abstentions`, migration 0019), a reviewer with a recorded conflict is **barred** from the case rather than warned about it, and taking/stepping away/declaring are three entries in the durable audit chain. The conflict register and the audit chain now have a consumer |
| REVIEW-D2 | MEDIUM | The review queue page fetched the queue once, at mount, and never read it again: the actions were fired, the API did the work, and the screen kept showing the state from before the click. A reviewer who took a case watched the button stay on "Working…" and could not tell whether the platform had taken the case or refused it | `apps/web/src/app/reviews/page.tsx` | Fixed 2026-11-20 — the page reads the queue with the actions' refresh token, so every action re-reads the state from the API; the browser proof asserts the page says "You hold this case" after the click |
| AUDIT-D2 | MEDIUM | An audit entry's id was derived from the action alone (`audit-review-claim-<trial>-<reviewer>`), while the chain is append-only with a unique id: the **second** claim of the same case by the same reviewer collided with the first and the API answered **HTTP 500**. The refusal was a database error rather than a sentence, and the reviewer could not tell what had happened | `apps/api/src/review-routes.ts` | Fixed 2026-11-20 — every audit entry gets its own id (the chain records events, not intentions), and a reviewer who already holds a case is refused with `already-yours` and a reason |
| AUTHZ-D2 | HIGH | The organisation API keys lived in process memory, so **a revoked key came back**: the revocation was a field in a `globalThis` map, the process restarted (a deploy, a crash, an Octane worker recycling), and the key was valid again — at exactly the moment somebody asks whether the old key really stopped working. The hash was also a fast, unsalted one-way function of the secret (`HMAC-SHA256(key = secret, msg = "")`): a stolen table of digests is a gift to a GPU, and no two keys shared a salt. And **nothing authenticated with a key at all** — `validateApiKey` had no caller outside its own tests | `packages/agent-security/src/org-api-key.ts` | Fixed 2026-11-20 (ADR-0040) — the keys are durable (`org_api_keys`, migration 0020), the revocation survives a restart, and the API is asynchronous throughout because a write that cannot be awaited cannot be durable. The hash is now **scrypt with a per-key salt** in a self-describing format, and the durable store says the same things the in-memory store says, in the same words. **Still open, and named:** there is no server-side pepper, so an attacker with the table still attacks the secret alone. **Narrowed 2026-11-20 (ADR-0041):** a key now AUTHENTICATES — it reads its own organisation and nothing else, and it writes nothing — so the door exists; what is still missing is WIDTH (the sponsor's ledger, the trials and the disputes are still wallet-only) and a rate limit on an endpoint that spends ~80 ms verifying a secret |
| CODE-M1 | MEDIUM | `@crucible/datasets` is imported by nothing: a second split engine (per 1000 buckets) beside the one in use (`@crucible/eval`, per 100) | `packages/datasets/` | Open — deleting a package is not this session's call; delete it, or make it the canonical engine and move `@crucible/eval` onto it |
| RUN-L* | LOW | API lacks graceful shutdown/rejection handlers; API binds all interfaces (demo intent); migration-runner "in a transaction" comment false; fork-host children on 0.0.0.0; VPS IP committed; `.env.mainnet.example` gitignored | various | Open |

| VERDICT-1 | — | "Verdict integrity is inviolable: owning tokens or staking must never improve a benchmark score or influence Argus's verdicts" | design | Holds: Verdicts derive only from evidence + Argus votes + chain state; staking/Engram ownership never feeds score inputs. Recorded in the taste ledger (confidence 0.9); this register does not claim an exploit there because none exists in the audited surfaces. |

- `56cb6fa` — sponsor-gated transitions authorized against the request body instead of the
  session (`body.sponsor`); fixed and mutation-proven, recorded in HARDENING.md.
- `5eb5242` — campaign eligibility signals were client-attested (`walletAge`/`trialCount`/
  `reputation` from the body); now derived server-side, fail-closed without a provider,
  passport signal wired; mutation-proven.