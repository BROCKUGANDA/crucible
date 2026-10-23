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
   - **The seat operator exists; its bench does not.** `apps/juror` is the production caller: it
     reads a Challenged trial off the chain, fetches the content the trial committed to, runs the
     six deterministic gates, and casts this seat's commit and reveal with the salt held in a
     durable store. What it cannot do on the deployed box is *execute*: the image carries no
     container runtime and no daemon socket, because a container that can ask the host daemon for
     containers holds the host, and this box runs other projects. So every verification on the VPS
     fails before a suite can run — there is no `docker` binary to spawn, and `dockerAvailable()`
     rejects rather than reporting a clean "no daemon" — the seat records the error, abstains, and
     `/health` shows it. The challenge still falls to the committee. The seat is honest about being
     unable to check, which is the right failure — but it is not yet the product. The two ways out
     are a bench the seat talks to over the compose network (no socket, more moving parts) or an
     explicit operator decision to mount the socket and accept what that grants. Neither has been
     run: this is a reading of the image, not a measured abstain on the live box.
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
10. **The 2026-10-22 race-and-edge audit.** Four were fixed in `apps/juror` (the salt
    outliving the broadcast, one bench per pass, a fresh chain-clock read per candidate, and a
    `FileState` that shared its forfeit map with a module constant) and each has a mutation that
    now fails. Everything else the audit found has since been **re-checked against the tree**, because
    a register that lists closed findings as open trains the next reader to ignore it.

    **Closed since the audit was written — all of these are ancestors of `develop`, and the text
    below them was not amended when they landed.**

    - Open-status reclaim (`6c98a93`): `policy.ts` now emits `unclaimed-past-deadline-reclaim`, so
      the `Status.Open` exit at `CrucibleTrials.sol:425` has a consumer.
    - `Warden.start()` host clock (`6c98a93`): `chainNow` is a required `WardenDeps` member, not a
      default, so the wall clock is unreachable from `start()`.
    - Cursor write atomicity (`6c98a93`): temp file carries the pid and the write ends in
      `renameSync`, so a death mid-write no longer reads as an absent cursor.
    - Registry fan-out ceiling (`6c98a93`): `server.ts` sweeps in batches of `ALLOY_SWEEP_BATCH` (8)
      instead of one unbounded `Promise.all`.
    - "Catching up" reported as "failing" (`6c98a93`): `syncStalled` is its own fact, so a cold
      backfill no longer holds `/health` at 503.
    - `FEE_BPS` read once at boot (`6c98a93`): `server.ts:230-233` re-reads it until it succeeds,
      and `HARDENING`'s own anchor (`server.ts:274`) has since become unrelated code.
    - A repaired block timestamp thrown away (`012756e`): `hydrateTimestamps` is called with the id
      list omitted — which means every row — and the retry runs at the top of every tick, above the
      caught-up early return, so a chain with no events still heals.
    - Front-end bond arithmetic (`wizard.ts:76-100`): the bond is computed in `bigint` and rounded
      **up** at display precision, because a required minimum printed low is a `StakeTooSmall` revert.
    - `formatEth` rounding up (`forge.ts:96-98`): it truncates via `Math.trunc` before printing.

    **Still open, with the evidence.**

    - **Nothing reaps sandbox containers by label.** `SANDBOX_LABEL` (`packages/forge-runner/src/sandbox.ts:88`)
      is documented as the handle "whoever is cleaning up after a crashed verifier" would use; the only
      readers are the tests (`test/sandbox-docker.test.ts:73`). After a death that is not a timeout — an
      OOM-killed node, a container restart — workloads stay alive holding CPU and memory claims.
    - **`notifications()` has no memory.** `packages/warden/src/policy.ts:133` re-emits every settled
      trial's `verdict-landed` on every pass. Latent, and verified latent: `Warden.sweep` guards the
      whole path on `if (this.deps.notifier)` (`packages/warden/src/warden.ts:76`) and the keeper only
      records the count (`apps/keeper/src/main.ts:287`) — it attaches no notifier. The first embedder
      that passes one turns this into a webhook that repeats every sweep, forever, per trial.

    **Closed since the audit, and the two that were this document's own error.**

    - A trial's deadline derived from the wall clock, and a chain deadline compared against a server
      clock — both closed by the chain-anchor work (PR #38). `/snapshot` now publishes
      `headTimestamp`, and `apps/web/src/lib/chainClock.ts` anchors every countdown and window test on
      `max(headTimestamp + 1, serverNowMs)`, which is the rule the node uses to stamp its next block.
      The wizard builds its deadline at `apps/web/src/app/trials/new/page.tsx:125` and the quench gate
      compares at `apps/web/src/app/trials/[id]/page.tsx:57`, both against that anchor. `Date.now()`
      survives only as the documented fallback for a page that has not received a snapshot yet, where
      there is no evidence of a warp to correct.
    - The second half of that pair was reported here as an off-by-one (`>=` where the contract uses
      `>`). It was measured wrong: the contract reverts `WindowOpen` while
      `block.timestamp < _windowEnd(t)` (`CrucibleTrials.sol:589`), so it finalizes at `>=`, and the UI
      agreed with it all along. The real fault was the clock on the left side, not the operator — and
      a corrected record is worth more here than a preserved finding.
    - Note on line numbers in this file: `apps/keeper/src/main.ts:267` was cited for the notifier
      count before that file gained the gas ledger, which moved it to `:287`. A register that names
      lines has to re-check them after touching the file it points at.


Report a vulnerability as described in [`SECURITY.md`](SECURITY.md), not in a public issue.
