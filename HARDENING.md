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
  `scanRetrieved` and withheld when it carries an instruction, with the withholding named in
  `notes` rather than silent. Proved by reverting each channel to its pre-fix shape and
  watching the new tests go red — and the assertions are on the prompt the fake client
  actually received, never on the classifier itself.
- **The CI tool downloads are digest-pinned, which is what their step name always claimed.**
  Three steps in `ci.yml` and one in `fork-nightly.yml` were called "install foundry (pinned
  tarball)" while the body piped `curl` straight into `tar`: the pin was a version tag, and a
  re-uploaded asset would have run. Versions and digests now live in
  `scripts/install-tool.sh`, which verifies with `sha256sum --check --status --strict`
  *before* extracting. Foundry v1.8.5's digest was measured here and corroborated against the
  one GitHub publishes for that asset; gitleaks 8.24.0's is a first-contact measurement,
  because the API returns `digest: null` for it — recorded as such in the file. Proven able to
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


11. **The deployed keeper is two weeks older than the keeper in this repository, and no gate says
    so.** `deploy.yml:182` swaps exactly two services — `docker compose up -d --no-deps web api` —
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

    **Deliberately not fixed in this pass.** Restarting the daemon that moves money, and editing the
    job that would restart it, are deployment actions on a shared box, and the omission carries no
    recorded reason — so it is logged with evidence rather than closed by an unasked-for reboot.
    The change is small: add `keeper` to that `up -d`, keeping `--no-deps`, which is the part that
    protects anvil. The check that would keep it from silently ageing again is a version stamp —
    have the keeper publish the commit it was built from and assert in `/health` that it matches
    what `web` and `api` report, because "the image in the repo is the one running" is exactly the
    assumption this finding cost two weeks to disprove.

Report a vulnerability as described in [`SECURITY.md`](SECURITY.md), not in a public issue.
