# ADR-0020: company treasury custody, immutable fee routing and mainnet release gates

- **Status:** proposed (2026-11-04; not implemented or accepted)
- **Decides:** the custody and operational model for Crucible's treasury, how protocol credits reach the company wallet, and what evidence must exist before real-value deployment.
- **Depends on:** ADR-0001 (native ETH work escrow), ADR-0003 (pull payments), ADR-0006 (wallet-signed API; no API chain key), ADR-0011 (separate v2 Arena economics), ADR-0019 (both fee schedules remain distinct), ADR-0021 (explicit owner constructor input).
- **Does not:** change a fee, alter settlement mathematics, add a token, add a bridge, add an arbitrary withdrawal recipient, add a contract pause, make wallet activity private, or authorize deployment.

## Context

The current live site is a local Anvil demonstration with no real-value funds. The mainnet runbook is explicitly **NOT READY** while audit, legal, genesis cohort, timelock and monitoring sign-offs remain unsigned and no production mainnet RPC is configured.

The legacy `CrucibleTrials` contract has two decisive properties:

1. `treasury` is an immutable constructor argument. The constructor rejects the zero address and there is no treasury setter. A wrong treasury address cannot be repaired by an owner transaction.
2. Settlement uses a pull ledger. `withdraw()` reads `credit[msg.sender]`, clears that caller's credit, and sends ETH back to `msg.sender`. It has no `to` argument. A caller cannot withdraw another address's credit or redirect it to a different address.

The original deployed contract sets `owner = msg.sender` in its constructor and has no ownership-transfer path. This branch introduces an explicit non-zero `owner_` constructor argument under ADR-0021, so the production deploy can assign the Owner Safe directly. That contract ABI change is not yet merged or independently audited; the older deployed bytecode remains unchanged.

The treasury and the owner are different authorities:

- **Treasury:** receives treasury credits and can withdraw only its own ledger credit.
- **Owner:** can set or unset the optional reputation bridge and identity registry. The owner cannot withdraw trial escrow or change the immutable treasury.
- **Keeper:** submits permissionless lifecycle transactions and must not hold treasury or owner authority.
- **Argus seats:** vote on disputes and must have separate signing keys.

The deployed treasury address and its transfers are public chain state. A Safe improves control of funds; it does not make its address, balance, credits, or transactions private.

## Proposed decision

### 1. Treasury destination

Use a dedicated company-controlled Safe Smart Account as the treasury address on the production EVM chain. Do not use the founder's everyday personal wallet as the protocol's fee recipient.

For the initial capped pilot, the proposed default is a 2-of-3 Safe, with three distinct owners using separate hardware-backed signing keys and independent recovery arrangements. The final signer set and threshold must be approved by the company and counsel. Do not use an N-of-N configuration. Do not put multiple signer keys on one device or seed phrase.

The Safe address is public and is expected to be public. The security objective is that no single compromised signer, API process, browser, keeper, or deployer can spend treasury funds.

Do not enable Safe modules, guards, fallback handlers, delegates or other extension paths unless each is inventoried, independently reviewed and explicitly approved. A Safe module may create an execution path outside the ordinary owner-signature threshold; "the owners are 2-of-3" is not a complete security claim while unreviewed modules exist.

### 2. Immutable routing

For every deployed escrow, the treasury constructor argument must equal the approved production Safe address:

- Legacy `CrucibleTrials`: its `treasury_` argument is the company treasury Safe.
- v2 `Arena`: its `treasury_` argument is the explicitly approved Arena treasury Safe, if and when Arena is included in a separately approved release.

The exact address must be verified from the deployed contract on the target chain after deployment. A signed configuration file is not a substitute for an on-chain read.

Because the destination is immutable, a mismatch is a **deployment failure**. Do not try to repair it with an owner key, database edit, UI override or event-indexer patch. Stop intake and do not accept real funds. A corrected deployment requires a reviewed deployment plan and independent confirmation of how any existing liabilities are handled.

### 3. Treasury withdrawal path

The approved Safe itself calls the escrow's existing `withdraw()` function through a Safe transaction:

```text
Safe owners approve
       |
       v
Safe executes target = CrucibleTrials, value = 0, calldata = withdraw()
       |
       v
CrucibleTrials reads credit[Safe]
       |
       v
CrucibleTrials sends that amount to msg.sender (= Safe)
       |
       v
Safe balance increases; Withdrawn(Safe, amount) is emitted
```

There is no server-held private key and no application-controlled arbitrary recipient. Do not add `withdrawTo(address)`, a privileged sweeper, a backend signer, or a treasury redirect function. Those would weaken the current pull-payment boundary and require a new contract ADR, tests and a fresh independent audit.

A dashboard may prepare a Safe transaction and display the actual on-chain credit. It must not silently execute or bypass the Safe threshold. The API remains read-only and holds no chain key.

### 4. Owner authority

The production owner must also be a company-controlled Safe (or another independently reviewed multisig). This requires solving the constructor-caller issue before deployment:

Adopt the explicit `owner_` constructor argument described by ADR-0021. The production deployment script requires `OWNER_SAFE_ADDRESS` to contain deployed contract code and passes it into the constructor. The mainnet preflight verifies the Safe configuration before deployment; post-deploy verification reads `owner()` and compares it with the approved Owner Safe.

Do not use a conventional EOA deployment and assume ownership can be transferred later. The previous contract ABI has no transfer function; already deployed instances remain governed by their original owner address. The revised constructor must pass the full Foundry suite and receive an independent audit at the exact release commit before it can be used with real funds.

