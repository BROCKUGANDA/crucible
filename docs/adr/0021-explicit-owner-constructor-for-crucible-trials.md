# ADR-0021: explicit owner address for newly deployed CrucibleTrials

- **Status:** proposed (2026-11-04; implemented on the treasury feature branch, not merged or audited)
- **Decides:** how a new CrucibleTrials instance assigns its limited owner authority so a production deployment can use the approved company Owner Safe instead of permanently assigning the deployer EOA.
- **Depends on:** ADR-0003 (pull payments), ADR-0006 (no API chain key), ADR-0020 (company Treasury Safe and mainnet release gate).
- **Does not:** add ownership transfer, upgradeability, pause, a treasury setter, a withdrawal recipient, a privileged settler, or any new authority to move user funds.

## Context

The previous constructor was:

    constructor(address treasury_, address alloy_, address[] memory argus_)

It assigned owner = msg.sender. There is no ownership-transfer function. The owner can only set or unset the optional reputation bridge and identity registry; it cannot withdraw escrow, alter a trial, or change the immutable treasury. Nevertheless, an EOA deployer permanently held those registry setter privileges on every instance deployed through the ordinary script.

A production Treasury Safe can be passed as the immutable treasury address, but that does not automatically make the Safe the owner. Recording an Owner Safe in a config file cannot change the contract's owner() return value.

## Decision

New deployments use this constructor:

    constructor(
        address treasury_,
        address owner_,
        address alloy_,
        address[] memory argus_
    )

The constructor rejects both a zero treasury and a zero owner, stores the explicit owner_, and preserves all existing trial settlement, fee, stake, bond, Argus and pull-payment rules.

The production deployment script requires TREASURY_ADDRESS and OWNER_SAFE_ADDRESS. Each must contain deployed contract code before broadcast. It passes them as the first two constructor parameters. It has no production fallback to the deployer address. The local demo script passes its explicit Anvil deployer address as owner so the deterministic local demo remains self-contained.

The contract itself does not attempt to prove that an address is a Safe. The read-only mainnet preflight independently verifies:
- the approved Safe proxy and canonical singleton;
- runtime bytecode hashes;
- exact owner set and 2-of-3 threshold for the initial pilot;
- no enabled modules, guard, module guard or fallback handler;
- the configured Treasury Safe and Owner Safe environment values match the signed treasury record.

Post-deploy verification must read the actual treasury() and owner() getters and compare them with the approved addresses. A testnet withdrawal rehearsal must prove the Treasury Safe can call withdraw() and receive only its own pull-ledger credit.

## Security properties preserved

1. **No ownership transfer.** The owner is established at construction and cannot be silently rotated later. A wrong owner is a failed deployment, not a repair ticket.
2. **No treasury redirection.** The treasury is still a constructor address; no owner method changes it.
3. **No custody added to application servers.** The API, indexer, web server, keeper and runner do not receive the Safe keys.
4. **No arbitrary withdrawal.** withdraw() remains pull-based, has no destination parameter and sends the caller's own credit to the caller.
5. **No user-fund authority.** The owner retains only the two existing optional registry setter functions.
6. **No economics changes.** Legacy fee remains 500 bps / 5%, deducted from the agent payout. Arena's distinct 1500 bps schedule is unaffected.
7. **Existing deployments are untouched.** The new ABI affects only newly deployed contract instances. Funds and liabilities on an older instance must remain withdrawable under that instance's existing rules; no migration or sweeping is implied.

## Why not use a Safe-context factory?

A CREATE performed inside a normal factory constructor/call observes the factory as msg.sender. Making the Safe appear as constructor caller requires unusual Safe delegatecall execution and a carefully reviewed deployment mechanism. It adds more moving parts than passing the intended owner explicitly. The constructor argument is easier to audit, test and verify.

## Consequences

- Positive: a newly deployed escrow can have its optional registry administration controlled by the Owner Safe from genesis.
- Positive: the deployment script fails before broadcast if either Safe variable is absent or either address has no code.
- Negative: constructor ABI changes, so all scripts and test deployments must be updated. This branch updates the known Foundry call sites.
- Negative: all contract code affected by this change must be independently audited at the exact deploy commit. Prior audit reports do not cover this ABI change.
- Negative: the Owner Safe's signer or configuration compromise can alter the optional registry wiring. The owner still cannot move escrowed funds or redirect the Treasury Safe.

## Validation required

- Foundry unit, fuzz, invariant, fork and coverage gates all pass.
- New tests prove owner() equals the explicit non-zero owner argument and construction rejects zero owner.
- All deployment and test call sites pass an explicit owner.
- The production deployment script refuses missing owner/treasury env values and EOA destinations.
- Mainnet preflight validates Safe configuration before deployment; post-deploy assertions verify exact escrow treasury and owner getters.
- The full E2E Safe withdrawal path is rehearsed on a controlled chain.
- External audit reviews the exact commit containing this constructor change and all affected scripts.
- Mainnet release remains blocked until every ADR-0020 sign-off and founder approval is complete.
