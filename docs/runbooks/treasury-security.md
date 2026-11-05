# Treasury security and revenue operations

**Status:** proposed operating procedure. Do not use this as evidence that a production Safe has been created or that the mainnet gate has passed.

This runbook governs the company treasury for Crucible's native-ETH escrow. It does not make public-chain activity private and it does not introduce server custody.

## 1. Operating facts

- Current public website: local Anvil demonstration; no real-value funds.
- Current shipped settlement: EVM / native ETH.
- Legacy treasury: immutable constructor address on `CrucibleTrials`.
- Legacy payment path: `credit[address]` pull ledger; that address calls `withdraw()` and receives its own credit.
- API: read-only, no chain private key.
- Solana: not a shipped native-SOL escrow. Do not send SOL to an EVM address or treat a wallet connector as a payment implementation.

A public chain reveals the treasury contract address, treasury Safe address, balances, state and transfers. The protection here is signer control and least privilege, not address secrecy.

## 2. Before creating the Safe

1. Confirm the legal entity and the person accountable for treasury operations.
2. Select three independent signers for a 2-of-3 pilot Safe, or document and approve a different threshold.
3. Each signer creates a dedicated hardware-backed signing address. Do not reuse the same seed phrase across signers. Do not store all devices in one place.
4. Verify each signer address with an out-of-band signed message and a second communication channel.
5. Establish an emergency contact tree and a recovery plan for one lost signer, two lost signers, suspected compromise and signer departure.
6. Agree the policy for proposals, review, approval, execution, transaction simulation and reconciliation.

Never collect seed phrases or private keys from signers. The operator records public owner addresses only.

## 3. Create and verify the Treasury Safe

1. Use the official Safe application and supported deployment process for the exact network selected by the release decision.
2. Create a dedicated company Treasury Safe. Do not use the founder's personal everyday wallet as the escrow's fee recipient.
3. Set a threshold greater than one and lower than the owner count. The proposed pilot default is 2-of-3.
4. Keep modules, guards, fallback handlers and enabled extensions disabled unless independently reviewed and explicitly approved.
5. Record the network, chain ID, Safe address, canonical Safe version/deployment, owners, threshold, extension configuration, creation transaction, block number and recovery procedure in the treasury sign-off record.
6. Independently verify the Safe implementation/proxy against the canonical Safe deployment for that chain. Checking that an address has code and exposes `getThreshold()` / `getOwners()` is necessary but is not, by itself, proof that the contract is an authentic Safe deployment.
7. Read `getThreshold()` and `getOwners()` from the deployed Safe. Compare the exact owner set and threshold with the approved sign-off record.
8. Have at least two signers verify the Safe address in the official Safe interface and retain the verification evidence.

The Safe's address is public by design. Do not publish signer recovery material or private keys.

## 4. Create and verify the Owner Safe

The legacy contract sets `owner = msg.sender` in its constructor and exposes no ownership-transfer function in the current source.

Therefore:
- Do not deploy from an EOA and assume the owner can later be transferred.
- The deployment design must cause the Safe itself to be the constructor caller, using a reviewed and tested Safe execution-context deployment method; or a separately audited contract revision must explicitly support an owner address.
- After deployment, read `owner()` from the actual contract and compare it with the approved Owner Safe address.
- The Owner Safe must not be a keeper, agent, runner or API wallet.

The Owner Safe can wire optional reputation and identity registries. It cannot redirect the immutable treasury or withdraw user escrow. Keep this role distinct from the Treasury Safe where practical.

## 5. Deploy the escrow with the approved treasury

Before broadcast, freeze the exact commit and deployment inputs.

For each enabled escrow:
- confirm chain ID and native asset;
- pass the approved Treasury Safe address as the constructor's treasury argument;
- record the deployed contract address and runtime bytecode hash;
- read `treasury()` from the chain after deployment;
- compare the value byte-for-byte (case-insensitive hexadecimal comparison) with the approved Safe address;
- verify deployed code exists at the escrow, registry and Safe addresses;
- verify `owner()` equals the approved Owner Safe;
- verify the exact fee schedule and other contract parameters against the applicable ADR.

