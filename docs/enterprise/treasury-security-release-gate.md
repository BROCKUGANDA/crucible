# Treasury security, revenue routing and mainnet release gate

**Status:** Proposed engineering workstream — documentation only  
**Target:** Crucible legacy native-ETH escrow and its production release process  
**Branch:** `work/treasury-security-release-gate`  
**Decision:** No real-value public launch until every blocking gate in this document and `docs/runbooks/mainnet.md` is satisfied.

This document does not claim that treasury controls, Safe deployment, monitoring, reconciliation, audits or mainnet readiness have been implemented. It defines the work and the evidence required to prove them.

## 1. Non-negotiable protocol invariants

The work must preserve the existing product and its accepted architecture:

1. The legacy `CrucibleTrials` payment asset remains native ETH.
2. Legacy `FEE_BPS = 500` (5%) remains unchanged and is deducted from the agent's payout on a paid outcome.
3. Settlement remains pull-based. Settlement credits balances; it does not push ETH.
4. `withdraw()` pays only `msg.sender`, using that address's on-chain `credit`. A treasury Safe must therefore be the configured treasury address and must itself execute `withdraw()` to receive its credit.
5. The API, indexer, web application, runner, grader and keeper must never hold or receive a treasury private key or seed phrase.
6. The escrow conservation invariant remains exact:
   `address(trials).balance == totalStakes + totalPending + escrowed`.
7. `finalize` and `reclaimExpired` remain permissionless. No privileged settlement key or new settlement role is introduced.
8. No change to fee basis, rate, rounding, bond, skeptic stake, reward caps, escrow cap or payout allocation is included.
9. The v2 Arena's 15% sponsor-side fee remains separate and dormant. It must not be displayed or represented as the live legacy fee.
10. Solana/native-SOL is out of scope for this release gate. The current Solana program is not a shipped native-SOL payment path.

Any proposal that violates one of these invariants requires a separate ADR, contract review and explicit approval.

## 2. Treasury custody model

### 2.1 Recommended structure

Use a company-controlled Safe multisig as the treasury recipient. A 2-of-3 signer policy is a proposed starting point, not a value to silently deploy. The company must select the actual signers, threshold, recovery procedure and jurisdictional custody arrangements before production.

Separate these responsibilities:

| Role | Responsibility | Must not have |
|---|---|---|
| Treasury Safe | Receives protocol credits and executes treasury withdrawals | API credentials or hot server key |
| Signer A | Hardware-backed Safe transaction approval | Shared seed phrase |
| Signer B | Independent hardware-backed approval | Shared seed phrase |
| Signer C | Recovery/third approval under the approved policy | Routine unilateral withdrawal power |
| Deployer / configuration Safe | Performs approved deployment and configuration transactions | A single-person hot key |
| Keeper | Pays gas for permissionless maintenance calls | Treasury signing authority |
| API / indexer / web / grader | Reads chain state and presents evidence | Any treasury private key |
| Argus seats | Sign dispute votes using their own keys | Treasury authority |

Do not reuse a personal everyday wallet as the company treasury. Do not publish a personal wallet address as the business treasury. A public-chain treasury address and its transactions are visible; custody security comes from controlling the signing threshold, not from hiding the address.

### 2.2 Exact recipient semantics

The current contract's `withdraw()` implementation is:

- Read `credit[msg.sender]`.
- Revert if the credit is zero.
- Zero the caller's credit and decrement `totalPending`.
- Send ETH to `msg.sender`.
- Revert the whole transaction if the transfer fails.

Therefore:

- The treasury Safe address must be the address stored as the contract's treasury recipient at deployment.
- Treasury credits accrue to that exact address.
- A Safe transaction must call `withdraw()` on the escrow contract.
- The Safe receives ETH because the Safe is `msg.sender`.
- There is no arbitrary withdrawal destination parameter in this flow. Do not build a misleading UI that implies the operator can redirect a treasury credit to a different address.
- If the treasury constructor address is wrong, do not assume it can be corrected later. The current deployment model does not expose a treasury migration shortcut. Stop and use a separately reviewed migration/redeployment plan.

## 3. Deployment-time treasury binding

Before deploying a production escrow:

