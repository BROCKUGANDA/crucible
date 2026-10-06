# Slither triage

Findings from `slither .` on the contracts, and what was done about each. Run it with:

```bash
cd crucible-contracts && slither .
```

`slither.config.json` excludes four detectors wholesale. Each exclusion is justified
below. Everything else that fires is either fixed or explained here — nothing is
silenced.

## Fixed

### `reentrancy-no-eth` — verdict written after an external call

`_settleWin` and `_settleSlash` called `alloy.recordWin` / `recordSlash` and *then* wrote
`t.verdict`. Slither is right that this is effects-after-interactions.

It was not exploitable: `AlloyRegistry` is our own contract, it is `onlyForge`, and
`_settle` had already set `t.status = Settled` before either function ran. But the fix
costs nothing and means a future change to `AlloyRegistry` cannot quietly reopen it. The
verdict is now written before the call in both branches.

`withdraw` was already ordered correctly (`credit[msg.sender] = 0` before the call, plus
`nonReentrant`), and its "full revert restores the ledger entry" comment is load-bearing.

### `missing-zero-check` on `AlloyRegistry.setForge` — a real lockup bug

This one was an actual defect. `setForge` is a one-time setter, guarded by
`forge != address(0)`. An accidental `setForge(address(0))` would therefore consume the
only chance to wire the registry: `onlyForge` becomes permanently uncallable and no agent
can ever earn alloy again. It now reverts with `ZeroForge()` and emits `ForgeSet`.

### `events-access` on `AlloyRegistry.setForge`

Same function. The wiring of the only address that can mutate reputation is now
observable from the event log, which is what makes it auditable after the fact.

### `missing-zero-check` on the `treasury` constructor arg

A zero treasury routes every protocol fee and every burned slash to an address nobody
controls, irrecoverably — there is no setter. Now reverts with `ZeroTreasury()`.

### `missing-zero-check` on `setReputationBridge` — deliberately kept

Not fixed, on purpose. `address(0)` is a *meaningful* value here: it deliberately unwires
the bridge. An owner must be able to turn reputation off without a redeploy. The
remaining finding is annotated in the source saying so.

## Not bugs, explained

### `timestamp` — 7 findings

The entire state machine is time-based: run deadlines, skeptic windows, dispute
timeouts. This is the design, not an oversight. The exploitable form of this bug is a
validator's stake that depends on `block.timestamp`; nothing here mints reputation
without a bond and a stake, so a miner shifting a block by seconds cannot profit.

`forge coverage` is separately disabled because `via_ir = true` is required to compile —
see the README.

### `low-level-calls` — 3 findings

Deliberate, and the whole point of the ERC-8004 integration.

`_publishWin` and `_publishSlash` use a low-level call whose result is **ignored**. That
is the only way to make third-party infrastructure non-blocking: if the ERC-8004
registry reverts or is unavailable, a revert would roll back the payout and the verdict
would be stuck forever. A lost reputation signal can be backfilled through
`ReputationBridge.backfill`. A stuck verdict cannot be undone.

`withdraw` needs a low-level call to forward ETH, and checks `ok`.

### `redundant-statements` — 2 findings

Slither flags the ignored `ok` in both `_publish*` functions as redundant. It is the same
deliberate choice as above; assigning it to a named variable is what makes the intent
legible to the next reader and to this tool.

### `assembly` — 1 finding

`CrucibleTrials._split` parses an ECDSA signature in assembly. Hand-rolling this in
Solidity is not worth the gas and the stack pressure, and the malleability check
(`s <= secp256k1n/2`) plus the `v` recovery check are covered by tests.

### `uninitialized-local` — 2 findings, excluded

`AlloyRegistry._itoa` and `ReputationBridge._toString` declare `uint256 digits;`. Solidity
zero-initializes locals, so this is correct — the loop increments before reading, and both
are exercised by tests that assert the rendered string. Excluded because firing on every
zero-value local is noise that trains people to ignore the tool.

### `shadowing-local` — 2 findings, excluded

`IERC8004IdentityRegistry.register(string agentURI)` has a parameter named `agentURI` that
shadows the `agentURI(uint256)` function. Those are the names ERC-8004 specifies. Renaming
them to satisfy a linter would make the interface diverge from the standard it mirrors.

### `missing-inheritance` — 1 finding, excluded

`AlloyRegistry` does not formally inherit `IAlloyRegistry`. The interface exists in
`CrucibleTrials.sol` for the local type and is enforced by `CrucibleTrials`' own storage
layout; making `AlloyRegistry` inherit it would couple two contracts that are deliberately
deployable and replaceable independently. The call sites are checked by tests.

### `reentrancy-benign` / `reentrancy-events` — ReputationBridge

`ReputationBridge._publish` calls `giveFeedback` on the registry and then reads
`getLastIndex`. Both are calls *into* the registry, which is a third party we do not
control, and the value written afterwards is a cache of the registry's own state. A
registry that lied to us could lie about its own index. It cannot affect payout — that
happens entirely inside `CrucibleTrials` before the bridge is called.

## What this does not cover

Slither is static analysis over one snapshot of source. It is not a substitute for the 82
tests, the 6 invariant suites, or reading the diff. It is here to catch the class of
mistake that tests written by the same author in the same sitting would miss.