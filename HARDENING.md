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
10. **Open from the 2026-10-22 race-and-edge audit.** Four were fixed in `apps/juror` (the salt
    outliving the broadcast, one bench per pass, a fresh chain-clock read per candidate, and a
    `FileState` that shared its forfeit map with a module constant) and each has a mutation that
    now fails. These were found and are **not** fixed; they are listed with their evidence so the
    next reader does not have to rediscover them.

    - **A repaired block timestamp is thrown away.** `packages/indexer/src/scribe.ts:680` calls
      `hydrateTimestamps(model, blockTimes, [])` with an empty id list, which `model.ts:592` turns
      into "hydrate nothing" — and `:388` then clears `blockTimes`. A block whose `getBlock` failed
      once keeps a *block number* in `createdAt`/`runAt` forever, so `breakWindowEndsAt`
      (`model.ts:706`) publishes a 1970 deadline on `/snapshot`, `/trials` and `/stream`, with
      nothing saying so. The comment above the call claims the row is re-hydrated. It is not.
    - **An unclaimed trial's reward has no watcher.** `CrucibleTrials.sol:425` lets
      `reclaimExpired` fire on `Status.Open` precisely so orphaned escrow has an exit, but
      `packages/warden/src/policy.ts:88` lumps `open` with `settled` as "nothing to do". The newest
      guard on the contract has no consumer: dead trials hold `MAX_TOTAL_ESCROWED` forever.
    - **`Warden.start()` still decides on the host clock.** `packages/warden/src/warden.ts:100`
      passes `Math.floor(Date.now() / 1000)` and `WardenDeps` has no `chainNow` seam, so the fix in
      `apps/keeper` is only there because the keeper refuses to call `start()` and drives `sweep`
      itself. Any other embedder inherits the bug, and on a warped demo chain settlement silently
      stalls while `/health` answers.
    - **Nothing reaps sandbox containers by label.** `SANDBOX_LABEL` (`sandbox.ts:88`) is documented
      as the handle "whoever is cleaning up after a crashed verifier" would use; the only readers
      are the tests. After a death that is not a timeout — an OOM-killed node, a container restart —
      workloads stay alive holding CPU and memory claims.
    - **The cursor write is not atomic, and its temp name is fixed.** `scribe.ts:279-293` writes the
      temp file, then writes the real file, then unlinks the temp; there is no `renameSync`, so the
      documented "written atomically" is not true and a death mid-write leaves a truncated cursor
      that `loadCursor` treats as absent — a silent full re-scan. All three services read the same
      `CRUSIBLE_CURSOR_FILE` name, so the shared temp path is shared too.
    - **Registry fan-out has no ceiling.** `apps/api/src/server.ts:221` runs `Promise.all` over every
      agent, three `readContract` calls each, every 2s, on a path with no throttler — and one
      `registerAgent` at `MIN_BOND` permanently adds three reads per sweep. 500 agents is about 750
      concurrent reads against the node the indexer shares.
    - **"Catching up" is reported as "failing".** `scribe.ts:429` assigns the same `syncError` field
      for a tick that threw and for a cursor legitimately behind the head, and `MAX_PROOF_BLOCKS_PER_TICK`
      (64) means a 40,000-block gap takes ~5 minutes of `/health` 503 — during which `web`, which
      waits on `api: service_healthy`, does not come up. The message even says "re-reading it".
    - **Front-end money and clocks.** `apps/web/src/lib/wizard.ts:75` computes the bond in floats and
      rounds to 4 decimals, so the advertised bond can be short of the contract's floor-divided wei
      and the claim reverts `StakeTooSmall`; `apps/web/src/lib/forge.ts:93` `formatEth` uses
      `toFixed` (rounds *up*), printing a stake larger than the operator signed for, against the rule
      written in `api.ts:119`; `apps/web/src/app/trials/new/page.tsx:112` derives the deadline from
      `Date.now()` against a `block.timestamp` guard, so on a warped chain every new trial reverts
      `BadDeadline` and the error names the method, not the clock; `trials/[id]/page.tsx:53` closes
      the break UI one second before the contract does (`>=` vs the contract's `>`).
    - **`FEE_BPS` is read once at boot.** `apps/api/src/server.ts:274` fills it inside a single `try`
      and never retries; a boot-time blip leaves the published fee rate `null` for the life of the
      process. It is a `public constant`, so there is no reason not to re-read it.
    - **`notifications()` has no memory.** `packages/warden/src/policy.ts:114` re-emits every
      settled trial's `verdict-landed` on every pass; latent only because the keeper does not
      attach a notifier today.


Report a vulnerability as described in [`SECURITY.md`](SECURITY.md), not in a public issue.
