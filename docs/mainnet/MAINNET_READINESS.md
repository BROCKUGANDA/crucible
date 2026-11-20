# Mainnet Readiness

## Status: NOT READY

Crucible is currently deployed on local Anvil (chain 31337). Mainnet deployment requires all gates A-J to pass.

## Gate A: Repository Integrity
- [x] Clean build — `npm run verify:all` passes
- [x] Typecheck — 0 errors across all workspaces
- [x] Tests — 1047 passing, 6 skipped
- [ ] Migration verification — PostgreSQL migrations tested against representative data
- [ ] No unresolved critical vulnerabilities — Trivy scan required

## Gate B: Authentication and Authorization
- [x] Public access verified — Public routes work without auth
- [ ] Tenant boundaries tested — Cross-tenant access tests needed
- [ ] Privileged operations protected — Admin role tests needed
- [ ] Session and CSRF checks — CSRF module implemented, not yet wired to routes
- [ ] API key scopes — No granular scoping implemented

## Gate C: Money Safety
- [x] Exact financial arithmetic — BigInt used for all ETH amounts
- [x] Contract invariants — Conservation invariant tested in Foundry
- [ ] Treasury verification — No multisig configured
- [ ] Escrow reconciliation — No reconciliation service
- [ ] Withdrawal rehearsal — No mainnet fork test
- [x] Settlement tests — Pull-based withdrawal tested
- [x] Correct fee configuration — FEE_BPS = 500 (5%)

## Gate D: Runtime Integrity
- [ ] Durable outbox — Forge Watch outbox incomplete (HIGH finding)
- [ ] Operational queue — BullMQ queues exist but outbox not transactional
- [ ] Genuine DLQ — Dead-letter queue not implemented
- [x] Worker recovery — Worker lifecycle module with lease recovery
- [ ] Telemetry delivery — End-to-end telemetry tests needed
- [x] Artifact integrity — Content hash verification implemented
- [ ] Replay functionality — Three-replay system scaffolded

## Gate E: Evaluation Integrity
- [x] Version-pinned methodology — Evaluation spec with JSON Schema
- [x] Evidence persistence — Artifact integrity verification
- [ ] Independent replays — Replay manifest system implemented, not coordinated
- [ ] Judge abstention — Argus scaffolded, incomplete
- [x] Reward/score isolation — assertNoFinancialData() enforced
- [ ] Public scorecard disclosures — Scorecard generation partial

## Gate F: Randomness and Disputes
- [ ] Production VRF integrated — Mode 0 only, Mode 1 not implemented
- [ ] No deterministic demo fallback — Mainnet blocks Mode 0 in chain-config.ts
- [ ] Callback verification — VRF not implemented
- [ ] Failure handling — VRF timeout/recovery not tested
- [ ] Replay protection — VRF duplicate fulfillment not tested
- [ ] Dispute and finalization tests — Commit/reveal in contracts, no UI

## Gate G: Infrastructure
- [ ] Production database — PostgreSQL configured, no production instance
- [ ] Redis and queues — Redis in compose, no production instance
- [ ] Object storage — R2 not configured
- [ ] Primary and fallback RPCs — Environment variables exist, not configured
- [ ] Secrets management — No secure signing system
- [ ] Monitoring — No metrics or alerts
- [ ] Backups — No backup or restoration tests
- [ ] Disaster recovery — No DR plan tested

## Gate H: Contract Deployment
- [ ] Final code review — Contracts tested but not independently audited
- [ ] Independent audit findings — Not audited
- [ ] Signed deployment manifest — No manifest
- [ ] Verified deployed bytecode — No production deployment
- [ ] Multisig governance — No multisig configured
- [ ] Correct addresses — No production addresses
- [ ] Correct configuration — No production config
- [ ] Verified transactions — No production transactions

## Gate I: Operational Readiness
- [ ] Incident runbooks — Partial (INCIDENT_RESPONSE.md at root)
- [ ] On-call ownership — No on-call process
- [ ] Rollback or containment — No rollback procedure
- [ ] Monitoring and alerting — No monitoring
- [ ] Support workflow — No support procedure
- [ ] Sponsor communication — No communication plan
- [ ] Pilot operating procedure — Pilot program documented, not tested

## Gate J: Mainnet Preflight
- [ ] All required release gates green — Gates A-I not passing
- [ ] Treasury verified — No treasury
- [ ] Withdrawals rehearsed — No rehearsal
- [ ] Books reconciled — No reconciliation
- [ ] Mainnet environment explicitly configured — CHAIN_ENV exists but not set to mainnet
- [ ] Deployment approval recorded — No approval
- [ ] Final preflight evidence archived — No evidence

## Release Blockers

1. **VRF Integration** — Chainlink VRF v2.5 required for mainnet randomness
2. **Chain Configuration** — CHAIN_ENV=mainnet not configured
3. **Treasury Controls** — No multisig, no key inventory
4. **Contract Audit** — Independent audit required
5. **Production Infrastructure** — No production database, RPC, or storage
6. **Outbox Pattern** — Transactional outbox not implemented
7. **Monitoring** — No metrics, alerts, or runbooks

## Chain Assumptions

- **EVM:** Anvil 31337 (local). Target mainnet unresolved from ADRs.
- **Solana:** Local validator only. No mainnet deployment.
