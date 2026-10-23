---
# What shipped after the submission

Colosseum judges the work done during the hackathon window. Everything in
this file is **after** that window, and the exact submitted commit is tagged
`cwf-submission` so a judge can diff the two directly:

```bash
git diff cwf-submission..HEAD --stat
```

The tag points at `dd52c07` — the last commit on the branch while the window
was open (2026-10-12). Nothing after it is presented as in-window work.

| Date | Shipped | Where to see it |
|---|---|---|
| 2026-10-21 | Coinbase CDP tooling: both CLIs installed, Qoder skills installed, `npm run cdp:sandbox` configures the Sandbox profile from a key file and lists accounts without printing it | `scripts/cdp-sandbox.mjs`, `docs/runbooks/coinbase-sandbox.md`, `.env.example` |
| 2026-10-21 | Coinbase Wallet is an explicit connector (classic Coinbase Wallet SDK) and appears in the no-WalletConnect fallback; the ladder now waits for the CI run it dispatches and asks for the next step only when green | `apps/web/src/lib/wagmi.ts`, `apps/web/src/components/Wallet.tsx`, `.github/workflows/promote.yml` |
| 2026-10-21 | The CID store's eviction order depended on millisecond-resolution mtimes; whole-second filesystems tied a new entry with its predecessor and sorted by content hash. The stamp step is one second now | `packages/cidstore/src/store.ts`, `packages/cidstore/test/store.test.ts` |
| 2026-10-21 | The indexer read its normal caught-up cursor (`head + 1`) as a chain reset and rebuilt on every idle tick, emptying the hall and flipping readiness. The reset check is now beyond `head + 1`, with a regression test | `packages/indexer/src/scribe.ts`, `packages/indexer/test/scribe.test.ts` |
| 2026-10-21 | The site was 502 with every container healthy: the shared edge had detached from `crucible_default`, and the repair cron's `/var/log` redirect failed as an unprivileged user. Edge reattached; cron now logs to the deployment user's home | `deploy/edge-attach.sh`, `.github/workflows/deploy.yml` |
| 2026-10-21 | Frenchy, the optional voice host: ElevenLabs behind an API proxy, muted by default, once a day, paid verdicts only, silent on failure, reduced-motion aware | `apps/api/src/voice.ts`, `apps/web/src/components/VoiceControl.tsx`, `apps/web/src/lib/voice.ts` |
| 2026-10-21 | The PRD audit's real gaps: self-claims and the escrow cap on claim/break, canonical reputation backfill, a read model that publishes free stake/active/runner, a runner that refuses test-touching patches, an exact three-judge rubric, and a withdraw control in the header | `CrucibleTrials.sol`, `ReputationBridge.sol`, `packages/indexer/src/model.ts`, `packages/forge-runner/src/runner.ts`, `packages/argus/src/rubric.ts`, `apps/web/src/components/Chrome.tsx` |
| 2026-10-12 | Cursor persistence in the indexer, so a restart does not re-scan the chain from the beginning | `packages/indexer/src/scribe.ts` |
| 2026-10-21 | The backfill-cost gate stopped asserting wall-clock. It ran on the host that also serves production, where the fixed code measured 41.8 seconds against a laptop's 2.5 milliseconds, so a thrashing box failed a gate about code that had not changed | `packages/indexer/test/model.test.ts` |
| 2026-10-21 | The promotion ladder ran again. A merge conflict could not be resolved by the job, and a promotion could not ask for the next gate — so the ladder had been stopped for eight days, and production kept serving an eight-day-old build | `.github/workflows/promote.yml`, `docs/pipeline-ledger.md` |
| 2026-10-21 | The shared edge was reattached to this stack. It is a proxy another project on the same box owns, and a recreate of it dropped the attachment, so every request answered 502 while every container here reported itself healthy | `.github/workflows/edge.yml`, `docs/setup.md` |
| 2026-10-21 | The live feed stopped spending the read budget. A stream is one request that holds a socket open, and charging it against a per-minute budget meant a few idle tabs exhausted it and the reads that mattered started answering 429 | `apps/api/src/app.ts`, `apps/web/src/lib/useSnapshot.ts` |
| 2026-10-21 | Every route serves one snapshot. They each built their own, and the stream carried the settlement fee while `/snapshot` did not, so a refresh and a live update described the same chain differently | `apps/api/src/app.ts` |
| 2026-10-21 | The platform publishes its books: the volume, the fee and the payout, with the fee read from the contract rather than copied into the process | `packages/indexer/src/api.ts`, `apps/web/src/app/docs/page.tsx` |
| 2026-10-21 | The demo has a trial a visitor can claim, and one waiting for a run. It was four settled trials — a hall worth reading and nothing to do | `crucible-contracts/script/Extend.s.sol` |
| 2026-10-21 | The secret gate: the whole git history is scanned for leaked keys, and every suppression states what the value is and why it is not a secret | `.github/workflows/ci.yml`, `.gitleaks.toml` |
| 2026-10-21 | The indexer stopped freezing on a quiet gap, stopped advancing past a truncated response, and rebuilds after a chain reset | `packages/indexer/src/scribe.ts` |
| 2026-10-21 | The sign-in stopped taking its origin from a request header, and a challenge is now bound to the browser that asked for it | `apps/api/src/auth.ts` |
| 2026-10-21 | The rate limiter stopped reading the forwarded hop a caller writes, and stopped putting every visitor behind the proxy in one bucket | `apps/api/src/rate-limit.ts` |
| 2026-10-21 | The read model stopped moving a trial backwards, and stopped losing a verdict for a trial the index had not seen | `packages/indexer/src/model.ts` |
| 2026-10-21 | The deployment proves itself: a post-deploy assertion reads the live chain and fails the deploy if the fee, the bond rule, the committee, the roles or the money invariant are not what the documentation claims | `crucible-contracts/scripts/assert-deployment.sh` |
| 2026-10-21 | Every key this project uses, and every power an address holds, written down — with what a compromise reaches and what changes on a real chain | `docs/key-inventory.md` |
| 2026-10-21 | The escrow contract rejects empty spec/test CIDs, zero runner keys, zero run hashes and zero break proofs, and caps a single reward and total escrow | `crucible-contracts/contracts/CrucibleTrials.sol`, `crucible-contracts/test/CrucibleTrials.t.sol` |
| 2026-10-21 | The API answers the Kubernetes-style `/healthz` and `/readyz` aliases with the same readiness contract as `/health` and `/ready` | `apps/api/src/app.ts`, `apps/api/test/app.test.ts` |
| 2026-10-21 | `npm test` finds Foundry even when it is installed outside PATH, and `npm run verify:all` is the one command that runs typecheck plus every suite | `scripts/run-forge.mjs`, `crucible-contracts/package.json`, `package.json` |
| 2026-10-21 | A machine-readable security contact is published at `/.well-known/security.txt` | `apps/web/src/app/.well-known/security.txt/route.ts` |
| 2026-10-21 | The four ERC-8004 fork tests now report as **skipped** when there is no fork, not as four green tests that asserted nothing | `crucible-contracts/test/Fork.t.sol` |
| 2026-10-21 | `forge coverage` runs and gates the build: 97.4% of lines in `CrucibleTrials.sol`, 95.8% of statements, 89.9% of branches | `crucible-contracts/package.json`, `.github/workflows/ci.yml` |

