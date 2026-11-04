# Treasury security workstream: implementation contract

**Status:** implementation specification only. The repository change that introduces this document does not implement the code gates, create a Safe, deploy contracts, or authorize real-value use.

This workstream closes the treasury portion of Crucible's mainnet readiness. Implement it in small independently tested slices. Preserve the current contract money rules and the `AGENTS.md` branch/deploy rules.

## 1. Non-negotiable architecture

1. Native ETH remains the work-escrow asset; no ERC-20, stablecoin, bridge, wrapped asset or speculative token is introduced.
2. Legacy `FEE_BPS = 500` remains the 5% agent-payout deduction. The v2 Arena's 15% sponsor-side schedule remains distinct and dormant unless the Arena has its own reviewed deployment, indexer and UI.
3. The treasury is the company Safe address supplied to the contract constructor. The deployed contract's `treasury()` getter is the source of truth.
4. The company Safe calls `withdraw()` and receives its own credit. No arbitrary recipient, privileged sweep, backend signer or automatic custody path is added.
5. The existing pull-payment rule remains: settlement creates credits; recipients withdraw separately.
6. API, web server, indexer and keeper never store or receive the treasury's signing key. The web client may prepare Safe transactions but cannot bypass the Safe's owner threshold.
7. Public-chain transparency is stated in product copy. No claim that the Safe address, balances or transfers are private.
8. `CrucibleTrials.owner` is assigned to the constructor caller; the current contract has no ownership-transfer method. The deploy path must make the approved Owner Safe the actual constructor caller, or a new audited contract revision must explicitly solve ownership. Never assume a regular EOA deployer can hand ownership over later.
9. No money arithmetic uses floating point. Unknown is null, not zero.
10. No deploy, mainnet funding or promotion is part of this workstream without explicit founder release approval.

## 2. Implementation slices

### TS-01 — Treasury policy record and sign-off schema

Add a non-secret `docs/mainnet/treasury.json` template and schema validation. It may contain only public information:

- `signed` (false by default);
- `chainId` and `asset` (native ETH);
- enabled escrow contract addresses;
- treasury Safe address, Safe version, exact owners and threshold;
- Owner Safe address, Safe version, exact owners and threshold;
- verified module, guard and fallback-handler inventory;
- canonical Safe deployment evidence / source;
- recovery-plan reference;
- deployment commit, verification block and evidence hash;
- approving signers and approval date.

No private keys, seed phrases, recovery phrases, API tokens, personal identity documents or secrets may be committed.

Validation must reject empty/zero/malformed addresses, duplicate owners, threshold < 2, threshold > owner count, owner count < 3 for the proposed 2-of-3 profile, unsigned template, absent chain ID, missing audit evidence, stale commit and an unreviewed Safe extension. The signer set in the record must exactly match the on-chain Safe owner set.

### TS-02 — Mainnet preflight verifies actual on-chain treasury and owner

Extend `scripts/mainnet-preflight.mjs` and `packages/eval/test/mainnet-preflight.test.ts`.

The gate must:
- retain all existing unsigned sign-off, fee and chain-ID refusal tests;
- require the treasury sign-off record;
- require the exact enabled escrow addresses and expected treasury/owner Safe addresses;
- query chain ID using the configured primary/fallback RPC;
- verify code exists at the escrow, treasury Safe and Owner Safe;
- read `treasury()` from every enabled escrow and compare it to the exact approved Safe address;
- read `owner()` from each owner-controlled escrow and compare it to the approved Owner Safe address;
- read Safe `getThreshold()` and `getOwners()` and compare exact threshold and owner set with the approved record;
- independently verify the Safe proxy / singleton against canonical Safe deployment data for the selected chain; do not conclude authenticity from function selectors alone;
- fail closed on RPC errors, empty code, ABI decode failure, stale sign-off, mismatched address, duplicate owner, unreviewed module, invalid threshold or incomplete evidence;
- print only public addresses and diagnostic facts; never print secrets or full RPC URLs containing credentials.

The preflight must not deploy, sign, transfer, withdraw or move funds.

### TS-03 — Post-deploy assertions pin the expected addresses

Extend `crucible-contracts/scripts/assert-deployment.sh` without weakening its existing contract, economics, roles, registry and exact money-conservation checks.