For the legacy escrow, retain the 5% fee deducted from the agent's successful payout. Do not reinterpret the v2 Arena's 15% sponsor-side schedule as the legacy fee.

**Fail closed:** if the treasury or owner address is wrong, stop. Do not create trials, do not fund the contract, do not attempt a manual ledger correction and do not publish the deployment as production. The legacy treasury cannot be changed after deployment.

## 6. Prove the withdrawal path

Complete this sequence on a testnet or controlled fork before any mainnet funds are accepted:

1. Create a low-value test trial from a test sponsor.
2. Register and claim with a separate test agent; fund the bond.
3. Complete a deterministic passing run and settle it.
4. Read `credit(TREASURY_SAFE)` from the escrow. Confirm the value is non-zero and agrees with the settlement outcome.
5. Prepare a Safe transaction with target = escrow, value = 0 and calldata = `withdraw()`.
6. Have the required Safe threshold approve and execute it.
7. Verify the Safe address is the caller in the escrow's `Withdrawn` event, and that the Safe's native ETH balance increased by the exact withdrawal amount. Account for transaction gas separately; the escrowed withdrawal amount itself must match exactly.
8. Read `credit(TREASURY_SAFE)` again and confirm it is zero for that withdrawal.
9. Repeat for a treasury credit produced by a failed break and for the slash path; verify classification and amount.
10. Test a different address attempting to withdraw the Safe's credit. It must not be able to withdraw that credit.
11. Retest all conservation invariants and duplicate-settlement protections.

This is a transaction initiated and approved by Safe owners. There is no server private key and no automatic backend withdrawal.

## 7. Revenue ledger and reconciliation

Reconcile per chain and per escrow contract, using integer wei.

### Required balances

- `credit(TREASURY_SAFE)`: currently withdrawable treasury credit.
- `totalPending()`: total credits owed to all participants.
- `escrowed()`: funds locked in live trials.
- `totalStakes()`: free agent stakes.
- `address(escrow).balance`: actual escrow ETH balance.
- Safe native ETH balance: funds received by the treasury Safe.
- `Withdrawn` events: completed pull withdrawals.

For the legacy contract, the exact invariant is:

```text
escrow balance = totalStakes + totalPending + escrowed
```

The equality must hold exactly. A mismatch is a stop-the-line incident.

### Classification rules

Do not present the entire treasury credit as fee income.

- **Legacy Paid:** 5% of reward is credited to treasury; if a break failed, the failed skeptic stake is split between the agent and treasury.
- **Legacy Slashed:** the sponsor's reward is refunded; the winning skeptic receives 30% of the agent bond and the treasury receives the remaining 70% of that bond. This is a slash allocation, not the 5% protocol fee.
- **Legacy Refunded:** reward is returned to sponsor; bond treatment follows the contract's reclaim path. Do not invent a fee.
- **Arena:** separate 15% sponsor-side schedule; the fee is retained or refunded according to the Arena outcome rules recorded in ADR-0019. Never combine Arena and legacy rows.

Every dashboard amount must identify chain, escrow address, block range, asset, outcome and provenance. Unknown values render as unknown, not zero. Never infer a fee by multiplying the whole reward column by a constant.

### Daily close

1. Fetch canonical chain logs from the last reconciled block, with reorg-safe confirmations.
2. Rebuild settlement and withdrawal entries idempotently from event identity (chain ID, contract address, transaction hash, log index).
3. Read the live treasury credit and global escrow books from the RPC.
4. Compare the indexer's computed treasury liability with `credit(TREASURY_SAFE)`.
5. Compare withdrawals with `Withdrawn` logs and the Safe's observed ETH receipts.
6. Record discrepancies, RPC gaps, reorgs and the exact block height. Do not post a balancing journal entry until the root cause is known.
7. Escalate any mismatch or unexpected Safe configuration change to the named on-call and stop new trial intake.