1. Create the company Safe on the exact target chain.
2. Verify the Safe address from the Safe interface and independently from the chain.
3. Verify chain ID, owners, threshold, signer control and recovery process.
4. Obtain a second-person review of the address from an independently trusted channel.
5. Record the approved address and chain ID in the deployment evidence package. Never store a seed phrase or private key in this package.
6. Pass the exact approved Safe address as `treasury_` to the `CrucibleTrials` constructor.
7. Record the deployment transaction, contract address, constructor arguments, deployment commit, compiler settings and verified source metadata.
8. Read the deployed treasury configuration back from the chain and compare it byte-for-byte / address-for-address with the approved deployment manifest.
9. Abort if any mismatch exists. Do not "fix" a mismatch by editing a dashboard label.

The manifest should contain public identifiers only:

```json
{
  "chainId": null,
  "treasurySafe": "",
  "escrowAddress": "",
  "deploymentCommit": "",
  "deploymentTx": "",
  "verifiedSourceUrl": "",
  "reviewedBy": [],
  "signed": false
}
```

Null and empty values are deliberate placeholders, not successful configuration. Do not fill them with guessed values.

## 4. Revenue routing and accounting

### 4.1 Source of truth

The contract and its emitted settlement/withdrawal events are authoritative. Do not calculate a revenue figure from a hard-coded TypeScript fee constant.

For the legacy escrow:

- Paid verdict: treasury fee is the actual fee implied by the on-chain settlement result; agent receives the remaining reward and the bond is returned according to the contract.
- Winning skeptic: the contract's specified skeptic/treasury split applies.
- Slashed verdict: the sponsor is refunded the reward; the contract's bond distribution applies; no ordinary paid-outcome fee should be invented.
- Refunded verdict: sponsor refund and bond return follow the contract; do not book a protocol fee where none was charged.
- Withdrawal: reduce the treasury's on-chain pending credit and record the actual ETH received by the Safe.

Use actual event values and transaction receipts. If an event is missing, malformed, duplicated or cannot be reconciled, report the amount as unknown and raise an alert. Unknown must never be rendered as zero.

### 4.2 Double-entry projection

Implement an off-chain accounting projection only as a read model. It must not become a second authority for balances or payout rights.

Each ledger entry should include:

- chain ID;
- escrow contract address;
- block number and block hash;
- transaction hash and log index;
- trial ID, where applicable;
- event type and verdict;
- from/to account classification;
- amount in integer wei (never floating point);
- canonicality/finality status;
- indexer observation timestamp;
- idempotency key derived from chain ID + transaction hash + log index;
- reconciliation status and discrepancy reference.

The projection must be rebuildable from canonical chain history. No manually editable balance field is allowed. Corrections are compensating entries tied to the source event; never overwrite historical records.

### 4.3 Reconciliation

At a configurable block cadence, reconcile:

1. Contract ETH balance against `totalStakes + totalPending + escrowed`.
2. Per-recipient pending credits against the contract's `credit(address)` view.
3. Treasury pending credit against treasury-related settlement events minus successful treasury withdrawals.
4. Actual Safe ETH balance changes against successful `Withdrawn` events, allowing for unrelated incoming/outgoing Safe activity to be separately classified.
5. Event-derived accounting against the indexer's canonical projection.

A mismatch is a hard alert and blocks new trial intake. Do not block permissionless user exits, `finalize` or `reclaimExpired`. Do not automatically "repair" on-chain balances.

## 5. Withdrawal workflow

The treasury dashboard must distinguish:

- accrued treasury credit in the escrow contract;
- proposed withdrawal transaction;
- Safe approval state;
- executed withdrawal;
- confirmed ETH received by the Safe;
- reconciled amount.

Workflow:

1. Read treasury address and credit directly from the configured chain.
2. Confirm that connected Safe equals the treasury address.
3. Build a Safe transaction calling only the escrow's `withdraw()` function.
4. Decode and display target contract, chain, function, Safe identity and expected amount before signing.
5. Require the configured Safe threshold.
6. After execution, verify receipt status, `Withdrawn` event, sender/recipient and amount.
7. Re-read on-chain credit and verify it is zero or equals the remaining expected credit.
8. Reconcile the Safe balance movement and record the transaction evidence.

