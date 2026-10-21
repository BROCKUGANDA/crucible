# Hardening record

This is a demonstration project, not an audited escrow system. This file records what the
current tree actually verifies, what it deliberately does not, and what is still open.

## Verified in the current tree

- **Pull payments only.** `CrucibleTrials` credits balances and pays through `withdraw()`;
  settlement never pushes ETH to a caller.
- **Settlement runs once.** The state machine moves to `Settled` before any payout, and
  every settlement path checks that state.
- **Signature handling.** Run artifacts are EIP-712 signed and bound to the trial, agent,
  run hash and deadline; high-`s` signatures are rejected; a submitted run cannot be
  replayed.
- **Dispute liveness.** Argus commitments close on a clock (`COMMIT_WINDOW`), not on the
  first reveal, so one seat cannot disenfranchise the other two.
- **Permissionless exits.** A sponsor can reclaim an expired trial that never produced a
  run; anyone can finalize after the skeptic window or the dispute timeout.
- **Input guards.** Zero treasury, zero Argus seats, duplicate seats, zero runner keys,
  zero spec/test CIDs, zero run hashes and zero break proofs are rejected. Rewards are
  capped at 1,000 ETH and total escrow at 10,000 ETH as fat-finger guards.
- **Conservation invariants.** Foundry invariants assert that balance equals free stake,
  pending credits and escrow at all times.
- **One-command verification.** `npm run verify:all` runs typecheck, every TypeScript
  workspace and the Foundry suite. `scripts/run-forge.mjs` locates Foundry when it is
  installed outside PATH.
- **Slither triage.** Every detector suppression is justified in
  [`crucible-contracts/docs/slither-triage.md`](crucible-contracts/docs/slither-triage.md).
- **Coverage runs and is a gate.** `npm run coverage --workspace crucible-contracts`
  reports 97.4% of lines in `CrucibleTrials.sol` (95.8% of statements, 89.9% of branches),
  97.0% in `AlloyRegistry.sol`, 95.5% in `ReputationBridge.sol` and 93.2% in
  `CrucibleHall.sol`. It needs `--ir-minimum`, because forge disables the optimizer and
  viaIR for coverage and the legacy codegen then hits "stack too deep".
- **A test that did not run says so.** The four ERC-8004 fork tests call `vm.skip`
  unless the suite is on a mainnet fork, so a run without `MAINNET_RPC_URL` reports
  `126 passed, 4 skipped` instead of four green tests that asserted nothing.

## Still open from this pass, by severity

These are known and intentional, not claims that the software is safe:

1. **No professional audit and no formal verification.** A settlement bug is not
   recoverable by anyone; the contracts are not upgradeable.
2. **No pause or admin recovery.** This is deliberate for an escrow, but it means a bug
   cannot be stopped.
3. **The owner can wire or unwire the optional reputation and identity registries.** The
   owner holds no funds and cannot settle a trial, but this is a privileged role.
4. **The demo is ETH on a local Anvil chain.** It is not a USDC/Base deployment and has
   not been exercised against a production asset.
5. **The API read model and rate limiter are process-local.** Neither is a global
   consistency or abuse control behind a multi-instance load balancer.
6. **ERC-8004 fork tests need an RPC.** Without `MAINNET_RPC_URL` the four fork tests
   are skipped, not run: the bridge has never been exercised against the registry as
   actually deployed, only against the mock.
7. **The demo scripts are not covered.** Coverage is measured over the contracts; the
   `script/` files that deploy and replay the loop are exercised by the demo and the
   golden path instead, which is why they read 0%.

Report a vulnerability as described in [`SECURITY.md`](SECURITY.md), not in a public issue.