Production invocation must provide an approved expected treasury address and expected owner address. The script must compare both to on-chain getters and fail if they differ. It must assert the Safe addresses have deployed code and that their on-chain owner/threshold state matches the approved public configuration. Demo/Anvil invocations must remain explicitly in demo mode and must not silently inherit production assumptions.

Add tests for:
- expected treasury matches;
- treasury mismatch;
- expected owner matches;
- owner mismatch;
- treasury zero/no code;
- EOA supplied as treasury;
- threshold 1;
- threshold greater than owner count;
- duplicate owner address;
- expected owner set differs from on-chain;
- missing expected values in production mode;
- RPC call revert / malformed result.

The script must never treat an unset expectation as "accept any address" in production mode.

### TS-04 — Constructor-owner deployment path

Audit all production deployment scripts and the exact CREATE/CREATE2 path.

Acceptance:
- On a fresh local chain, prove the actual `msg.sender` observed by `CrucibleTrials` constructor is the approved Owner Safe.
- Prove `owner()` returns that Safe after deployment.
- Prove the deployer EOA cannot call owner-only registry setters.
- Prove the Owner Safe can call the allowed setters.
- Prove neither Owner Safe nor deployer can withdraw another address's credits or redirect the immutable treasury.
- If Safe-context deployment cannot be achieved without an unsafe/unmaintainable delegatecall path, stop and propose a reviewed contract constructor revision with explicit `owner_`; do not quietly ship a factory with unaudited arbitrary delegatecall.

Do not add an ownership-transfer function without a separate contract-security review.

### TS-05 — Safe withdrawal E2E

Build an E2E fixture that uses a real Safe-compatible contract in local Anvil (no fake treasury transfer) and executes the full Safe transaction path.

Assertions:
- settlement credits `credit[treasurySafe]`;
- ordinary EOA cannot withdraw the Safe's credit;
- Safe owner approvals below threshold cannot execute;
- the threshold-approved Safe transaction calls `withdraw()`;
- `Withdrawn.to == treasurySafe`;
- Safe balance increases by exact withdrawn amount, with gas accounted separately;
- `credit[treasurySafe]` returns to zero for the withdrawn amount;
- escrow conservation remains exact;
- a failed external receive reverts without destroying the credit;
- a duplicate withdrawal cannot replay the same credit;
- withdrawal from another beneficiary's credit remains impossible.

The test may deploy a pinned Safe test implementation only if its exact source/version is part of the test dependencies and the production implementation is independently checked. Do not mock the Safe's signature threshold or execution path.

### TS-06 — Treasury accounting and reconciliation

Build an idempotent treasury ledger projection from chain events and canonical contract reads.

Identity for an ingested log: `chainId + contractAddress + transactionHash + logIndex`.

Track separate entry types:
- legacy protocol fee;
- legacy failed-break stake allocation;
- legacy agent-bond slash allocation;
- Arena fee (if Arena is enabled);
- Arena stake / seat-fee allocations and refunds;
- treasury withdrawal;
- reversal/reorg correction tied to the original log identity.

Do not aggregate non-fee treasury receipts into the fee KPI.

Reconcile:
- `credit(treasurySafe)` with the projected pending credit;
- `Withdrawn` logs with the projected withdrawals;
- contract balance with `totalStakes + totalPending + escrowed` for the legacy escrow;
- Arena's own conservation and credits separately;
- Safe receipts with withdrawal logs, accounting for gas only at the Safe transaction layer.

The current indexer is in-memory (ADR-0008). Rebuild from canonical history after restart and make event ingestion reorg-aware before promising a financial reconciliation SLA. Until that is implemented and proven, label the operator dashboard as provisional and do not use it as an accounting system of record.

### TS-07 — Operator-facing Treasury panel

Add a Treasury view consistent with the Crucible forge theme: dark graphite, steel surfaces, restrained copper/ember accents, precise type, clear statuses, no casino styling.

It must show:
- network and chain ID;
- escrow contract address and verified bytecode identity;
- Treasury Safe address, threshold and owner count;
- Safe configuration verification status;
- current treasury credit (withdrawable now);
- cumulative withdrawn amount;
- fee income separate from slash/forfeiture allocations;
- last reconciled block and confirmation depth;
- invariant state and last discrepancy;
- pending Safe withdrawal proposal and approval count;
- alerts and incidents.

All figures must include ETH units and provenance. Use exact decimal-string / bigint conversions; never pass money through `Number` or floating point. Unknown renders as `—`, never zero. No page, frontend bundle or analytics payload may contain signing keys.