Never collect a seed phrase. Never request a signer private key. Never sign a treasury withdrawal server-side. Never present a queued Safe transaction as completed. A failed or reverted transaction must remain visibly failed and retryable only after diagnosis.

## 6. Treasury and protocol security controls

### Required controls

- Multisig signer threshold and recovery process documented and rehearsed.
- Hardware-backed signer keys; no seed phrase in browser storage, application storage, source control, CI variables, analytics, crash reports or logs.
- Deployment and treasury address verified independently by two reviewers.
- No contract owner/treasury changes without a separately reviewed and timelocked governance path, if such a path exists.
- Immutable contracts described as immutable; do not invent an upgrade or emergency-pause capability.
- Off-chain intake kill switch blocks creation of new trials only. It must not disable withdrawals, finalization, refunds or expiry recovery.
- API authentication, authorization and rate limits for administrative operations.
- Explicit separation between read-only monitoring credentials and transaction-signing authority.
- Alerting for unexpected treasury configuration, unusual credits, withdrawals, Safe owner/threshold changes, chain stalls, reorgs and conservation failures.
- Incident runbook with named human on-call, escalation channel and recovery steps.
- Regular Safe signer recovery exercise and backup restore test.

### Do not build

- A server-side hot wallet for treasury withdrawals.
- A private key or seed phrase field in the web application.
- A public "send to any address" treasury withdrawal shortcut.
- A mutable dashboard-only treasury address that disagrees with the deployed contract.
- A fee estimate presented as a chain-measured fee.
- An automatic treasury sweep that bypasses the Safe approval threshold.
- An emergency pause that traps already escrowed user funds.
- A "hide wallet" or anonymity feature. Public-chain activity is public.

## 7. Monitoring and incident response

Minimum monitors:

| Monitor | Trigger | Required response |
|---|---|---|
| Conservation invariant | Any exact-equality mismatch | Stop new trial intake; page on-call; preserve evidence |
| Treasury configuration | Read value differs from approved manifest | Stop launch/intake; investigate deployment |
| Treasury credit reconciliation | Event-derived and contract credit differ | Mark accounting unhealthy; investigate canonical chain history |
| Withdrawal verification | Missing event, wrong recipient, failed receipt or amount mismatch | Mark withdrawal failed/unreconciled; do not retry blindly |
| Chain/indexer health | Reorg, lag, sync error, stalled head | Mark projections stale; do not publish stale numbers as current |
| Settlement lag | Trial past expected settlement window | Alert operator; preserve permissionless settlement |
| Safe configuration | Owner or threshold change | High-severity alert and independent verification |
| Keeper / warden | Heartbeat missing | Alert; do not grant keeper treasury permissions |
| RPC integrity | Chain ID, head or archive history mismatch | Fail closed for money-sensitive operations |
| Intake kill switch | Enabled | Refuse new trial creation; preserve all existing exits |

The current indexer is in-memory and does not implement EVM reorg rollback. Production release must not treat a process-local cursor as durable canonical accounting. A durable, reorg-aware indexer/storage design needs its own ADR because ADR-0008 currently chooses an in-memory indexer. Until that architecture change is reviewed and implemented, the revenue dashboard must be explicitly labelled non-authoritative and must not be used as the sole accounting record.

## 8. API and UI contract

All money values are integer wei internally. Convert to decimal ETH only at the presentation boundary using the existing exact integer/string formatting conventions.

Suggested read-only endpoints (names are proposals; reconcile with existing route conventions before implementation):

- `GET /v1/treasury/status`: chain ID, escrow address, configured treasury, connected/approved Safe match, RPC health, indexer health, last reconciled block, status.
- `GET /v1/treasury/credit`: on-chain treasury credit, block number/hash, read timestamp, freshness and source.
- `GET /v1/treasury/ledger`: paginated canonical event projection with transaction/log identifiers and reorg status.
- `GET /v1/treasury/withdrawals`: Safe transaction lifecycle and confirmed withdrawal receipts.
- `GET /v1/treasury/reconciliation`: invariant and ledger reconciliation results, discrepancy IDs and last successful block.

