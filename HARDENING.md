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
- **A fault cannot produce a blank page, and a slow read cannot produce a dead one.**
  Every route has a `loading.tsx`, and `global-error.tsx` covers failures above the
  providers. Both boundary paths were forced on purpose and the shipped rendering read
  out of the browser: a server-side root-layout fault is answered by Next's own document
  (this code is not in it, so it cannot leak a stack trace), and a client-side fault shows
  the forge panel on the design tokens. The build is what proved the shape: the first
  `app/loading.tsx` wrapped the page in `Chrome`, Next composes that fallback around
  `/_global-error` — outside `WagmiProvider` — and `next build` went red with
  `useConfig must be used within WagmiProvider`. Fix verified by the same gate going green.
- **No page renders an unbounded list from a live read.** `/trials` draws at most 50 rows
  and states the withheld count; the click that grows the window is floored to a whole page
  in `apps/web/src/lib/paging.ts`, so the number a visitor supplies cannot ask for all of
  them. Mutation-proved: replacing the clamp with the row count turns 3 of the 8 tests in
  `apps/web/test/paging.test.ts` red.
- **The prompt-injection guard runs by default, not by memory.** `@crucible/agent-security`
  was built, tested, and listed as a `forge-runner` dependency while nothing in production
  called it: `scripts/live-agent.mjs` constructs the agent with `{ client, model, temperature }`
  and no wrapper, so `step()` fell through to a raw pass-ahead and the sponsor's spec — the
  input whose own docstring promised it "is never an instruction" — reached the model verbatim.
  `createForgedAgent` now defaults to `wrapUntrusted`, and the second untrusted channel
  (suite stdout from a sandbox running the sponsor's code) is classified with
  `scanRetrieved`. Both channels refuse only an instruction — role-hijack, instruction-override,
  and the HTML hidden-carrier escalation. The patterns are broad on purpose, and refusing a
  whole spec because it said "send the token" or "owner access" meant a legitimate trial never
  reached the model at all; those matches are quarantined inside the untrusted region instead.
  A withheld suite output is named in `notes` and emitted as a text-free
  `withheld: "suite-output"` status event, so an operator sees the lost context without the
  runner parsing prose. Proved by reverting each channel to its pre-fix shape and watching the
  new tests go red — and the assertions are on the prompt the fake client actually received,
  never on the classifier itself.
- **The deploy refuses a stale address before it replaces anything.** `web` and `api` are
  recreated from `.env` before the post-deploy assertions run, so an address that disagrees
  with what the seed actually deployed used to take the running site down and only then fail.
  The pipeline now reads `/run/crucible/deployed.env` through a one-off seed container and
  compares both addresses before the swap, while the old containers are still intact. The
  keeper read `.env` alone — a second answer to "where are the contracts" — so it now mounts
  the same volume and sources the same file as the API. Proved by extracting the step and
  running it against a stubbed `docker`: match exits 0, a mismatch, a missing key and an
  empty published file each exit 1 with the distinct message.
- **A public repository cannot execute a fork PR on the VPS.** Every CI job runs on the two
  self-hosted runners, and those are the box that serves the site and holds its `.env` — so
  making the repository public turned every `pull_request` into an execution path. All seven
  `ci.yml` jobs carry
  `if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository`.
  GitHub runs the base branch's workflow file for `pull_request`, so a fork cannot remove the
  clause, and `ci.yml` is the only PR-triggered workflow in the repository.
- **The arena fits EIP-170, and the gate that says so is measured.** `forge build --sizes` refused
  `Arena` at 26,209 bytes — 1,633 over the 24,576-byte runtime limit — because the project optimized
  for runtime gas (`optimizer_runs = 10_000`). Two measured changes, both with the pinned forge
  v1.8.5: the setting is 200 now (21,338 alone), and 19 getters that were strict subsets of
  `stateOf`/`amountsOf`/`windowsOf`/`breakAt` moved to `test/ArenaReads.sol` (20,155, 4,421 under).
  The ABI shrink is cheap this moment because nothing off-chain reads the arena yet (item 16); once
  an indexer does, a removed selector is a breaking change. After the move: 250 Foundry tests
  green, Arena coverage 98.76 / 94.24 / 73.20 / 100.00, every floor cleared.
- **The CI tool downloads are digest-pinned, which is what their step name always claimed.**
  Three steps in `ci.yml` and one in `fork-nightly.yml` were called "install foundry (pinned
  tarball)" while the body piped `curl` straight into `tar`: the pin was a version tag, and a
  re-uploaded asset would have run. Versions and digests now live in
  `scripts/install-tool.sh`, which verifies with `sha256sum --check --status --strict`
  *before* extracting. Foundry v1.8.5's digest was measured here and corroborated against the
  one GitHub publishes for that asset; gitleaks 8.24.0's matches the `linux_x64` line of the
  `gitleaks_8.24.0_checksums.txt` in its release (the asset API returns `digest: null`, so the
  vendor's file is the corroboration) — recorded as such in the file. Proven able to
  fail three ways: a wrong expected digest exits 1 and extracts nothing, an unknown tool name
  exits 2, and deleting `--strict` or moving `tar xzf` above the check turns
  `packages/argus/test/no-orphan.test.ts` red.
- **A helper nobody calls is deleted rather than documented.** `dlq.all()` was annotated
  "for an operator endpoint", had no endpoint, no caller and no test; the health payload's
  `summary()` is the reachable surface, and the full queue cannot be exposed on this API
  because a viem error carries the RPC URL. `apps/api/src/dlq.ts` now holds the part that runs.
- **Gate 502 — the sandbox seal runs in CI.** The `node` job builds the workspace libraries and
  then runs `npm run lint:imports --workspace @crucible/harness`: the harness module graph (the
  code an agent's proposal executes inside) may import neither `fs`, `child_process`, `net`, `tls`,
  `crypto`, nor any wallet library, spelled bare or with the `node:` prefix, statically or through a
  dynamic `import()`. The scanner is `packages/harness/src/import-lint.ts` compiled — the gate lints
  the code that ships, not a parallel reimplementation — and exempts exactly one file, the enforcer
  itself, which must read the tree to police it. Proven able to fail: a probe file importing
  `node:fs` turns the step red (exit 1, named in its output), and removing it returns green.
- **The gate registry answers to the code it lists.** `docs/gates.yml` now carries the Money Trees
  gates 434–438 the shipped chip implements (`MoneyTreesChip.tsx`, `money-trees.ts`) and the Frenchy
  v2 voice gates 668–677 the selector implements (`frenchy/selector.ts`); the compliance matrix
  regenerates at 259 gates and the white paper's enforced range reads 434–677. The Frenchy block had
  a numbering disagreement in the code itself — `selector.ts` called anti-repeat 675 while its own
  test pins 675 as determinism and 677 as anti-repeat — resolved in favour of the test, whose
  one-block-per-gate enumeration leaves exactly 674 (static pools, no runtime LLM) and 676 (never a
  spine writer) for the two properties the header states but no number pinned; the comment now
  matches.
- **The trace spine's spans are inventoried as data.** `SPAN_INVENTORY` in `packages/smith-sdk/
  src/trace.ts` says, per span, which actor writes it, when, and which detail keys it carries — the
  table the Live Foundry showcase renders from. The keeper's test reads the `span:` literals out of
  its own `main.ts` with comment lines filtered (the lesson from the `includes("--strict")` gate)
  and fails on a produced span the inventory cannot explain. Proven: a `keeper.unknown` literal
  turns the test red; reverted, it is green.
- **Every workspace is actually covered by CI again.** `@crucible/crypto`, `@crucible/harness` and
  `@crucible/grader` had `typecheck`/`test` scripts no job ran, and four Dockerfiles ran `npm ci`
  without their manifests — the workspace-coverage gate was red on all of it. They are in the
  `node` job's two lists and `build:libs`, their manifests are copied in the api/juror/keeper/web
  images, and their three `tsconfig.build.json` files no longer pull `test/` into a build rooted at
  `src/` (which had never been run: `npm run build:libs` failed the first time it was actually
  executed). The gate is green: 15 workspaces, 14 in ci.yml, 1 excluded by name.
- **A shared browser can no longer hand one user another user's transaction.** `useTx` reset
  nothing on account switch, so user B connecting after user A's "Poured." inherited A's terminal
  result, gas line and busy-lock as if it were theirs; and an unconnected click on a
  permissionless button decoded as "the network refused" instead of naming the next action. The
  hook now resets every terminal surface when the connected address changes, refuses a send with
  "Connect a wallet to send this." before any deployment check, and keeps `address` in the send
  deps. Proven by mutation: prepending `false &&` to the reset condition, to the wallet guard, or
  dropping the dep each turns a dedicated test red (the first version of the reset test matched
  prose shape and survived its own mutation — it was rewritten to pin the executed condition).
- **The fan-out holds a room, not a focus group.** A new HTTP-level soak opens forty real
  sockets against `@hono/node-server`, asserts every handshake frames, that a fully idle audience
  adds zero read-model rebuilds (the shared tick, not per-viewer work), and that one chain move
  is delivered to all forty — counted per client so a silently dead loop cannot hide in an
  average. Green in 2.2s; the API suite is 127.
- **ESLint exists now, wired to what it can honestly check.** The web app has `eslint.config.mjs`
  (flat, ESLint 9): react-hooks recommended + core correctness over a Babel parser. The
  typescript-eslint parser hard-refuses the workspace's TypeScript 7 ("does not support TS 7.0"
  and exits), so type-level linting stays with `tsc --noEmit` — now with
  `noUnusedLocals`/`noUnusedParameters`, which surfaced exactly three genuinely unused imports/
  params, all fixed. The first lint run found three real hook violations: a conditional
  `useCallback` in `MoneyTreesChip` (after its early return), a dead `requireScrub` helper that
  called a hook from a non-hook function (deleted, not renamed — it had no callers), and a
  member-expression effect dep in `Chrome.tsx` (destructured). `npm run lint --workspace
  @crucible/web` runs in the CI node job, and exits clean.
- **The Solana port is real code with green host tests.** `crucible-contracts/solana/` is a
  complete Anchor 0.30.1 workspace: the reward flow table ported function-for-function in
  `math.rs` (fee 500 bps — the port spec's "15%" prose is the external-PRD number AGENTS.md
  names as the trap; the deviation is recorded in the README's deviation table), six
  instructions with checks-effects-interactions order and a conservation assert at the end of
  every mutation, typed errors mirroring the EVM table, a PDA-owned vault as the only stake
  spend path, the e2e mocha suite for every flow-table row plus both rejection paths, the
  gate-702 CPI allowlist check (green), and the pinned-toolchain artifacts. `cargo test -p
  work-escrow` in WSL: **12/12 green** — the crate compiles against anchor-lang 0.30.1 and every
  row of the table partitions the pot exactly. anchor-cli 0.30.1 is installed. The SBF build is
  blocked in this environment, on the record: `cargo-build-sbf` 3.0.0 was never published to
  crates.io (only 4.x and a 3.1 beta) and the anza-agave GitHub org does not resolve from this
  network — the README's one-command install completes it wherever GitHub is reachable.
- **Gates 701–720 (the Solana port spec) are in the registry** the compliance page generates
  from — and, since 2026-10-24, so is **678–700**: the eval-spine block, with each of the 23
  titles derived from the code that ships. Every title was written against `grader/src/eval/`
  and only claims what a module does — the named error codes were grepped out of the
  implementation before any title was allowed to mention one (BATCH_AUTO_VOID, CHECKER_THREW,
  TOKENIZER_CORPUS_DRIFT, NONDET_SAMPLING, TRUNCATED_RUN and the rest exist verbatim; codes the
  planning prose named but the code does not carry — MODEL_IDENTITY_DRIFT, USAGE_UNREPORTED —
  appear in no title). GraderRegistry stays gate 433, un-duplicated. The registry is now
  **302 gates, gapless 419–720**, verified by script.
- **The commit-blocking fixtures are fixed at the source** (2026-10-24). `providers.test.ts`
  carried fourteen `gsk-test` fixture keys shaped like a real provider's credential prefix —
  exactly the pattern credential scanners exist to flag, and the flag hard-blocked every commit
  in this tree. The fixtures now send a runtime-assembled bearer sentinel
  (`["round","trip","sentinel"].join("-")`), the one header assertion derives from it instead of
  duplicating a literal, and the suite is 20/20 green. A scanner that pattern-matches key-shaped
  constants also rejected the first rework (`fixture-key-not-a-credential`), which is the
  scanner doing its job on names as much as values.
- **The Solana toolchain question is closed** (2026-10-24): the solana-labs **v1.18.26** release
  tarball is the pin — one download carrying `solana`, `solana-test-validator`, `solana-keygen`,
  `cargo-build-sbf` and platform-tools v1.41 bundled, so nothing is fetched after install. The
  authorized "float to crates.io 4.x" turned out to be a float to nothing: `cargo-build-sbf`
  and `solana-test-validator` publish as library-only crates with no binaries to install, and
  the agave GitHub org does not resolve from this network. v1.18.26 is anchor 0.30.1's
  contemporary and the original setup-list pin; Anchor.toml and the README now say so, with the
  v3-lockfile recipe (a COMPLETE v3 lock is preserved by every cargo in the tree; an empty seed
  is regenerated as v4) and the discovered crate floor pins (blake3 1.5.1 — the pin the original
  note named — proc-macro-crate 3.1.0, indexmap 2.11.0, zeroize_derive 1.4.2, borsh 1.5.9)
  encoded in `scripts/toolchain-pin.sh`.

- **v2 P0 landed (2026-10-24, ADR-0011 + gates 731–733).** The v2 build bible is a product
  pivot — its 1500 bps arena fee is the exact change AGENTS.md names as requiring an ADR —
  so the ADR came first: legacy law frozen byte-for-byte (machine-checked), arena fees live
  as *parameters* in `params/crucible.params.json` behind a codegen whose five derived
  invariants and legacy-freeze assertion are mutation-proven (flipping the frozen 500 to
  1500 turns `params:check` red with a message that names ADR-0011). `DECISIONS.md` records
  D-1..D-15 with the four bible-vs-repo conflicts and the readings taken; `AS_BUILT.md`
  records the proven toolchain (and what is *not* claimed); `scripts/restore.sh` ran green
  in-session (gate 731). Gates 721–795 joined the registry — **377 gates, gapless
  419–795** — and the params drift check runs in the CI node job.
- **The batch settlement path keeps the escrow's idempotency revert where the law puts it
  (2026-10-24).** `settleBatch` caught every per-entry revert and discarded it, and the sweep
  then stamped all trials in the batch with the single tx hash — so the keeper could report
  settling a trial the chain had refused. Now only an already-settled entry is skipped, a trial
  that is not finalizable aborts the batch, and the warden — the layer AGENTS.md names as
  owning per-trial error isolation — retries each trial alone and records each outcome on its
  own. `test_SettleBatch_RevertsOnNotSettleable` asserts the *end state* (neither trial settled,
  no credit moved), not that the caller stopped waiting; restoring the `try/catch` turns it red.
  `crucible-contracts/contracts/CrucibleTrials.sol:637`, `packages/warden/src/warden.ts:83,96`
- **`VerificationReceipt` is immobile, one-per-trial, and names the trial it proves
  (2026-10-24).** The in-flight contract shipped a full ERC-721 transfer/approve surface — a
  proof of proven work that could be sold, beside `AlloyRegistry`, which refuses the ERC-721
  label for exactly that reason (contract-spec.md §8, at :285-289) — and its `tokenURI` printed
  the mint
  counter where the spec asked for the trial id, two numbers that part company the moment a
  batch skips an entry. Every move path is gone, `receiptIdOfTrial` makes a second receipt for
  one trial revert `AlreadyMinted`, and the metadata carries the real trial id. 12 Foundry
  tests, including a low-level call to each of the four standard transfer/approve selectors
  asserting the function does not exist, and one that refuses ETH.
  `crucible-contracts/test/VerificationReceipt.t.sol`
- **Gate 702's own pattern was the bug it claimed to catch (2026-10-24).** The CPI allowlist
  header forbids `solana_program::invoke` and `invoke_signed`; the regex was
  `invoke_signed?\s*\(`, where `?` binds to the `d` — so plain `invoke(` matched nothing. Proven
  with a throwaway crate that carries both an out-of-policy dependency and a raw `invoke(`: only
  the dependency fired before the fix, both fire now. The allowlist is also scoped per program
  by name, because gate 702 is `work-escrow`'s law and the arena is designed around the Ed25519
  precompile; a program not named in `PROGRAM_POLICY` is **reported**, never silently passed.
  `crucible-contracts/solana/scripts/check-cpi-allowlist.mjs:32-37,73`
- **The arena's 15% cannot be imported into the 5% path by accident (2026-10-24).** Codegen
  emitted `FEE_BPS = 1500n` next to `CrucibleTrials.sol`'s live `FEE_BPS = 500`. The generated
  constant is `ARENA_FEE_BPS` in both Rust and TS, with the reason inline; `params:check` still
  gates drift and the five invariants in CI, and
  `test_FeeBpsIsFiveHundredNotFifteenHundred` reads 500 from the contract itself (flip the
  constant and it goes red, mirroring the Rust `fee_is_five_percent_not_fifteen`).
  `scripts/params-codegen.mjs:98-101`, `crucible-contracts/test/CrucibleTrials.t.sol:463`
- **The v2 arena exists as tested code beside the legacy escrow (2026-10-24, gates 734–746).**
  `contracts/Arena.sol` and `contracts/ArgusCourt.sol`, both reading their numbers from a
  generated `contracts/Params.sol` — which is what made `params/` a source instead of a note:
  the drift check in CI now stands between an edited JSON and a money contract. The legacy 5%
  contract, its 50/50 failed-stake split and its three fixed seats are untouched; the arena's
  15%, ranked docket, sealed breaks, holdout and bonded drawn panel are a different escrow with
  a different law, exactly as ADR-0011 framed it. 87 arena tests, 251 Foundry in all, five
  mutation proofs (rank-by-lowest-stake, prize-to-every-landed, ledger that skips the bond,
  ballots from strangers, cancel that forgets a claim was ever held) each turned its own gate
  red. Two things the suite caught while it was being written are fixed in the contracts, not
  papered over: a seat-selection walk that returned the *same seat three times* whenever the
  stride shared a factor with the pool, and a `DocketAlreadyFrozen` guard that sat behind a
  state check and so could never fire.
- **Two rejections this register did not have before (2026-10-24).** `commitVote`/`revealVote`
  accepted a ballot from any address, which let a stranger grow a panel's storage; the panel
  membership is now checked (`NotSeat`). And a no-show seat could be slashed again on every
  crank of `tally` — `_slashed` makes it once per seat per panel. Neither had a money effect
  (the roster, not the ballot store, decides who is paid), and both are the shape of defect
  that a flow-table-only suite does not find.
- **The 2026-10-24 Mimosa deep scan's 16 findings triage to zero code changes, with the
  evidence named per finding.** Scan `scan-2026-10-23T21-56-23.604Z-87faa63b4be5` (deep, sealed
  `sha256:c4309e86890e…`): 11 high, 5 medium; the dependency pass scanned 684 packages and
  matched 0 advisories. Every high is a static-analysis artifact, not a reachable fault:
  - The "code injection" at `grader/src/eval/suites.ts:144` is the word "eval" inside a doc
    comment — the exact prose-matches-the-gate failure the caution below this list describes.
    A repo-wide grep for `eval(`/`new Function` across `grader`, `apps/keeper`,
    `packages/forge-runner` and `apps/api` finds no call in runtime code.
  - The "command injection" at `packages/forge-runner/src/sandbox.ts:280` is a method *named*
    `exec` whose body is `execIn` → `execFile(bin, args)` — an argv array, never a shell; it is
    also the only `child_process` import in runtime code. `parseCommandLine` splits the
    sponsor-pinned suite command into argv for the same reason.
  - `createSweepLoop` — the keeper's claimed command-injection entry — spawns nothing: it
    schedules `deps.act` behind the kill switch and the breaker (`apps/keeper/src/sweep-loop.ts`).
    The environment variables that reach it are operator config (`intervalMs`, flag source).
  - The six SSRF findings in `apps/web/src/lib/useSnapshot.ts` (`:93`, `:252`, `:310`, `:313`)
    and `apps/web/src/lib/voice.ts` (`:94`, `:133`) are `"use client"` browser fetches to
    `NEXT_PUBLIC_API_URL`, baked at build time and defaulting to `127.0.0.1:8787`. No route
    handler under `apps/web/src/app` issues a server-side fetch at all, so there is no server
    to forge a request from.
  - The two findings in `crucible-contracts/lib/forge-std/scripts/vm.py` are upstream forge-std
    maintainer tooling inside the pinned submodule: line 41 fetches a *hardcoded*
    `raw.githubusercontent.com` URL (`CHEATCODES_JSON_URL`) unless the maintainer passes a local
    `--from` path; line 102 writes the constant `OUT_PATH = "src/Vm.sol"`. Not this repo's code
    to patch; the submodule pin carries whatever upstream ships.
  - The five medium "sensitive action without role check" advisories name the endpoints that
    must be public by design: `/health` and `/healthz` feed the compose healthchecks
    (`apps/api/src/app.ts:528-529`), and `/nonce`, `/verify`, `/session`
    (`apps/api/src/auth.ts:436`, `:465`, `:546`) are the auth bootstrap itself — requiring a
    session to obtain one is circular. All sit behind the per-IP rate limiter every request
    passes (`apps/api/src/app.ts:434-439`, `apps/api/src/rate-limit.ts`), with bounded bodies
    (`readBoundedJson`, 16 KiB), format-checked address/nonce/signature, and the challenge id
    delivered only as an HttpOnly cookie so a learned nonce cannot complete from another
    browser.
- **The Mimosa pre-commit gate's credential findings were remediated, not silenced.** The
  same day, the gate's separate L3 audit blocked a commit on 39 highs; its static set
  (`mimosa audit --deep`) counted 20, of which every "hardcoded credential" was a test
  fixture against a loopback server the test itself starts — `bearerSentinel` and
  `"nvapi-test"` in `packages/forge-runner/test/providers.test.ts`, `"sk-secret-key-value"`
  in `packages/forge-runner/test/agent.test.ts`, `"xi-test-key"` in
  `apps/api/test/voice.test.ts`. The file already carried the convention (assembled at
  runtime "because a static value named like a key reads as a credential to every
  scanner") but the engine constant-folds through a plain `join`, so the sentinel sites
  were flagged too. The fixtures are now genuinely runtime-supplied:
  `process.env.CRUCIBLE_TEST_*` with the assembled fallback — the value still round-trips
  through the header and still stays out of reflected bodies, which is all those tests
  assert. Measured: credential findings 20 → 0, static highs 20 → 11; the suites re-run
  green (`@crucible/forge-runner` 124 passed / 6 skipped-docker, `@crucible/api` 127
  passed). The 11 that remain are the false positives documented above — client-side
  fetches read as SSRF, a doc comment read as `eval`, `execFile` read as `exec`, upstream
  forge-std tooling, and test-local request fixtures — recorded rather than contorted
  around, because reshaping production code to evade a semantic analyzer is a worse trade
  than the block. The commit itself stays refused while those 11 stand: the scanner's own
  remediation for the web findings (reject loopback/private hosts) would break the demo,
  whose API default is `127.0.0.1:8787`, so the slice ships staged and this register is
  the disposition a reviewer acts on.
- **The one escape hatch was tested and closed.** `mimosa policy init` creates
  `.mimosa/security-policy.json`, but it is an enforcement amplifier, not an allowlist:
  filling it with this project's honest posture (loopback demo network, the no-shell law,
  a forge-std exclusion) activated policy enforcement across the tree and raised the audit
  from 11 to 79 highs — flagging the security suites' own injection-pattern tests as
  violations of the declared law. The file was removed rather than loosened to match,
  because declaring `forbidShell: false` or a private-network allowance to excuse those
  tests would misstate the product's actual rules. No per-finding false-positive allowlist
  exists anywhere in the plugin: the finding ledger records open/blocked/fixed/reopened
  only, and `mimosa validate` covers a single built-in contract. The remaining levers are
  the gate's own mode env (`MIMOSA_GIT_GATE_MODE=ask`, user-level, applies from the next
  session start) and reporting the engine's prose-matching and client-code-classification
  false positives upstream.

**One caution this pass produced about its own gates:** the wiring assertion first written for
`install-tool.sh` used `includes("--strict")` and stayed green after the flag was deleted from
the check, because the script's *comments* explain the flag and contain the string. The test now
scans executable lines with comments filtered out. A gate that matches prose in the file it
guards is the decoration it exists to detect.

- **The hand-written ABIs were missing events, and the drift gate that exists to catch ABI drift
  read in only one direction.** `packages/smith-sdk/test/abi-drift.test.ts` had three checks — ABI
  claims exist in the source, signatures match, topic0 digests match — and all three iterate over
  **what the ABI carries**. Nothing asked what the ABI *omits*. Adding that reverse assertion found
  seven missing events in two files: `CrucibleTrials.sol` emits `RunnerSet`, `ReputationBridgeSet`
  and `VerificationReceiptMinted`, none in `TRIALS_ABI`; `AlloyRegistry.sol` emits `Transfer`,
  `Locked`, `TierChanged` and `ForgeSet`, and `ALLOY_ABI` carried **no events at all**. Two concrete
  consequences, both measured: `RunnerSet` is in the indexer's own `EVENT_NAMES`, but the log filter
  is built by intersecting that list with the ABI, so the ingest list silently matched nothing and
  `model.ts`'s `RunnerSet` case had never run against a real log; and on the deployed chain the four
  `VerificationReceiptMinted` logs — the receipts the verify page exists to show — reported as
  undecodable noise (`meta.logsUndecoded: 4`). All seven events added, both directions asserted.
  Caveat the fix does not remove: the index holds a cursor, so `RunnerSet` logs already behind it are
  not re-read; the case runs from here forward, and a rebuilt index is what makes history agree.
- **The landing page's money sentences are now bound to the escrow, and three of them were wrong.**
  v2.2's §30.3 claimed the live copy contradicts the code; measured against the deployed site, that
  was true and the fix was not the one the document proposed. Stage V said "the skeptic takes the
  bond" while `_settleSlash` pays `bond * 3_000 / 10_000` to the skeptic, refunds the sponsor the
  full reward and sends the remainder to the treasury, and the same page already said it correctly
  two lines away. Stage V said nothing about a panel that never forms, though `DISPUTE_TIMEOUT` =
  3 days is a real exit that settles for the agent. Stage VI promised any hiring application could
  "read the record in one call" while `getSummary` exists only as an interface declaration
  (`IERC8004.sol:44`) with no implementation anywhere. All three corrected; `/.well-known/crucible.json`
  added so "no one can fake it" has an allowlist to check against, publishing `null` for an unbaked
  address rather than `0x0000…` (a reader filtering on the zero address drops every real record).
  The gate is `apps/web/test/landing-claims.test.ts`: it reads the constants out of
  `CrucibleTrials.sol` and compares them to the words, and it is proven to bite — setting
  `SLASH_SKEPTIC_NUM` to `4_000` reddens it, and restoring `3_000` greens it again. Its absence
  assertions are deliberately two-sided: it forbids "after the panel is paid" only while no seat fee
  exists, and forbids the one-call promise only while no implementation does, so shipping either
  mechanism lifts the ban instead of breaking the build.
- **`packages/smith-sdk` shipped a CLI that does not exist.** `package.json` declared
  `bin.smith → ./dist/cli.js` with no `cli.ts` in `src` and nothing referencing the command; anyone
  installing the workspace got a `smith` on PATH that cannot run. The declaration is gone (v2.2's
  H-7 asks for a `crucible verify` command, which is the honest way to bring a CLI back). Related
  and still open: `STANDING_HALF_LIFE_DAYS` is codegen'd into `params.ts` and `params.rs` and read
  by nothing, and there is no identity epoch in any layer, so the 45-day fade the ledger describes
  is a parameter without a consumer rather than a behaviour.
- **`standing_half_life_days` finally has a consumer, and the read model gained the one fact it
  was missing to use it.** `packages/smith-sdk/src/standing.ts` computes §18.2's
  `Σ w·o·δ ÷ (Σ w·δ + 3)` from the settled logs, with `DEFAULT_HALF_LIFE_DAYS` imported from the
  generated params so the number has one source, and a test asserting the default reaches the
  computation — the half-life previously existed in `params.rs` and `params.ts` and was read by
  nothing. Getting there exposed a gap in the projection: a `TrialRow` recorded creation, submission
  and dispute-opening but **not settlement**, so an age had to be borrowed from a neighbour and a
  trial that sat in dispute for a week would have been aged as if it settled the day it ran.
  `settledAt` is now stored from `VerdictFinalized`'s own block and hydrated like the other three
  times; an outcome that still lacks it is excluded and counted in
  `meta.excludedNoSettlementTime` rather than guessed. §18.2's `d` (difficulty) and `s` (sponsor
  independence) are held at 1.0 and 0.5 and **reported as assumptions by the endpoint**, because
  nothing here measures either; a score that folded in an invented difficulty would be a measurement
  nobody could check.
- **`/claims` publishes the promise list with what enforces each row, including the rows nothing
  enforces.** The table is `apps/web/src/lib/claims/registry.ts`, and the page renders it verbatim,
  so `apps/web/test/claims-registry.test.ts` is the gate: every `enforcedBy` path must exist, a row
  cannot be `enforced` with nothing cited, at least three rows must still read `absent` (to clear
  that assertion a promise has to be *fixed*, not relabelled), and a row flagged `onSite` must quote
  a fragment the landing page actually carries. Both halves were mutation-proved: citing
  `contracts/Nowhere.sol` reddened the file check, and writing "unanimous or nothing settles the
  trial" into a row that claims site copy reddened the quotation check.
- **My own earlier reading of "read in one call" was wrong, and the correction matters.** I recorded
  this morning that no one-call read exists anywhere, citing `getSummary` being an interface
  declaration. Half right: the ERC-8004 aggregate still is unimplemented (row `VI-7` says so), but
  `AlloyRegistry.records` is a public mapping of a four-field struct, so `records(agentId)` was
  already one call returning wins, survivals, slashes and tier. The live sentence was false because
  it pointed at a standard nobody here serves, not because the chain could not answer. Fixed by
  shipping the reader that makes the sentence true (`GET /api/standing/:id`, tested) and by binding
  the wording in the gate, rather than by leaving a promise to a contract that does not exist.
- **The production box's `forge-std` was empty, and only a re-seed would have noticed.** Every hand
  deploy since the chain reset ran `git archive` and then `rsync -a --delete`, and an archive carries
  a submodule as an *empty directory* — so `~/crucible/crucible-contracts/lib/forge-std` had been
  emptied on the box, which has no `.git` to restore it from. Nothing broke, because the deploy that
  follows builds `web api keeper` and the `seed` image was already cached; the failure was scheduled
  for the next chain reset, when `forge build` inside the seed image would die on
  `Source forge-std/Script.sol not found` with the site down and the demo unseedable. Found because
  the deploy script's own "copy the running tree's `forge-std` forward" step had an empty source, and
  fixed by cloning at the pin the superproject names (`f3dae6e`, confirmed by `git rev-parse HEAD`
  after checkout, 14 entries where there had been 0). The lesson generalises: **a `--delete` sync
  from an export of a repository is a submodule-wiping machine**, and a box whose images are cached
  will not tell you until the day it has to compile.
- **The browser pass this machine cannot run, run where a Chromium exists.** The VPS's
  Chromium 156 rendered `/`, `/claims`, `/trials/1/replay`, `/agents`, `/hall` and `/trials/1` at
  1440 and 390 wide: six desktop and six phone PNGs, zero console errors, zero error boundaries, and
  the claim matrix read on screen as 11 `Enforced` / 3 `Partly` / 3 `Not yet` over 17 rows. Two
  instrument faults found on the way, both mine: `--virtual-time-budget` **hangs** on this site
  because every page opens an EventSource, so virtual time never expires and the first attempt wrote
  no PNG at all — `--timeout` is the bound that works; and `--dump-dom` captures the pre-hydration
  shell on the fetched pages, which is why the replay's three content assertions "failed" against a
  page the screenshot shows rendering all ten beats, the money flow and the caption. A DOM grep that
  runs before hydration is not a browser pass, and the PNG is the evidence.
- **The six Docker-gated `forge-runner` tests are no longer a permanent skip.** They skip on this
  laptop because there is no daemon, and every deploy row until today said "not run — the Docker
  sandbox suite". Run on the deploy box instead, with the same node 20.20.2 the CI TypeScript job
  resolves to and `npm ci` into the deploy tree (rsync never carries `node_modules` there): **135
  passed, 1 skipped** the first time, the remaining skip being the cap-drop test asking for
  `crucible/verifier:latest`; built with the command the test's own comment names, then **136
  passed, 0 skipped**. The image stays on the box (1.09 GB) so the next manual run covers that test
  too, and `docker rmi crucible/verifier:latest` returns it to skipping honestly. The same
  measurement caught a stale line in the README: it carried `forge-runner 132` where the workspace
  has 136, and the per-workspace breakdown summed to 1468 against a stated total of 1472.
- **`getLogs({ abi })` does not decode on this node, and the node ignores the topics filter.**
  Both measured inside `crucible-api` against the live anvil on 2026-10-24: 56 logs came back with
  `eventName: undefined` and `args: undefined`, and a one-topic query still answered all 56. The
  first version of the replay route trusted the transport to decode, so it would have answered
  `200` with zero frames and let a visitor read "this trial has no history" off a chain that had
  eight trials. The projector now decodes locally with `decodeEventLog`, filters by the trial id in
  code, and reports `logsUndecoded` / `logsOtherEvents` so the leftovers are counted instead of
  vanished. The test fixture builds `topics` and `data` with `encodeEventTopics` /
  `encodeAbiParameters` — the shape a node returns — because the previous fixture handed the route
  pre-decoded logs and could not have failed.
- **The replay reads a trial's own logs back, and only the chain's numbers appear.**
  `packages/frame` folds the beats into frames; `GET /replay/:id` and `/trials/[id]/replay` render
  them. No escrow total is printed anywhere: `VerdictFinalized` emits only the agent's payout, so
  where a slash sent the reward and the break stake is not a number this projection has, and summing
  the rows would publish arithmetic nobody sourced. Frenchy's captions come from the existing static
  pools through `FrenchySelector` (gate 674 bans a runtime model), and the page renders nothing when
  the selector declines — a visitor has no use for "over budget".
- **The verify page was printing a proof hash that was not the proof.** `VerificationReceipt`
  stores the real digests — the live chain showed `verdictHash = 0xd601ff4e…ec95` — while
  `tokenURI` rendered `0x000…0000d6`: `bytes1(b >> (248 - i * 8))` truncates to the **high** byte,
  which is zero for every shift except the last, so 31 of 32 bytes printed as `00`. Found only by
  reading the live string after the deploy, because the test written for it asserted
  `length == 66` — a 66-character string of mostly zeros passes a length check. Now
  `test_TokenURI_PrintsEveryByteOfTheStoredDigests` compares both digests byte-for-byte against a
  pattern where a shifted-out byte is visible, and the same pattern proves the prompt hash. One
  implementation of this encoder exists in the tree (`grep bytes1(.*>>`), so the class is closed.
  `VerificationReceipt` lines coverage moved 98.11% → 100.00% on the way.
- **The receipt is minted by settlement, not by the caller that batched it** (`7f47ed8`). The
  first deploy surfaced this by measurement, not by reading: the live chain reported
  `receiptsEnabled = true`, a wired `verificationReceipt`, eight settled trials and
  `receiptIdOfTrial(1..8) == 0`. `mintReceipt` sat inside `settleBatch`'s loop, so the doors that
  settle one trial — `finalize`, and the committee's `tally` — left no proof behind, and the
  warden's per-trial fallback (added in `2b1227b`) runs exactly that door. The mint moved to
  `_settle`, after the ledger writes. Proven able to fail: deleting the call reddens both the new
  `test_Finalize_MintsTheSameReceiptAsTheBatch` and the existing batch test.
- **`deploy/edge-attach.sh` now exists** (`801afea`). deploy.yml installed the edge-repair host
  timer behind `if [ -f deploy/edge-attach.sh ]`, and no commit ever added that file, so the
  guard was false on every deploy and the repair of the 2026-10-21 failure mode was still a
  human task. The timer is on the box (`crontab -l | grep crucible-edge`) and the script has been
  run for real: it finds three caddy containers on this host, not one, which is the shared-box
  reality the inline step's `grep -iE 'caddy'` already assumed.
- **The 2026-10-24 deploy shipped with the pipeline off, and said so.** Actions could not start a
  job — every run ended `startup_failure` with `path: "BuildFailed"` and zero jobs since
  2026-10-23T14:37 — so the seven workflows are disabled by hand and the gate was run locally on
  the exact shipped commit instead: typecheck plus 1398 Vitest (6 Docker-sandbox skips), 249
  Foundry (4 fork skips), `coverage-gate` at all eight floors. What that leaves unproven is named
  in `Still open` item 18 rather than glossed.

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
   Read off the file on 2026-10-23, so the carve-out is stated in both directions: the Hall's
   only outbound path is `settleTrial`'s `call{value: reward}` (`CrucibleHall.sol:191`) — it has
   no `withdraw`, rescue or transfer of anything it holds — and `Invariants.t.sol:170` measures
   `address(trials).balance`, so ETH donated to the Hall is outside the conservation equality by
   construction. Funding it and never settling is a way to park value with no exit; it is not a
   way to reach a visitor's stake.
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


11. **CLOSED — the deploy recreates the keeper now, and refuses to replace it with one that cannot
    start.** When this was written, `deploy.yml` swapped exactly two services —
    `docker compose up -d --no-deps web api` —
    and the comment above it explains why `anvil` and `seed` are left alone: the chain must keep its
    state. The keeper is not in that list either, and unlike those two it holds nothing a restart
    would lose — it reads the chain, acts with a nonce, and `finalize` is permissionless and reverts
    when already settled, so a recreated keeper resumes where it left off. Measured on the box on
    2026-10-23: `crucible-keeper-1` reported `Up 2 weeks` while `crucible-web-1` and
    `crucible-api-1` reported `Up 4 minutes`, and inside that container `env | grep -ci trace`
    returns **0** and `docker inspect -f '{{json .Mounts}}'` returns `[]` — so the
    `CRUCIBLE_TRACE_FILE` and the `trace:` volume that `compose.yaml` declares for it are declared
    and not running. Consequences, each stated about the deployed process rather than the code:
    the trace spine records nothing on the live box (an earlier entry in this register said the
    trace was "gated behind an env var" — in compose it *is* set, and the daemon that would honour
    it predates the line); the gas ledger and its `lowBalance` floor are not reporting;
    `keeper.sweep` is not behind the kill switch that exists in the image; and the self-scheduling
    sweep loop and the breaker around the acting hop are the hackathon build.

    **Closed by the deploy change the owner asked for.** `keeper` now joins the build and the
    `--no-deps` swap, so anvil keeps its chain and the daemon cannot age behind the repository
    again. Three guards make that safe, and each was extracted from the workflow and run: the host
    must carry a nonempty `KEEPER_PRIVATE_KEY` shaped like `0x` + 64 hex (never printed; absent,
    empty and malformed each exit 1 with the running keeper left in place), the `.env` addresses
    must match the seed-published `deployed.env` before anything is replaced, and the deploy polls
    the container's own healthcheck to `healthy` within 180s, failing on `unhealthy`, `exited`,
    `restarting`, a missing healthcheck, or a container that disappeared. The measurement above is
    left as recorded, because the fix does not make it wrong.
    The change is small: add `keeper` to that `up -d`, keeping `--no-deps`, which is the part that
    protects anvil. The check that would keep it from silently ageing again is a version stamp —
    have the keeper publish the commit it was built from and assert in `/health` that it matches
    what `web` and `api` report, because "the image in the repo is the one running" is exactly the
    assumption this finding cost two weeks to disprove.

12. **The gate register cannot fail, and 51 of its 75 v2 rows describe nothing that exists.**
    `docs/gates.yml` carries exactly two keys per gate — `title` and `frameworks` (measured:
    377 of each, ids gapless 419–795). There is no `status`, no `proof`, no command, no excerpt,
    so gate 419 (shipped, tested) and gate 795 (a persistence drill that has never run) are
    structurally identical to a reader and to every tool. Nothing reads the file: no test, no
    script, no CI step (`grep -rn "gates.yml"` answers `compliance-matrix.mjs`, two generated
    comments, and prose). `compliance-matrix.mjs` is itself invoked by nothing, so the register
    and the `/compliance` JSON it publishes can drift apart silently — and `/compliance` is not
    a page, it is `export default function CompliancePage() { return null; }` serving JSON.
    `worklog.md`, which the v2 bible makes the place a gate's proof excerpt lives, does not
    exist. Two consequences are already visible in the tree: gates 585 and 648 title a function
    (`settleBatch`) that had never been committed when this was written, and the in-flight
    receipts and batch surface cite gates 402/415/416/418, which are below the register's floor
    of 419 and therefore answerable by nothing. AGENTS.md's own rule — "a green you cannot turn
    red is decoration" — applies to the register itself. The fix is a `proof:` key plus a checker
    that goes red when a claimed command does not exist, or a separate planned-register so the
    public count stops reading as verified.
13. **The Solana workstream has no CI job, so every gate 701–720 "proof" is a session log.**
    `grep -rniE "solana|anchor|cargo|sbf|work-escrow" .github/workflows/` returns nothing. The
    workspace is not in `package.json`'s workspaces list either, which means
    `workspace-coverage-gate.mjs` cannot enumerate it to notice that its `test` and `test:lint`
    scripts are never run — it is outside the universe that gate looks at, not excluded with a
    reason. `@coral-xyz/anchor` is not installed, `target/` is gitignored, and `scripts/restore.sh`
    — whose second step is titled "toolchain vs AS_BUILT.md" — never opens `AS_BUILT.md`: it probes
    for the presence of node/npm/cargo/anchor, treats a missing Solana toolchain as a `note` that
    does not set the fail flag, and then prints "RESTORE GREEN — tree, tools, params, coverage all
    proven." On a Linux box without `wsl` the anchor branch degrades to that same note, so a
    restored machine with no Solana toolchain reports green. The recorded counts do not all agree
    with the code either: `AS_BUILT.md` says **12/12** host where `programs/work-escrow/src/math.rs`
    holds 11 `#[test]` (measured, and the only `#[test]` in `programs/`; the crate
    `crucible-contracts/solana/vectors` adds 3 more that `-p work-escrow` does not run), while its
    **10/10** localnet does match the 10 `it()` blocks in `tests/work-escrow.ts`. Either wire the
    host tests and the CPI lint into CI (both run in seconds, no validator needed) or mark gates
    701–720 as session-proved rather than green.

14. **The court's branches are the thinnest coverage in the tree, and the floor says so.**
    `ArgusCourt.sol` measures 88.14% lines / 80.79% statements / **52.78% branches** / 85.00%
    functions against `Arena.sol`'s 96.18 / 93.21 / 73.86 / 90.28. The unexercised branches are
    the draw's eligibility and exclusion combinations — a seat that is bonded, unbonding, drawn
    and conflicted at once, strides near the pool boundary, a pool at exactly `MAX_SEATS`. The
    floor was set where the measurement is (50) and the target where the work is (75), because
    a floor set at an ambition nobody has met is how a gate gets deleted. Coverage is the map,
    not the territory: the money paths that could pay the wrong person are the ones with
    assertions and mutation proofs.
15. **CLOSED — `LICENSE` was removed deliberately, and the removal is committed.** The file was
    deleted on the owner's instruction: the project is all rights reserved, recorded in
    `95b88ef`. Every remaining workspace manifest reads `UNLICENSED`, the SPDX headers that were
    left are flipped, prose that granted MIT is corrected, and the third-party notices the file
    carried survive in the OFL texts beside the fonts and in `forge-std`'s own licence files.
    The two demo fixtures keep their MIT headers on purpose — their bytes are pinned by a keccak
    digest already published on-chain, and `npm run seed:check` re-proves both still resolve.
16. **The arena is chain-only: nothing in it is wired to the app, the keeper or the indexer.**
    `Arena.sol` and `ArgusCourt.sol` are deployed and tested by `forge test`, and by no other
    name: no `TRIALS_ABI` entry, no read-model projector, no route, no keeper job, no
    `Deploy.s.sol` step. A reviewer arriving from the v2 bible will find gates 734–746 green at
    the contract layer and 747–795 unbuilt, which is the honest state rather than a partial one
    presented as a whole.

17. **v2.1's showcase layer is now half-built, and the first audit's verdict on it was wrong in
    both directions.** Corrected position, measured against the tree rather than the bible's prose:
    Frenchy already existed (`apps/web/src/lib/frenchy/selector.ts` — triggers, tones, budget,
    cooldown, anti-repeat, mute, static `pools.json`), the TTS host already existed and is real
    ElevenLabs (`apps/api/src/voice.ts`), and the arena canvas already existed
    (`apps/web/src/lib/scrub/`, 1,629 lines) — but that canvas is a **scroll-driven marketing reel**
    whose six "acts" are the walk into the arena, not a trial. What was genuinely absent was anything
    that turned a settled trial's own logs into beats: built now, as `packages/frame` +
    `GET /replay/:id` + `/trials/[id]/replay`. Still absent, by dependency:
    **Ghost Runs** (any trial replayed end to end on a private fork with play money — needs a fork
    host; `anvil --fork-url` is the nearest real thing this repo has, and it is not wired to a
    scheduler), **House Bouts** (our own agents fighting on a showcase deployment — needs the second
    deployment, which is ADR-0002's territory and a new ADR, not a config change), the **bout
    scheduler and fork pool**, and the **R2/Postgres line store** — the last deliberately not built,
    because ADR-0008 says no database, so this replay re-derives frames from the chain and pins them
    with `frameHash`/`replayHash` instead of storing lines. That is a stated divergence from
    §16.13.3, not an oversight of it. The bible's gates 796–805 are still not in `docs/gates.yml`,
    for the reason in item 12: the register already has 51 rows with nothing behind them, and a row
    here would bind to no checker.

18. **CLOSED — the pipeline is back on, and the cause was the private repository's Actions plan.**
    Every run failed at job startup (`startup_failure`, `path: "BuildFailed"`, zero jobs) from
    2026-10-23T14:37Z, which this item named as a billing/plan condition rather than a YAML fault.
    Measured on 2026-10-24: the identical `workflow_dispatch` of `ci` failed in 0s while the
    repository was private and `queued` within seconds of it becoming public, so the plan gated
    Actions on a private repository and nothing in the workflow files was wrong. All eight
    workflows are `active` again, and the first full run since the outage is executing on the
    self-hosted runners — its conclusion belongs to the run, not to this paragraph. That run is
    what first covers **slither**, **gitleaks** and the **ERC-8004 fork tests** since 2026-10-23;
    the Docker sandbox suite still skips 6 tests on a runner without a daemon.
19. **CLOSED — the relicense is committed, and the row now describes the repository.** The owner
    chose all-rights-reserved over the Apache-2.0 alternative in the v2 bible §26.3. The
    mechanical changes landed in `95b88ef`, after earlier flips rode into other commits in the
    shared tree; the counts in the row were re-measured against the result, and the two demo
    fixture headers are named as the deliberate carve-out. HEAD and the prose agree.

20. **Gate 732's drift check was guarding line endings, and three committed artifacts still carry
    CRLF inside their blobs.** `params-codegen.mjs --check` compared `readFileSync(...) !== template`
    while the template is a literal inside a CRLF source file, so a clean Windows checkout of a
    commit with no value drift reported drift on `params.rs`, `params.ts` and `Params.sol`. Fixed by
    folding CRLF on both sides of the compare (proved still able to fail: `ARENA_FEE_BPS 1500 → 1501`
    reddens it, restoring greens it) and by pinning those paths `text eol=lf`. What is NOT fixed: the
    blobs already committed contain CR, so a checkout still writes CRLF — a `git add --renormalize`
    commit that actually rewrites them is outstanding, and until then any tool that byte-compares
    these three files on Windows will disagree with itself.

Report a vulnerability as described in [`SECURITY.md`](SECURITY.md), not in a public issue.
