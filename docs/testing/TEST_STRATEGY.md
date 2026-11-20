# Test Strategy

**Last updated:** 2026-11-19

## Verification Commands

```bash
npm run verify:all          # typecheck + every workspace suite + edge suite
npm test                    # all workspaces + Foundry (2752 tests baseline)
npm run test:edge           # deploy/edge: RPC gate refusals, live probe
cd crucible-contracts && node ../scripts/run-forge.mjs test  # Foundry
node ../scripts/run-forge.mjs build --sizes                   # script/ compilation
```

## Gate Principles

1. **Mutation-prove every branch** — a green you cannot turn red is decoration
2. **Never re-run a red money gate** — invariant failure is correct behavior
3. **Assert end state, not just caller stopping** — container gone, row absent
4. **A wiring check must read the executed command, not file prose**
5. **Figure is read or not shown** — unknown renders `—`, never `0`

## Test Categories

### Unit Tests

| Area | File | Tests |
|------|------|-------|
| Suite registry | `apps/api/test/suites.test.ts` | 32 |
| Scoring engine | `apps/api/test/scoring.test.ts` | 38 |
| Trial lifecycle | `apps/api/test/trial-lifecycle.test.ts` | Existing |
| Score/reward isolation | `apps/api/test/scoring.test.ts` | Isolation tests |
| Statistical functions | `apps/api/test/scoring.test.ts` | Wilson, variance |

### Integration Tests

| Area | Description |
|------|-------------|
| PostgreSQL | RLS policies, transactions |
| Redis/BullMQ | Queue operations |
| Outbox delivery | Event persistence and delivery |
| Object storage | Artifact upload/download |
| RPC integration | Chain interactions |

### Evaluation Correctness

| Area | Description |
|------|-------------|
| Golden fixtures | Deterministic replay |
| Independent replay | Three-replay agreement |
| Judge disagreement | ABSTAIN handling |
| Score calculation | Multi-dimensional scoring |
| Confidence calculations | Wilson score intervals |
| Reward/score isolation | Financial data rejection |

### Security Tests

| Area | Description |
|------|-------------|
| Cross-tenant attacks | Tenant isolation verification |
| Authentication abuse | SIWE nonce enforcement |
| API key misuse | Scope verification |
| SSRF | Internal service protection |
| Sandbox escape | Container isolation |
| Replay attacks | Nonce replay protection |

### Contract Verification

| Area | Description |
|------|-------------|
| Unit tests | Per-contract functionality |
| Fuzz tests | Property-based testing |
| Invariant tests | Conservation invariant |
| Fork tests | Mainnet fork testing |
| Gas tests | Gas consumption |
| Access control | Role verification |

### End-to-End Tests

18-step workflow:
1. Public visitor discovers a trial
2. User registers an agent
3. Organization invites a team member
4. Sponsor creates a program
5. Sponsor funds an approved trial
6. Participant submits an agent
7. Evaluation executes
8. Telemetry is captured
9. Replays complete
10. Argus verifies evidence
11. Scorecard is produced
12. Dispute process is available
13. Verdict is finalized
14. Settlement becomes eligible
15. Authorized withdrawal succeeds
16. Indexer reconciles the transaction
17. Public result is published
18. Reputation record is updated

## Regression Protection

| Invariant | Test |
|-----------|------|
| Conservation | `invariant_balanceConservation` in Foundry |
| Trial lifecycle | State machine transitions for all 7 states |
| Settlement | Pull-based withdrawal; push payment paths must not exist |
| Fee | `FEE_BPS = 500` (5%) asserted; 15% must fail |
| Score/reward isolation | `assertNoFinancialData()` rejection tests |
| Mainnet preflight | Gate must be able to refuse |

## Test Coverage

| Package | Tests | Status |
|---------|-------|--------|
| @crucible/api | 866 | Passing |
| Foundry | 329 | Passing |
| Total | 2752 | Passing |
