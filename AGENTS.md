# Agent instructions

Read this before changing anything. Every rule below is load-bearing: each one is here because
this repository was bitten by its absence, and several cite the test or ADR that carries the
decision. Where a rule and an external document disagree, **the code, the tests and
`crucible-contracts/docs/contract-spec.md` win** — that is the spec's own stated precedence.

## What this is

An on-chain proving ground for **AI agents**: sponsors post bountied trials in **native ETH**,
agents stake a bond and submit work, paid skeptics try to break the claim, a fixed 2-of-3 Argus
committee grades disputes, and a serial keeper finalises. Chain: local **Anvil**, chain id 31337.
No database — the indexer is in-memory (ADR-0008). The API holds **no chain key** (ADR-0006).

**The trap:** an external hackathon PRD describes a human marketplace with USDC, Privy, a **15%**
fee and `POST /v1/verify`. [ADR-0001](docs/adr/0001-agent-proving-ground.md) rejects implementing
it. The fee is `FEE_BPS = 500` = **5%**, deducted from the agent's payout at settlement. A change
that "fixes" the fee to 15%, adds USDC, or bolts an ERC-20/ERC-721 onto the escrow is not a feature
request — it is a product pivot requiring a new ADR and a new contract review.

## Money rules that do not bend

- **Settlement never pushes ETH.** `_settle` credits a pull ledger; the recipient calls `withdraw()`
  in a separate transaction. ADR-0003 rejected push-with-try/catch explicitly. A "settle N trials in
  one tx" that pays out on-chain re-opens that decision.
- **The conservation invariant is an exact equality**: `address(trials).balance == totalStakes +
  totalPending + escrowed` (`test/Invariants.t.sol:170`). Any new ETH-receiving party, or any path
  that moves ETH without moving a book, breaks it. Gas is the network's toll and never enters this
  accounting — the escrow has no `receive()` and cannot passively take ETH.
- **`finalize` and `reclaimExpired` are permissionless** and revert when already settled. That revert
  *is* the idempotency guarantee; per-trial error isolation lives in the warden
  (`packages/warden/src/warden.ts:18-21`: one bad trial must not stop the others). Do not add a
  privileged minter/settler role — the design deleted that privilege on purpose.
- `Trial` is 16 packed fields under `via_ir`; adding one re-triggers the stack-too-deep constraint.
- Contracts build with **no external dependency** (only `forge-std`). Adding OpenZeppelin is an
  architecture change, not a package install.

## Verification — run the command CI runs

```bash
npm run verify:all          # typecheck + every workspace suite
npm test                    # all workspaces + Foundry; currently 1773 tests (1503 TS + 270 Foundry)
cd crucible-contracts && node ../scripts/run-forge.mjs test   # forge is not on PATH; run-forge resolves it
node ../scripts/run-forge.mjs build --sizes                   # forge test does NOT compile script/ —
#   a broken deploy script is green under `forge test` and only `forge build` catches it. Measured
#   the hard way on 2026-10-24: `script/GoldenPath.s.sol` stopped compiling, 266 tests stayed green,
#   and the seed image build on the deploy box was the first thing to say so.
node scripts/run-forge.mjs coverage --ir-minimum --report summary | tee coverage-summary.txt
node scripts/coverage-gate.mjs coverage-summary.txt           # per-contract floors, not the Total row
```

- `npm run format:check` is **red repo-wide on a Windows checkout** and is not a CI gate:
  `.gitattributes` pins `eol=lf` only for content-addressed fixtures, so the working tree is CRLF
  while blobs are LF. **Never run `prettier --write` across the tree** — it converts every file and
  buries a real diff under 1000-line noise.
- `crucible-contracts/fixtures/trials/**` is digest-pinned on-chain. Changing one byte of those
  files changes a keccak digest that was published to the chain.

## Gates must be able to fail

- **Mutation-prove every branch you add or rely on**, and say in the report which checks were proven
  and which were not. A green you cannot turn red is decoration.
- **Never re-run a red money gate to get a green.** If `invariant_balanceConservation` fails, the
  promotion refusal is correct behaviour. CI captures `cache/invariant` on failure precisely because
  a printed fuzz seed has been shown *not* to reproduce here — treat a non-reproducing red as open,
  not as noise, however many rolls pass afterwards.