Withdrawal UI:
- builds a Safe transaction to the approved escrow's `withdraw()`;
- displays target, chain, calldata decode, credit read and post-state expectation before approval;
- routes approvals through Safe;
- does not accept an arbitrary payout address;
- never marks a withdrawal successful before observing the transaction receipt and confirmed Safe balance change.

Access to an operator panel may be restricted, but restriction does not make chain data private. The public read API remains read-only.

### TS-08 — Monitoring, alerts and operations

Alert on:
- any mismatch between expected and on-chain treasury/owner;
- Safe owner, threshold, module, guard or fallback-handler change;
- treasury withdrawal above approved policy;
- unknown target or calldata in treasury proposals;
- conservation invariant mismatch;
- pending credit that remains unwithdrawn beyond the operational threshold;
- missing or duplicate withdrawal/log projection;
- indexer reorg / sync gap / block lag;
- absent keeper/warden heartbeat;
- RPC disagreement between primary and fallback.

Use idempotent alerts and bounded retry/backoff. A retry must never submit a second Safe transaction or duplicate a withdrawal. Do not put RPC API keys or webhook secrets in log messages.

### TS-09 — Mainnet release gates and progressive exposure

Before mainnet:
- audit exact contract commit;
- approve ADR-0020 and the treasury sign-off record;
- verify Safe deployments and owner sets;
- prove constructor-owner path;
- pass deployment assertions;
- pass Safe withdrawal E2E;
- run `npm run verify:all`, Foundry build/size/test/coverage gates, static analysis and all deployment-edge tests;
- run a mainnet fork rehearsal using archive RPC;
- complete legal review and monitoring/on-call sign-off;
- name the first sponsors and agents;
- set a low epoch cap in ETH;
- get an explicit founder release approval.

The mainnet preflight remains red until all human sign-offs are real. Never edit a template to `signed: true` merely to satisfy CI.

## 3. Required test matrix

| Area | Happy path | Negative / adversarial path |
|---|---|---|
| Treasury pinning | approved Safe equals `treasury()` | zero, EOA, wrong Safe, stale config |
| Owner pinning | approved Owner Safe equals `owner()` | EOA deployer remains owner; wrong Safe |
| Safe configuration | canonical proxy, threshold 2-of-3, exact owners | threshold 1, duplicate, stale owner, unknown module |
| Withdrawal | threshold-approved Safe withdrawal to self | below threshold, replay, third-party caller, receive revert |
| Accounting | all settlement rows reconcile | fee overstatement, slash counted as fee, duplicate log |
| Invariants | exact balance equality | extra/missing ETH, ledger mismatch |
| Operations | alerts on genuine discrepancy | noisy duplicates, retry duplicates, stale RPC |
| Privacy/secrets | public Safe address only | leaked key in bundle, logs, docs or API |
| E2E | testnet-equivalent complete lifecycle | wrong chain, wrong escrow, stale UI, rejected Safe proposal |

Every new guard must be mutation-tested. The report must say which checks were proven red by mutation and which remain unproven. A passing fixture that hardcodes the expected result is not sufficient.

## 4. Stop conditions

Stop and report a blocker rather than working around it when:
- the current deployment path cannot make the Safe the actual constructor owner;
- canonical Safe verification cannot be established for the target chain;
- an arbitrary recipient or privileged server signer appears necessary;
- the treasury address differs from the immutable deployed value;
- any settlement outcome cannot be exactly reconciled;
- a reorg can leave the read model overstating/understating a treasury credit;
- tests do not exercise real Safe threshold execution;
- a money/invariant gate is red;
- the external audit or legal approval is absent.

## 5. Completion evidence

The workstream is complete only when the PR includes:
1. Accepted ADR-0020.
2. Treasury sign-off schema and an unsigned production template.
3. Preflight checks proven to refuse each invalid case.
4. Post-deploy assertions proving treasury and owner addresses.
5. Safe-context owner deployment evidence.
6. E2E Safe withdrawal transaction and receipt on a controlled test chain.
7. Settlement-outcome reconciliation report with exact wei values.
8. Updated key inventory and operational runbook.
9. Fresh full verification output and mutation report.
10. Independent audit of the exact release commit and founder approval recorded separately.

Until all ten exist, Crucible remains in development / restricted beta and must not advertise production mainnet custody.
