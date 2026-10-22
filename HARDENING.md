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
- **Coverage runs and is a gate.** `npm run coverage:gate --workspace crucible-contracts`
  re-runs `forge coverage --ir-minimum` and then fails the build when a production
  contract drops below its floor (`scripts/coverage-gate.mjs`). Floors are per contract,
  not on the `Total` row, because the total is 66.5% solely by construction:
  `script/*.sol` are exercised by the demo and the deployment assertion, not the unit
  suite. Measured now: 97.47% lines in `CrucibleTrials.sol` (95.93% statements, 90.24%
  branches), 97.01% in `AlloyRegistry.sol`, 94.34% in `ReputationBridge.sol` and 93.15%
  in `CrucibleHall.sol`. Coverage needs `--ir-minimum`, because forge disables the
  optimizer and viaIR for coverage and the legacy codegen then hits "stack too deep".
  The gate is mutation-tested in the sense that matters: it fails on a dropped floor, on a
  contract vanishing from the report, on an unparseable report, and on a missing file.
  `CrucibleHall` is the weakest at 72.22% branches and 75% functions; the gate clears it
  and names it, rather than quietly excusing it.
- **The dependency-audit gate reconciles before it judges.**
  `scripts/audit-gate.mjs` refuses a payload with no `auditReportVersion`, no
  `vulnerabilities` object, or an entry count that disagrees with npm's own
  `metadata.vulnerabilities.total` — previously an empty or reshaped payload printed
  "only documented advisories" and passed. Every documented name also now carries a
  severity ceiling, so a critical in a wallet package is no longer excused by a prefix
  match.
- **EIP-712 digests are compared to the contract's own source.**
  `packages/smith-sdk/test/eip712-parity.test.ts` parses the `Run` encode-type, the
  domain typehash and `submitRun`'s digest formula out of `CrucibleTrials.sol` and asserts
  viem's `hashTypedData` reaches the same bytes. Reordering a struct field turns five of
  them red.
- **A test that did not run says so.** The four ERC-8004 fork tests call `vm.skip`
  unless the suite is on a mainnet fork, so a run without `MAINNET_RPC_URL` reports
  `126 passed, 4 skipped` instead of four green tests that asserted nothing.