An indexer restart must replay from chain history; do not treat its in-memory state as the authoritative money ledger.

## 8. Treasury transaction policy

Every Safe proposal must be reviewed against:
- target contract address and chain;
- decoded function and parameters;
- ETH value and token approvals (none expected in the native-ETH escrow path);
- transaction simulation result;
- whether the transaction changes owners, threshold, modules, guard, fallback handler or any contract role;
- expected post-state and how it will be independently verified.

Changes to Safe owners, threshold or extensions require out-of-band confirmation and a recorded approval. No signer should approve a transaction solely from a chat message, email link or unexplained push notification.

Routine treasury withdrawal should be limited to the Safe's own `withdraw()` call against the approved escrow. A proposed call to an unknown contract, arbitrary delegatecall, module enablement, owner change, threshold reduction or fallback-handler change is not a routine withdrawal.

## 9. Incident response

### Suspected signer compromise

1. Alert the other signers and named incident lead using the pre-agreed out-of-band channel.
2. Stop new trial intake at the application layer. Do not disable permissionless settlement or participant withdrawal exits.
3. Use the remaining uncompromised Safe owners to remove/replace the signer and rotate recovery arrangements, if quorum and the Safe configuration allow it.
4. Review pending Safe transactions, enabled modules, guards and recent transactions.
5. Notify counsel and any affected parties according to the incident policy.
6. Preserve chain evidence and record the incident in the hardening log.

### Wrong treasury at deployment

1. Do not fund the contract and do not accept new trials.
2. Do not try to modify the immutable treasury.
3. Freeze the deploy commit and deployment evidence.
4. Obtain a new deployment decision and review the effect on any existing liabilities.
5. Deploy a corrected contract only through the approved release process and fresh post-deploy assertions.

### Accounting or conservation mismatch

1. Stop new intake immediately.
2. Do not sweep, manually withdraw, or create compensating transfers to make the displayed numbers match.
3. Preserve the last good block, first bad block, RPC responses, log set and indexer cursor.
4. Reconcile canonical chain state and all participant credits.
5. Resume only after the root cause is fixed, independently verified and the mainnet release owner signs off.

### Treasury Safe suspected compromised

A compromised Safe is not repaired by changing the public UI or hiding the address. Follow the Safe incident procedure, preserve evidence, coordinate with counsel and the relevant security responders, and do not claim that existing on-chain transfers can be reversed.

## 10. Recurring controls

- Daily: treasury-credit reconciliation, escrow invariant, pending-withdrawal and unexpected-transaction review.
- Weekly: signer availability and pending proposal review.
- Monthly: owner/threshold/module/guard inventory, access review and recovery-contact validation.
- Quarterly: signer compromise exercise, lost-device recovery drill and independent review of treasury operations.
- Every release: re-run the deployment assertions, treasury Safe checks, contract audit gate and mainnet preflight.

## 11. Stop conditions

Do not accept real funds when any of the following is true:

- treasury or owner Safe address is missing, mismatched, or not independently verified;
- a contract was deployed with the wrong immutable treasury;
- owner Safe is not the actual constructor owner;
- any unreviewed Safe module or extension can execute transactions;
- a signer threshold is one, N-of-N, or does not match the signed policy;
- contract audit or legal sign-off is incomplete;
- the withdrawal rehearsal is not proven end-to-end;
- any settlement outcome does not reconcile;
- the conservation invariant is not exact;
- the mainnet preflight is red;
- named on-call coverage and monitoring are absent.

See also [ADR-0020](../adr/0020-company-treasury-safe-and-mainnet-release-gate.md) and [the mainnet launch runbook](mainnet.md).