Keep owner and treasury Safe roles separate where practical. The owner can rewire optional registries; it must not be a hot operational wallet. The deployer key must not remain a privileged owner after release.

### 5. Accounting and revenue classification

The accounting model must not call every treasury credit "fee revenue".

For the legacy escrow, separate at least:
- protocol fee earned on a Paid outcome: 5% of reward deducted from the agent payout;
- treasury share of a failed break stake;
- treasury share of a slashed agent bond;
- other protocol credits, if introduced by a later reviewed contract.

For the v2 Arena, keep its distinct 15% sponsor-side schedule and the outcome-specific refund rules recorded in ADR-0019. Do not combine it with the legacy 5% schedule.

Use exact integer wei values. The on-chain `credit(treasury)` value is the current withdrawable balance; `Withdrawn` events record completed withdrawals. Historical accounting must reconcile settlement events and contract reads. Do not infer revenue by multiplying all rewards by 5% or 15%, and do not treat a failed RPC read as zero.

The UI must distinguish:
- pending treasury credit (not yet withdrawn);
- cumulative treasury withdrawals;
- fee income;
- non-fee treasury receipts (forfeitures / slash allocations);
- network gas, which is not protocol revenue.

### 6. Public visibility and privacy boundary

The product must state plainly that public blockchains expose contract addresses, public balances, contract state and transactions. A Safe does not hide these facts. Do not promise anonymous or invisible payments.

Use a dedicated company Safe so that the founder's personal address is not the advertised business receiving address. Do not publish a private wallet's address in the frontend, docs or marketing unless it is deliberately designated as public. The treasury Safe itself will be discoverable through the public contract's `treasury()` getter and transaction history.

Never place a seed phrase, private key, recovery phrase, signer export, or wallet secret in Git, the browser bundle, a `NEXT_PUBLIC_*` variable, API configuration, logs, analytics or CI artifacts. The API, indexer, web application and keeper must not possess treasury signing authority.

## Release gates required before real-value use

All gates below are required. A green unit test does not replace a human sign-off; a human sign-off does not replace an on-chain assertion.

1. **Contract audit:** external audit of the exact deploy commit and the deployed escrow code. Every critical/high finding is closed or explicitly accepted by the named risk owner; post-audit contract changes restart audit scope.
2. **Treasury Safe verification:** Safe address, chain ID, canonical Safe deployment/version, owners, threshold, modules, guard, fallback handler and recovery procedure are recorded and independently checked.
3. **Owner Safe verification:** actual deployed `owner()` equals the approved owner Safe. The deployment method proves the Safe is the constructor caller; no unprivileged EOA retains owner authority.
4. **Immutable destination check:** actual `treasury()` for every enabled escrow equals the approved treasury address. Address mismatch or absent code fails closed.
5. **Withdrawal rehearsal:** a complete testnet lifecycle credits the treasury; a Safe transaction calls `withdraw()`; the Safe receives the exact credit (gas accounted separately); the transaction and event are independently verified.
6. **Outcome matrix:** Paid, Slashed, Refunded and every supported Arena outcome reconcile all participant credits, treasury credits and withdrawals with no double-credit, missing credit or invented fee.
7. **Ledger invariant:** every state transition preserves the exact escrow conservation invariant. A mismatch is a release blocker and incident, never a value to be manually balanced.
8. **Operational monitoring:** treasury-credit balance, withdrawal amount, unexpected Safe configuration changes, settlement lag, indexer sync errors, keeper/warden heartbeats and conservation are monitored with named on-call coverage.
9. **Legal and company readiness:** entity, counsel, terms, privacy notices, jurisdiction and product permissions are reviewed and signed.
10. **Progressive exposure:** start with a named genesis cohort and a low ETH epoch cap. Lowering a cap is immediate; raising it requires a clean epoch, documented review and the release approvals in the mainnet runbook.
11. **Mainnet preflight:** the preflight refuses unsigned or incomplete sign-offs, wrong chain, incorrect fees, wrong treasury, wrong owner, non-Safe treasury, missing contract code, invalid signer threshold, and unverified deployment bytecode.
12. **Founder release approval:** no production deployment, mainnet funding or cap increase occurs merely because this ADR or a pull request exists.

## Consequences

- Treasury credit reaches a public company-controlled Safe, not a personal hot wallet.
- No contract redirect or backend key is introduced.
- An incorrect immutable treasury is caught before the deployment accepts value.
- Treasury receipts are reconciled by outcome and type rather than misreported as a flat percentage.
- Mainnet deployment remains blocked until the code, signers, audit, legal package and operational evidence are real and independently verified.

## References

- [ADR-0003 — Pull payments](0003-pull-payments.md)
- [ADR-0006 — Wallet-signed API, no chain keys](0006-wallet-signed-api-no-chain-keys.md)
- [ADR-0019 — Both fee schedules remain legible](0019-both-fee-schedules-legible.md)
- [Mainnet launch runbook](../runbooks/mainnet.md)
- [Key inventory](../key-inventory.md)
- [Safe: getThreshold](https://docs.safe.global/reference-smart-account/owners/getThreshold)
- [Safe: getOwners](https://docs.safe.global/reference-smart-account/owners/getOwners)
- [Safe: setup recommendations](https://help.safe.global/articles/1038062742-what-safe-setup-should-i-use)