<!-- Backfilled on 2026-10-23: this table had fallen two days behind the ladder, which is the one
failure mode a document like this cannot have. Rows are grouped by what a reader would go and look
at, not by commit. -->

| 2026-10-22 | The contract's newest exit had no watcher: an unclaimed trial could hold the escrow cap forever. The warden reclaims past `deadline + grace`, and `Warden.start()` takes a required chain-clock seam so the host wall clock is unreachable from it | `packages/warden/src/policy.ts`, `packages/warden/src/warden.ts`, `apps/keeper/src/main.ts` |
| 2026-10-22 | Four path-level repairs in the same pass: the cursor write is temp-with-pid then `renameSync`, the registry fan-out is batched at eight instead of one unbounded `Promise.all`, `syncStalled` became its own fact so a cold backfill stops reporting 503, and a block timestamp the node refused is re-applied on a tick with no events | `packages/indexer/src/scribe.ts`, `apps/api/src/app.ts`, `apps/api/src/server.ts` |
| 2026-10-22 | A required bond is never printed short and an amount is never printed high: the wizard computes in `bigint` and rounds up at display precision, and `formatEth` truncates instead of rounding through `toFixed` | `apps/web/src/lib/wizard.ts`, `apps/web/src/lib/forge.ts` |
| 2026-10-22 | `FEE_BPS` is declared before the sweep that reads it and retried until it lands — one boot-time blip had left the published fee `null` for the life of the process | `apps/api/src/server.ts` |
| 2026-10-22 | The `isArgus` ABI entry a merge silently dropped is restored, and the ladder's unparseable and mis-scoped `permissions:` keys moved to where GitHub accepts them | `packages/smith-sdk/src/abi.ts`, `.github/workflows/promote.yml` |
| 2026-10-22 | The project got its **own** edge instead of a block inside another site's config, and the repair that used to live in the shared edge was retired with it | `deploy/edge/`, `docs/setup.md`, `docs/security-headers.md` |
| 2026-10-22 | The sandbox timeout test now asserts the container is gone rather than that the caller stopped waiting — it had been green while the workload ran to completion | `packages/forge-runner/src/sandbox.ts`, `packages/forge-runner/test/sandbox-docker.test.ts` |
| 2026-10-22 | Dependencies: Next 15.5 → 16.4, TypeScript 5.9 → 7.0, and the patch-and-minor group | `package-lock.json` |
| 2026-10-23 | The hardening register was reconciled against the tree: the ten findings it called open were checked one at a time, seven were closed by named commits, and one was measured wrong and is corrected rather than preserved | `HARDENING.md` |
| 2026-10-23 | Two live money-display bugs: `formatEth` truncated *after* `Number()`, so one wei short of an ETH printed as `1 ETH`; and the Break board advertised its minimum stake through `toFixed(6)`, which can round below the contract's floor | `apps/web/src/lib/forge.ts`, `apps/web/src/app/bounties/page.tsx`, `apps/web/test/eth.test.ts` |
| 2026-10-23 | The UI counts against the **chain's** clock: `/snapshot` publishes `headTimestamp` and every countdown and window test anchors on `max(headTimestamp + 1, serverNowMs)` — the rule the node uses to stamp its next block | `packages/indexer/src/scribe.ts`, `apps/web/src/lib/chainClock.ts`, `apps/web/src/lib/useSnapshot.ts` |
| 2026-10-23 | The keeper now says what it has spent: gas taken from each receipt, its wallet balance, and an optional floor that raises `lowBalance`. A cost it cannot learn is reported as unresolved, not as zero, and none of it enters escrow accounting | `apps/keeper/src/gas-ledger.ts`, `apps/keeper/src/main.ts` |
| 2026-10-23 | A red contract campaign now leaves evidence: a run-id seed echoed as a literal replay command, one worker, and `cache/invariant` uploaded on failure — because a printed seed has not yet been shown to reproduce a failure here | `.github/workflows/ci.yml` |
| 2026-10-23 | The backoff test was asserting a `Math.random()` draw and failed about one run in sixty-five; it now pins the draw and checks the doubling schedule it never actually checked | `packages/smith-sdk/test/resilience.test.ts` |
| 2026-10-23 | Reviewer-facing numbers measured rather than carried: **1166 tests** (1031 TypeScript + 135 Foundry), and coverage restated from the run CI gates — `CrucibleTrials` 97.5 / 95.9 / 90.2, `AlloyRegistry` 97.0 / 97.2 / 92.3, `ReputationBridge` 94.3 / 93.0 / 82.4, `CrucibleHall` 93.2 / 92.1 / 72.2 | `README.md` |
| 2026-10-23 | `/assay` states the fee in the words a visitor reads — `5% · 500 bps` — keeping the chain's own unit beside it so the figure stays checkable | `apps/web/src/lib/ops.ts` |
| 2026-10-23 | Every route now answers while it is reading, in its own words: ten `loading.tsx` boundaries name what is being fetched (`reading the board from the chain`, `reading this trial and its settlement from the chain`) instead of leaving a visitor on a page that looks dead. The root one is deliberately free of the navigation chrome — Next composes it around `/_global-error`, above the providers, and the first version of it broke `next build` with `useConfig must be used within WagmiProvider`. Red before the fix, green after, measured on the production build | `apps/web/src/app/loading.tsx`, `apps/web/src/components/RoutePending.tsx` |
| 2026-10-23 | A fault above the providers now has a page of its own, and it does not print the error it caught: `global-error.tsx` renders the forge's own crack panel, and both paths were forced in a browser — a server-side layout fault is answered by Next's document (nothing here can leak through it), a client-side one replaces the tree on the stylesheets the page already loaded. The panel came up on `rgb(21, 18, 16)` with its heading in `rgb(207, 65, 50)` — the forge surfaces, not a white screen — and no module path or wallet-library string appeared in what the visitor received | `apps/web/src/app/global-error.tsx` |
| 2026-10-23 | The board is bounded and says so. `/trials` draws at most 50 trials per page, a visitor's "show more" click is floored to a whole page rather than trusted, and the withheld rows are counted out loud (`showing 50 of 137, newest first — 87 more behind`). The fetch stays the whole snapshot, so the live counters keep working; only the render is bounded. Mutation-proved: removing the clamp turns three of the eight new tests red | `apps/web/src/lib/paging.ts`, `apps/web/src/app/trials/page.tsx` |
| 2026-10-23 | `AGENTS.md` — the rules this repository learned the hard way, each with the test or ADR that carries it: the 15%/USDC PRD trap, the conservation equality that gas may never enter, `finalize`'s revert as the idempotency guarantee, never re-running a red money gate, and the Windows/Next traps that cost an hour each. Written for the next agent, because the last three of those were found by re-deriving them from scratch | `AGENTS.md` |

## The shape of the outage

The pipeline stopped for eight days without saying so. The site kept serving
yesterday's build, and yesterday's build looked exactly like today's.

Each of the faults was a **measurement or a mechanism that assumed a quiet,
ideal world**: a timer that assumed a loaded machine still ticks at the speed
of a laptop; a merge that assumed the branches had not been edited from two
directions; a push that assumed the next stage was listening; a watchdog that
ran on the deploy pipeline and so could not notice a deploy on another
pipeline; a limiter that counted its own long-lived connections as a request
flood; a challenge that could be completed by any browser that learned a
nonce.

The fixes are the same shape. A copy count instead of a clock. A rule about
which side wins instead of a hope that they agree. An explicit request for
the next gate. A cron entry on the box that runs whether or not this
repository is touched.