- **Every seeded trial commits to content that exists.**
  `scripts/seed-content.mjs` pins `fixtures/trials/counter` through the same
  `ContentService` a verifier uses, generates `crucible-contracts/script/SeedContent.sol`
  with the two digests, and resolves each digest back out of the store to prove the bytes
  come home. The seeds post those constants instead of
  `keccak256(abi.encodePacked("spec-open", i, block.timestamp))`, which named a string no
  pinning process ever wrote. `scripts/demo.mjs` then reads `TrialCreated` off the chain and
  compares the two data words to the committed constants, so the claim is the chain's, not
  the script's: a local build reports `8 trials, every one committing to the pinned spec and
  suite`, and putting one invented hash back at one of the two Extend sites fails it with
  `3 of 8 trials commit to content that is not the pinned fixture`. CI re-runs
  `npm run seed:check` on every push, and `packages/argus/test/no-orphan.test.ts` fails if
  that step is ever unwired — a gate that exists but does not run is how PR #15's pagination
  ended up merged and undeployed.
- **The bytes behind a digest cannot be rewritten by a checkout.**
  `.gitattributes` pins `fixtures/**` to LF. Measured on a Windows box with the default
  `core.autocrlf=true`: a fresh `git worktree` checkout produced CR=6 in `foundry.toml` and
  CR=17 in `SPEC.md` where the committed blob has none, so the *same commit* hashes to two
  different digests depending on the machine. `seed-content.mjs` refuses any CR byte in a file
  it is about to pin rather than posting a machine-specific digest.

## Still open from this pass, by severity

These are known and intentional, not claims that the software is safe. Ordered by how
much of the product's promise each one costs.

1. **The content layer exists; the seat that uses it does not.** Bytes move for real on both
   sides of a run now — `ContentService` (`packages/forge-runner/src/content.ts`) pins and
   fetches spec, suite, repo and log content, `ContentBridge` (`packages/cidstore/src/bridge.ts`)
   keeps the disclosure log that ties a keccak digest to the sha256 CID naming the same bytes,
   and `LiveVerifier` (`packages/argus/src/live.ts`) runs the six deterministic gates against
   them. `scripts/verify-roundtrip.mjs` exercises the whole path — pin, execute with a real
   forge, sign, publish, verify — and catches an inflated claim and an unregistered key. What
   is still missing, in the order that makes each checkable by the last:
   - **No seat operator.** `commitVote` and `revealVote` (`packages/smith-sdk/src/client.ts`)
     have no caller outside tests, so nobody reads a Challenged trial off a chain, runs the
     gates, and signs what they found. Until that exists the deterministic phase is a library,
     and a skeptic's challenge still resolves through the committee.
   - **The live chain's store is not populated.** The VPS seed image and the deployed API have
     no node path that pins, so the digests the hourly extend posts resolve to bytes only on a
     machine that ran `scripts/seed-content.mjs`. Populating it belongs with the operator,
     which is the first thing that would read it.
   - **A re-run has never executed in a container.** `rerunOnFreshBench` has run locally and in
     the degraded path; no test takes a pinned suite through the Docker sandbox end to end.
   - **The demo hall's run hashes are still synthetic.** `Demo.s.sol` submits
     `keccak256("RunArtifact{all-pass}")`, not a signed artifact, so its settled rows have
     resolvable demands and unverifiable answers. Real ones come from a runner publishing a run.
   Earlier text in this item described the whole layer as absent; that was true of the tree at
   the time of the audit and is not true now.
2. **No professional audit and no formal verification.** A settlement bug is not
   recoverable by anyone; the contracts are not upgradeable.
3. **No pause or admin recovery.** This is deliberate for an escrow, but it means a bug
   cannot be stopped.
4. **The owner can wire or unwire the optional reputation and identity registries.** The
   owner holds no funds and cannot settle a trial, but this is a privileged role.
5. **`CrucibleHall` is undeployed here, and its push payouts are a documented carve-out.**
   `settleTrial` sends ETH with `call{value:}`, accepts house funding via `receive()`, and
   clamps `reward = min(stake + bonus, balance)` so an underfunded house pays less than
   advertised. That is not a leak in the escrow's doctrine: ADR-0003 states Hall "is a
   separate contract with its own push-based settlement; it is not part of this escrow and
   must not be used to infer `CrucibleTrials` semantics." No deploy script deploys it and
   no `apps/` code calls it; `HallIndex` keeps itself offline when the deployment is
   absent. The consequence worth remembering is the reverse: Hall's weaker coverage (72%
   branches, 75% functions) and its payout behaviour are not evidence about anything a
   visitor's money does, and must not be read as such.
6. **The demo is ETH on a local Anvil chain.** It is not a USDC/Base deployment and has
   not been exercised against a production asset.
7. **The API read model and rate limiter are process-local.** Neither is a global
   consistency or abuse control behind a multi-instance load balancer.
8. **ERC-8004 fork tests still need an RPC to prove anything.** Without
   `MAINNET_RPC_URL` the four fork tests are skipped, not run. The `ci.yml` fork job now
   says so in its own summary rather than reporting a quiet green, and
   `.github/workflows/fork-nightly.yml` runs them on a schedule and fails if the
   credential is missing — but that job has never executed, so the bridge has still not
   been exercised against the registry as actually deployed, only against the mock.
9. **The demo scripts are not covered.** Coverage is measured over the contracts; the
   `script/` files that deploy and replay the loop are exercised by the demo and the
   golden path instead, which is why they read 0%.

Report a vulnerability as described in [`SECURITY.md`](SECURITY.md), not in a public issue.