No endpoint may return a private key, seed phrase, signing payload that can be silently executed, or a fabricated balance. All endpoints must distinguish `0`, `unknown`, `stale`, `unavailable` and `reorg_pending`.

UI states:

- **Verified:** contract treasury equals approved Safe; chain and evidence current.
- **Mismatch:** addresses differ; disable new trial intake and withdrawals through the app.
- **Unknown:** RPC/configuration unavailable; show em dash, never zero.
- **Stale:** indexer behind or reorg unresolved; label data stale and suppress current-balance claims.
- **Pending approval:** Safe transaction proposed but not executed.
- **Executed / awaiting confirmation:** receipt exists but confirmation policy not met.
- **Confirmed / reconciled:** on-chain event and Safe receipt match.
- **Failed:** transaction reverted or evidence mismatch; show transaction and diagnosis.

The visual system should remain Crucible's industrial forge: graphite/charcoal foundation, forged steel surfaces, restrained copper/ember accents, engraved technical labels, precise numeric typography and clear state hierarchy. Security warnings must be plain language, not decorative effects. No casino styling, fake balances, animated profit claims or obscured transaction details.

## 9. Test and mutation plan

All new gates must be proven capable of failing. Tests must cover both the intended refusal and the success path.

### Contract / integration tests

- Treasury address zero rejected at deployment.
- Treasury Safe receives credit only at the exact configured address.
- An unrelated EOA cannot withdraw the treasury's credit.
- The treasury Safe can call `withdraw()` and receives exactly its own credit.
- Failed recipient transfer reverts and restores the ledger state.
- Repeated withdrawal with zero credit reverts.
- Paid, slashed and refunded paths produce the contract-specified credits; no fee is invented for non-fee outcomes.
- Conservation invariant holds across settlement and withdrawal.
- No settlement path pushes ETH.
- Existing contract tests and invariants remain unchanged and green.

### Off-chain / API tests

- No treasury private-key configuration is accepted or read.
- Wrong chain ID, escrow address or treasury address fails closed.
- RPC timeout and archive-node failure produce unknown/unavailable, not zero.
- Duplicate log ingestion is idempotent.
- Reorg removes/reverses non-canonical projections through explicit rollback/replay semantics.
- Missing logs, gaps, malformed events and inconsistent receipts raise discrepancies.
- Integer wei arithmetic has no float conversion.
- Stale indexer never claims a current reconciled balance.
- A Safe proposal is not shown as executed.
- An executed but unconfirmed transaction is not shown as reconciled.
- A reverted withdrawal does not decrement off-chain expected credit.
- API cannot initiate or sign a withdrawal.

### Browser / end-to-end tests

- Connect a non-treasury wallet: treasury withdrawal action is unavailable.
- Connect the approved Safe: show the exact target and function.
- Submit Safe proposal: show pending threshold approvals.
- Execute Safe transaction on test chain: verify event and receipt.
- Verify credit decreases and Safe receives the amount.
- Simulate wrong Safe, stale RPC, stale indexer, failed transaction and reorg states.
- Confirm no secrets appear in browser storage, network responses, telemetry or logs.

### Mutation checks

Explicitly mutate or inject each condition and prove the corresponding test goes red:

- treasury address mismatch;
- chain ID mismatch;
- omitted or duplicated event;
- wrong event amount;
- wrong recipient;
- non-canonical block;
- stale cursor;
- failed transfer;
- fake Safe completion state;
- float conversion;
- API signing-key configuration.

Report each mutation as **killed**, **survived** or **not run**. A green suite without mutation evidence does not close the gate.

## 10. Release gates

The existing `docs/runbooks/mainnet.md` remains authoritative. This work adds evidence; it does not bypass or weaken G-800 through G-804.