- A timeout/cancel test must assert the **end state** (container gone, row absent), not that the
  caller stopped waiting. This repo had a green test of that exact wrong shape.
- Same commit, green then red, is a measurement claim about your instrument. Name the quantity the
  test depends on before relabelling it "flaky" — one gate here asserted `Math.random()` output and
  failed 1 run in 65.
- **A wiring check must read the command that runs, not the file's prose.** A
  `includes("--strict")` assertion written over `scripts/install-tool.sh` stayed green after the
  flag was deleted from the `sha256sum` line, because the script's comments explain the flag and
  contain the string. Filter comment lines, or match the executed statement. The same trap is why
  "the package is named in a `src` file" is not evidence it is imported — say which file imports
  it, and assert the import.

## Display rules a judge reads against

- **A figure is read or it is not shown.** Unknown renders `—`, never `0`; zero is a measurement,
  nothing is not (`clock.ts`, `ops.ts`, `api.ts` all enforce this).
- **Plain words at the action, no jargon**: `5% · 500 bps`, not `500 bps`; "test ETH worth nothing"
  not "Anvil/31337/wei". `apps/web/test/demo-notice.test.ts` bans the builder's vocabulary in the
  money warning and greps source because there is no React renderer here.
- Money never crosses a float. Minimums round **up** (printing short causes `StakeTooSmall`);
  payouts and credits **truncate** (printing up overstates what the chain holds). `formatEth`
  parses digits, not doubles, for exactly this reason.
- Any UI change is verified in a browser at the real URL, not by the test suite alone.
- **A root-level `loading.tsx` renders above the providers, not inside them.** Next composes
  `app/loading.tsx` around `/_global-error` — the one document that exists *because* the layout, and
  with it `WagmiProvider`, is the thing that failed. The first version wrapped the page in `Chrome`,
  which reads the connected account, and `next build` died prerendering that route with
  `useConfig must be used within WagmiProvider`. `loading.tsx` under a route (`/trials`, `/agents`)
  keeps the full chrome, because those always render inside the layout. The root one and
  `global-error.tsx` must import nothing that touches the wallet.

## Records that must be updated, not left to rot

- `HARDENING.md` — "verified" and "still open" sections. When you close a finding, name the commit.
  When you edit a file it cites, **re-check the line numbers**; they rotted once this session.
- `docs/since-submission.md` — append a dated row per shipped change. A judge uses this table to
  see what happened after the hackathon window; it had fallen two days behind once already.
- `README.md` numbers (test counts, coverage) are measured from a run, never carried forward.

## Git and the ladder

- `develop → staging → main → deploy`. **Merging into `develop` is the deploy.** Nothing else ships.
- PRs, via `gh`. Merging a parent with `--delete-branch` **closes** any PR based on it — a dependent
  PR cannot be reopened or retargeted once its base is gone. Stack knowingly or don't stack.
- Commit verified slices immediately; other agents and other sessions share this tree, and a stray
  `git reset` has already destroyed uncommitted work here once.

## Windows / Git Bash, so you do not lose an hour

- `cd` does **not** persist between commands; prefix every git statement in a chain.
- `grep` for non-ASCII (`✓`, Arabic) silently matches nothing through this shell; write logs to a
  file inside the workspace and read them with a file tool (`/tmp` is invisible to Node and Python).
- `git show rev:.github/...` gets rewritten by MSYS path conversion — export `MSYS_NO_PATHCONV=1`.
- `next dev` rewrites `apps/web/tsconfig.json` (to `"jsx": "preserve"`) and `next-env.d.ts`. **Revert
  both before committing.** Its child process also survives a stopped task — kill the PID on the port.
- `git submodule deinit` inside a worktree uninitialises the submodule in the **shared** config and
  breaks the main tree's Foundry build. Remove stray worktrees with `rm -rf` + `git worktree prune`.
- Never pipe a long gate through `tail`/`grep` and trust the exit code — it is the last stage's.

## Do not

…stub, mock or fake anything on a runtime path (a fake shape is a measurement reporting empty);
silently skip a step that could not run; add a second formatter, second clock, or second source of
truth beside one that exists; edit `docs/adr/*` to make an ADR agree with new code instead of
writing a new one; "improve" a file the task did not touch; or delete a branch, force-push, or
deploy without being asked.