| Gate | Required evidence | Blocking? |
|---|---|---|
| T-01 Treasury identity | Approved Safe, chain ID, owners, threshold, independent address review | Yes |
| T-02 Deployment binding | Constructor address equals approved Safe; deployed read-back evidence | Yes |
| T-03 Withdrawal proof | Safe executes `withdraw()`; receipt, event and received ETH independently verified | Yes |
| T-04 Accounting | Canonical event ledger, reconciliation and invariant monitoring | Yes |
| T-05 Reorg safety | Durable reorg-aware indexing design and replay tests, with ADR | Yes |
| T-06 Key isolation | Evidence no API, frontend, CI or worker has treasury signing material | Yes |
| T-07 Incident readiness | Named on-call, alert channel, intake kill-switch rehearsal, signer recovery | Yes |
| T-08 Independent audit | External audit at exact frozen deploy commit; findings resolved | Yes |
| T-09 Legal and operations | Entity, counsel, terms, privacy and applicable licensing sign-offs | Yes |
| T-10 Progressive exposure | Named genesis cohort and non-zero epoch cap approved; staged increases | Yes |
| T-11 Mainnet preflight | Existing `node scripts/mainnet-preflight.mjs` exits 0 | Yes |
| T-12 Final rehearsal | Fork rehearsal and full trial lifecycle, including all-party pull withdrawals | Yes |

A gate is not complete because a file exists. It is complete only when the referenced evidence is real, independently verifiable and tied to the exact deployment commit.

## 11. Implementation sequence

Execute as controlled, reviewable slices. Do not combine contract changes, indexer architecture changes, treasury UI and deployment in one large patch.

1. **T0 — Evidence inventory:** inspect current contract ABI, events, API routes, indexer, Safe integration options, CI and runbook. Produce a path-accurate implementation map. No runtime edits.
2. **T1 — Treasury manifest and validation:** define the public deployment manifest schema and validation tool; reject missing/zero/mismatched values. No real address is committed until supplied and reviewed.
3. **T2 — Read-only treasury status:** read configured treasury, on-chain credit and chain health. Preserve API no-key architecture.
4. **T3 — Event accounting projection:** define canonical event model and idempotency. First produce an ADR for durable reorg-aware indexing because current ADR-0008 conflicts with that requirement.
5. **T4 — Safe withdrawal proposal flow:** use Safe's transaction proposal/approval model; no server-side signing. Verify actual Safe integration and supported chain before implementation.
6. **T5 — Reconciliation and monitoring:** implement invariant, credit, withdrawal, reorg and stale-data alerts.
7. **T6 — Browser E2E and mutation proof:** test mismatch, stale, failed, reorg and successful Safe withdrawal states at the actual application URL.
8. **T7 — Mainnet evidence pack:** complete the existing audit, legal, multisig/timelock, monitoring and genesis sign-offs. Run existing preflight and fork rehearsal.
9. **T8 — Controlled pilot:** after all release gates pass, launch only to named participants with an approved epoch cap. Increase caps only after clean epochs and review.

## 12. Stop conditions

Stop immediately and do not merge/deploy if:

- Treasury address or chain ID is unknown or mismatched.
- A private key or seed phrase is found in application code, CI, logs or runtime configuration.
- A treasury withdrawal can be executed without the approved Safe threshold.
- A Safe proposal is represented as completed before execution.
- A balance or fee is estimated and displayed as measured.
- Any conservation invariant fails.
- A reorg can leave a false settled balance in the authoritative projection.
- A contract change is needed but no ADR and independent review exist.
- A required audit, legal, monitoring or genesis sign-off is unsigned.
- The mainnet preflight is red.
- The requested change would deploy, merge into `develop`, or alter existing fee/payout semantics without explicit approval.

## 13. Acceptance report format

Every implementation slice must report:

- exact commit and changed paths;
- commands run and exit codes;
- tests added and test results;
- mutation cases killed/survived/not run;
- browser URL and verified states, if UI changed;
- chain, contract and Safe identifiers, where applicable;
- outstanding risks and blocked gates;
- explicit statement: **not deployed** unless a separately approved deployment actually occurred.

## 14. Current known blockers at specification time

The repository's mainnet runbook currently states that preflight is intentionally red while audit, legal, genesis, timelock and monitoring sign-offs remain unsigned and no production `MAINNET_RPC_URL` is configured. The repository also documents an in-memory indexer without reorg rollback. Those are real blockers, not checkboxes to mark complete by documentation alone.

This specification does not change those statuses. It creates a controlled path to close them with evidence.
