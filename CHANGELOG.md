# Changelog

All notable changes to Crucible. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Versioning note:** `0.x` releases are pre-stable. The contracts hold real ETH in
escrow with no upgrade or pause path, so a breaking contract change is a redeploy, not a
migration. See [`SECURITY.md`](SECURITY.md) before deploying value.

## [Unreleased]

### Added

- **The content layer exists on the producing side.** `@crucible/forge-runner` gains
  `ContentService`: `pinText` / `pinSuite` hand back the keccak digest a sponsor must put on
  chain, `fetchSpec` resolves a digest or a cid back to bytes through the disclosure,
  `fetchSuite` unpacks a pinned tree into the bench, `uploadRepo` pins what the bench holds,
  `uploadLogs` pins the log text, and `publishArtifact` announces a run under its chain run
  hash together with the signature and deadline `submitRun` throws away. Until now all four
  `RunnerDeps` content functions existed only as inline fakes in another package's tests, so
  every `specCID` / `testsCID` / `repoCID` in an artifact named bytes that were stored
  nowhere. Two properties are asserted rather than assumed: a pinned spec answers to the
  digest the chain would hold and resolves in a second process over the same directory, and a
  suite entry named `../../outside.sol` is refused before anything is written — the sponsor
  picks the paths, so paths are the untrusted part of a trusted pin.
- **A hash-chained trace spine, with a real producer.** `@crucible/smith` gains
  `TraceLog`: append-only JSONL where each entry seals keccak over RFC 8785 canonical JSON
  of itself plus the previous hash, using the same canonicalization rule as the run
  artifact. Opening a file verifies the whole chain first and refuses to extend a broken
  one; appends are serialized through one promise chain so two callers cannot fork the
  chain; a span carrying a `bigint`, `undefined` or a non-finite number is refused by name
  rather than sealed over bytes JSON would silently change. The keeper writes it when
  `CRUCIBLE_TRACE_FILE` is set (compose does, on a named volume): `keeper.start`,
  `keeper.sweep` only when it actually acted, and one `keeper.act` per finalize, reclaim or
  skip with the trial id, reason and tx hash. Appends are guarded, so a trace write that
  fails costs a line, not a settlement. Tests cover editing an entry, swapping two,
  appending to a tampered chain, resuming after restart, fifty concurrent appends, and a
  crash-truncated last line; mutation-proved by disabling the content check and by
  removing the append queue. **Stated limit, asserted as a test:** truncating the tail
  leaves a chain that still verifies, because nothing anchors the head outside the writer.
  This records keeper actions only — there are no `warden.gate.*` spans to emit, since no
  service runs those gates yet.

- **Four gates that can actually fail, each mutation-proved.** `forge coverage` has
  no threshold flag (checked against 1.8.5), so the coverage step was `forge coverage | tee
  file` — a pipeline that reports `tee`'s exit code and cannot go red. It now runs
  `scripts/coverage-gate.mjs`, which fails on a dropped floor, on a production contract
  vanishing from the report, on an unparseable table, and on a missing file, and reports
  `CrucibleHall` at 72% branches as under target rather than excusing it. Dependency audit
  moved from an inline `node -e` blob to `scripts/audit-gate.mjs`: it refuses a payload
  without an `auditReportVersion` and reconciles 26 entries against npm's own total
  (`{}` used to print "only documented advisories" and pass), and every documented name
  now carries a severity ceiling, so `viem@critical` is no longer excused by a prefix
  match. The `fork` job says SKIPPED in its own summary instead of a quiet green, and
  `fork-nightly.yml` runs those tests on a schedule and fails if the credential is missing
  or the suite reports zero passing. `extend-demo`'s final check now distinguishes "open
  trials 0" from "I could not read the API" — previously an unreachable API fell through an
  empty `sed` match to the success branch and exited 0.
- **EIP-712 digest parity with the contract source.**
  `packages/smith-sdk/test/eip712-parity.test.ts` (14 tests) parses the `Run` encode-type,
  the domain typehash and `submitRun`'s digest formula out of `CrucibleTrials.sol` and
  asserts viem's `hashTypedData` reaches the same bytes, field order included. Reordering
  two struct fields in the contract turns five of them red. The source comment that cited a
  `test/abi-parity.test.ts` which never existed now names this file.
- **One shared clock for every live stream.** `/stream` gave each subscriber its own
  one-second sleep and its own signature comparison, so a change waited up to a full tick
  to be noticed and the per-tick work grew with the audience. `apps/api/src/tick-pump.ts`
  reads the shared read model once and wakes every waiter in one pass; the pump is
  refcounted off the existing stream-slot release, so one interval serves any audience and
  none runs when nobody is watching. A visible chain change now reaches a subscriber in
  ~200ms. `SCRIBE_POLL_MS` is exposed (floor-checked, default 2000ms) and set to 500 for the
  compose demo, where the node is a container on the same network — that poll, not the
  stream, was the dominant term in how long a visitor waited.

- **The phone header has a real hamburger and compact wallet labels.** The
  menu button shows a three-line glyph and drops the word "Menu" below 520px;
  the injected and Coinbase wallet buttons shorten to "Connect" and "Coinbase"
  at the same width. At 320px the header height fell from 189px to 131px, the
  nav sheet still opens, and there is no horizontal overflow. The tests and the
  local 320/390px browser check cover it.

- **Coinbase CDP CLI and a Sandbox profile for agents.** Both the Advanced Trade
  `coinbase` CLI and the custodial `cdp` CLI are installed, the Qoder skill set is
  installed (`coinbase*`, `cdp-*`, and the root `coinbase-agent-skill`), and
  `npm run cdp:sandbox` imports a Sandbox key and lists its accounts without ever
  printing the key. The profile refuses to run until the key file is supplied.
  Sandbox and live keys can coexist in one `.env`: `CDP_ENV` selects the profile,
  `CDP_ENABLE_LIVE=0` keeps the demo on sandbox, and live is refused unless the
  flag is explicitly enabled. A mode can use either its key-file path or its
  inline `CDP_*_API_KEY_ID`/`CDP_*_API_KEY_SECRET` pair; the wrapper resolves the
  `cdp` binary from npm's global bin when PATH does not. CDP Sandbox is simulated custodial testing, not a
  Base testnet; x402 remains a live USDC rail. See
  `docs/runbooks/coinbase-sandbox.md`.
- **Coinbase Wallet is a first-class connector.** The web app now includes the
  classic Coinbase Wallet SDK connector in its wagmi config and shows a
  Coinbase Wallet button in the no-WalletConnect fallback, alongside injected
  wallets and WalletConnect. The connector-presence test pins it. Base Account
  and Solana/DeFi paths remain out of scope: this product has no Solana program
  and no token/swap surfaces.
- **Frenchy, the optional voice host.** A server-side ElevenLabs proxy with a
  muted-by-default control, a once-a-day automatic policy, a paid-verdict-only line,
  silence on every failure, and reduced-motion handling. The key stays in the API;
  a missing key or voice id hides the control and changes nothing else. See
  [`README.md`](README.md#the-voice-host-optional) and
  [`apps/api/src/voice.ts`](apps/api/src/voice.ts).

### Fixed

- **`/trials` and `/agents` are pageable, and the default is not to page.** The cursor is an
  item id rather than an offset — on a chain that only grows, "row 10 onward" is a different
  set of rows on every request — and `page` reports `returned`, `total`, `truncated` and
  `nextCursor`. No limit returns the whole list on purpose: a silent cap is a lie of
  omission, and a monitor counting trials would read a truncated page as a shorter chain and
  call it healthy. A limit outside 1..500 is a 400, and a cursor that has aged out of a
  filtered list restarts from the top and says so rather than blaming the client for the
  chain moving.
- **Checked, not added, on the rest of the list.** Rate limiting (per-peer buckets plus the
  200-stream ceiling), exponential backoff (`withBackoff`), a bounded RPC queue
  (`RpcThrottler`), a circuit breaker with an operator kill switch, a dead-letter ring, the
  per-tick snapshot cache and the per-agent alloy TTL cache all already exist and are covered
  by tests. The N+1 the list implied is not there: `alloyState` is one synchronous cache read
  per agent, not a call per agent, and the indexer shards `getLogs` and caps blocks per tick.
  Two things were deliberately not built: ETags, because every response is `Cache-Control:
  no-store` by design and a browser that is told not to store never revalidates — the header
  would be decorative or would weaken a money-state guarantee; and a job queue, because the
  API is a read service with nothing to enqueue.

- **Frenchy no longer re-synthesises a line the tab already has, and starts sooner.**
  Every moment was a fresh round trip; the copy is fixed, so a repeat cost the same as the
  first and the greeting waited behind a synthesis before any sound. Clips are now held for
  the session, keyed by moment (and by the text for the one open-ended line), with
  concurrent asks for the same clip sharing one request and failures deliberately not
  cached. The greeting is warmed as soon as the host is known to be on. Tests cover
  repeat-from-memory, three simultaneous asks collapsing to one request, a failure retried
  rather than remembered, and separate keys for caller text; mutation-proved by bypassing
  the cache and watching exactly those two fail.
- **The docs page explains the product instead of naming it.** It was accurate and
  unreadable — "pinned CID", "RunArtifact", "ERC-5192", "settlement logs" — and carried no
  instructions. It now says what the place is, what a person can do here in order, how a
  decision is actually reached, what it costs, and a vocabulary list that translates each
  forge term in the same breath. It also states the honest limit of this build: demo
  trials were posted before anything pinned their content, so a challenged demo trial goes
  to the committee rather than to a re-run.

- **The index could be frozen forever by a log from another contract.** Reproduced on a
  live demo chain: running `script/Demo.s.sol` a second time deploys a second
  `CrucibleTrials`, which emits the same events with the same topic0s from a different
  address. Every block it touched matched the logs bloom, the address-filtered `getLogs`
  correctly returned nothing, and `proveQuietThrough` stopped on that same block on every
  tick — `/health` sat at `ok:false` with `indexedTo` pinned at 54 while `head` was 91, and
  the live view could never take another event. The proof now confirms a bloom hit against
  the block's own logs without the address filter: a same-signature log that belongs to
  nobody we index means the block is quiet for us and the walk continues; a log of ours, or
  a bloom the node contradicts, still stops the cursor exactly as before. On the frozen
  chain the same process went from `ok:false 54/91` to `ok:true 92/91` without a restart of
  anything but the API. Covered by a mock-node test that fails on the previous behaviour,
  with the two anti-truncation tests still green. Also removed `windowIsQuiet`, an
  unreferenced private method that encoded a second, different proof rule.
- **The keeper no longer signs with a publicly known key by default.** `PRIVATE_KEY ||
  DEMO_RELAYER_KEY` fell through whenever compose set `PRIVATE_KEY` to the empty string,
  which is exactly what the VPS override does, so the deployed keeper ran on Anvil's
  published dev key #0. It now uses that key only when the node itself answers
  `eth_chainId` with 31337 over a loopback host, and otherwise refuses to start naming the
  variable to set. An unreachable loopback node fails closed.
- **The long-running services come back on their own.** `compose.yaml` set no `restart:`
  on any of them, so Docker's default `no` applied and a crash or a host reboot left the
  site down with nothing finalizing or refunding trials. `anvil`, `api`, `keeper` and `web`
  are `restart: unless-stopped` with `json-file` log rotation (~30MB per service); the
  one-shot `seed` deliberately stays `restart: "no"`, because re-running it double-seeds.
- **`crucible/verifier:latest` was described as digest-pinned.** The comment claimed a pin
  the value does not provide; it now says what is true — the isolation holds either way,
  and reproducibility would require publishing by `@sha256:`, which is not done.

- **The RPC-breaker test no longer flakes on a loaded runner.** It waited 5
  seconds for three backed-off failures to trip the breaker, which is a
  wall-clock budget on a shared self-hosted box. The wait now has 20 seconds and
  the tests have 30; a breaker that never trips still fails the test.

- **The promotion ladder now waits for the gate it dispatches.** A
  `workflow_dispatch` CI run's completion did not reliably raise the next
  `workflow_run`: the ladder reached `staging`, the gate passed, and no
  `staging → main` run appeared; the deploy trigger had the same hole. The
  promotion now finds the run it dispatched, waits for it by id, and dispatches
  the next promotion or deploy only when it is green. A red gate stops the
  ladder instead of silently leaving production behind.
- **The one-write marker is set before the registry call.** `reportedTrial` was
  written after `giveFeedback`, which left a reentrancy window in which a
  configured registry could publish the same trial twice. The marker is now set in
  the same transaction before the call; a revert rolls it back, and a reentrant
  call sees it. Slither's `reentrancy-no-eth` finding is closed by the ordering.

- **The content store's eviction order depended on filesystem timestamp precision.**
  Entries were stamped one millisecond apart, but a whole-second mtime filesystem
  rounds two publications into the same stamp, and the tie-break is the content hash.
  A CI run caught the new entry sorting before the one it should follow. The stamp
  step is now one second, which survives whole-second mtimes and costs the same single
  `utimes` call. Covered by a test that truncates every mtime to a whole second.
- **A caught-up index was mistaken for a chain reset, forever.** The cursor names the
  next block to read, so a fully indexed chain sits at `head + 1`; the reset check used
  `cursor > head`, matched that normal state, cleared the model and restarted the
  backfill on every idle tick. The hall emptied, `/ready` flipped between true and
  false, and the site looked half-alive. The check now treats `head + 1` as caught up
  and only rebuilds beyond it. Covered by
  `keeps its model when the cursor is simply one past the head`.

- **The site could answer 502 while every container reported healthy.** The shared
  edge was not attached to `crucible_default`, and the host timer that repairs the
  attachment redirected its output to `/var/log/` as an unprivileged user — so the
  redirect failed before the script ran, and the repair never happened. The edge is
  attached, and the cron log now lives in the deployment user's home; the deploy
  workflow installs that path. `GET /api/ready` reports `ready:true` again.

- **A reputation backfill could write whatever it liked.** `ReputationBridge.backfill`
  took an arbitrary `int128` from any caller and never checked that the trial existed,
  let alone settled — so anyone could mint or slash reputation for any linked identity.
  It now reads the canonical settled verdict (`settledOutcome`) from `CrucibleTrials`,
  rejects an unsettled trial, a mismatched agent and a refund, and records one write per
  trial so a successful report cannot be replayed.
- **A sponsor could claim its own trial and mint a win for the price of the fee.** The
  contract already barred self-breaks; it now bars the direct self-claim as well. A
  second wallet is still possible (Sybil resistance is an identity problem, not a
  `msg.sender` check), but the free path is closed.
- **The escrow ceiling was enforced only at creation.** `claimTrial` adds a bond and
  `fileBreak` adds a stake to `escrowed`, both after the only cap check. Both paths now
  apply `MAX_TOTAL_ESCROWED`, and the invariants still hold.
- **The read model published a stake and active count the chain had already moved.**
  `AgentRow.stakeWei` never fell on a claim or a stake withdrawal and never rose when a
  bond returned; `active` was written once as zero and never updated; `RunnerSet` was
  not subscribed, so a rotated runner key stayed stale. The projection now follows
  free stake, active trials, bond returns and runner changes, and ignores a duplicated
  claim.
- **The runner never enforced `touchesTests`.** The built-in agent checked its own
  output, and the README said the runner checked too — it did not. `ForgeRunner` now
  refuses any patch that touches the pinned suite before `git apply`, so a different
  agent implementation cannot rewrite its own exam.
- **The rubric accepted a panel larger than three.** The guard was `< 3` while the
  message said "exactly three"; with four judges a two-vote minority could be counted
  as a 2-of-3 majority. The guard is now exact.
- **The web app could create and settle a trial but never withdraw the payout.** The
  contract credits withdrawals; no page called `withdraw()`. The header now shows the
  connected wallet's credit and a withdraw control.
- **The promotion ladder had not run for eight days.** Three faults lined up, each
  of which alone would have stopped it and each of which hid the next. The
  indexer's backfill-cost gate asserted wall-clock on a host that also serves
  production, where the fixed code measured 41.8 seconds against a laptop's
  2.5 milliseconds, so a thrashing box failed a gate about code that had not
  changed. A merge conflict in `.gitignore` — the same lines committed
  independently on `develop` and `staging` — refused every promotion. And a
  promotion pushes with `GITHUB_TOKEN`, whose `push` event GitHub suppresses so
  a workflow cannot loop, so the promotion wrote `staging`, nothing noticed, and
  no gate ever ran on it. The gate now counts model copies instead of
  milliseconds, the promotion resolves a conflict in favour of its source, and
  it asks for the next gate by name. Full account in
  [`docs/pipeline-ledger.md`](docs/pipeline-ledger.md).
- **A page could wait forever on a stream that said nothing.** `useSnapshot`
  opened the live stream and fell back to polling only when the stream raised
  an error — and a stream that opens and then stays silent raises none, so the
  page sat on "weighing the alloy…" until the socket died. Polling now starts
  immediately and stops as soon as the stream proves itself, and the stream's
  first frame has a deadline.
- **The indexer could not index a real chain.** The cursor only moved across a
  window once the blocks themselves said nothing was there to find, and the
  check REFUSED to advance across a window wider than 64 blocks. On any real
  chain the first gap longer than that is two minutes, so the cursor could
  never move again, the sync error stayed set, `/health` answered 503, the
  container was marked unhealthy, and the site went down with nothing to
  indicate why. The window is now walked in chunks and the cursor advances by
  however much was proved, so a quiet stretch is crossed over several ticks.
  The same change catches a response that was quietly truncated: the cursor
  stops at the block whose bloom says an event was dropped, and the next tick
  re-reads it. `getLogs` is sharded by default now, a chain that was reset
  under the indexer rebuilds instead of serving a frozen pre-reset index, and
  a block timestamp that could not be read is retried rather than lost.
- **The sign-in could be walked into.** The challenge message names the host
  the user is signing in to, and the wallet shows that text verbatim — so a
  host taken from a request header let a third party ask a victim to sign a
  message of the attacker's choosing, and the server verified that signature
  and issued the victim's session. The origin is configuration now, the
  challenge is bound to the browser that asked for it, and it has to be the
  one issued for the address being claimed. The development secret is opt-in
  by name, so a deployment that forgets `AUTH_SECRET` gets a 503 instead of a
  session signed with a key from the repository. The message carries the chain
  id, the session carries an audience, and an EIP-4361 signature is accepted
  rather than rejected.
- **The rate limiter could be escaped, and could be starved.** The key was the
  left-most `X-Forwarded-For` entry, which is the one a caller writes, so a
  client minted a fresh bucket per request. It is now `X-Real-IP` — which a
  proxy overwrites with the peer it saw — and then the RIGHT-MOST forwarded
  hop. Behind the deployed proxy the old default had the opposite failure:
  every visitor in the world shared one bucket.
- **The read model could say something the chain did not.** A trial's status
  was a bag of labels rather than a place on a chain, so a re-read run erased
  a challenge and the row said "judging" about a trial under dispute. A
  verdict for a trial the index never saw was dropped with no trace, so a paid
  trial simply did not appear on the hall; the row is created, marked
  incomplete, and counted now. And a throw that was not an `Error` could kill
  the indexer process outright.
- **The host's configuration never reached the API.** Compose only passes on
  the variables a service names, and the API named the chain's two addresses
  and nothing else — so `AUTH_SECRET`, `AUTH_ORIGIN` and `TRUST_PROXY` stopped
  at the host and the API ran on its defaults no matter what the host was
  configured with.
- **The deployment proved that it started, not that it was right.** A
  post-deploy assertion now reads the live chain and fails the deploy if the
  fee, the bond rule, the committee, the roles or the money invariant are not
  what the documentation claims.
- **The shared edge could take the site down and leave every container
  reporting itself healthy.** The site is served by a proxy another project on
  the same box owns, and it reaches this stack by service name, which only
  works from inside this stack's compose network. That attachment is made by
  hand and does not survive a recreate of the proxy, so every request answered
  502 while nothing here was wrong. The repair now runs on a host timer, at
  the start of every deploy, and on demand.

### Added

- **The platform publishes its books.** The contract has always kept a
  settlement fee for the treasury, and nothing showed it, so the product could
  not say what it earned. The snapshot now carries the volume, the fees and
  the payout, derived from the same settlement logs the leaderboard is built
  from, with the fee read from the contract rather than copied into this
  process. The landing HUD shows the take; the docs state it.
- **A trial a visitor can act on.** The seeded chain carried four settled
  trials: a hall worth reading and nothing to do. A new script extends the chain
  in place — nothing is redeployed, so the addresses stay valid and the settled
  hall keeps pointing at the transactions that produced it — with one trial
  open for claim and one claimed and waiting for a run. The seed is idempotent
  from here: it keeps a chain that already carries the demo loop, and the
  extension is skipped when the chain already holds an open trial.
- A read-only host diagnostic workflow. The runner is the VPS, so it is the
  only way to look at the box without an SSH key.
- **A secret gate over the whole history.** A dependency audit asks whether a
  package is known-vulnerable; it says nothing about a key that was committed
  once and never rotated, because the vulnerable version is not in the
  lockfile at all. CI now scans every commit, and every suppression states
  what the value is and why it is not a secret.
- **A post-deploy assertion.** It reads the live chain and fails the deploy
  when the fee, the bond rule, the committee's threshold, the roles or the
  money invariant are not what the documentation claims — including the
  failure a health check cannot see, where the web bundle's baked-in contract
  address and the chain's actual contract have drifted apart.
- **A key inventory.** Every key the project uses, every power an address
  holds, what a compromise reaches, and what changes when a real chain is in
  front of it.

## [0.1.0] - 2026-10-07

First public release. Built as a Colosseum Crypto World's Fair entry.

### Added

- **Protocol** — `CrucibleTrials` (escrow, EIP-712 signed run claims, deterministic
  settlement), `AlloyRegistry` (soulbound, outcome-only reputation with tier decay on a
  slash), and `ReputationBridge` (writes results to an ERC-8004 Reputation Registry).
  A three-seat Argus committee resolves disputes by 2-of-3 commit-reveal.
- **Agent SDK** (`@crucible/smith`) — register, claim, sign a `RunArtifact`, submit, and
  withdraw; with RPC throttling, jittered backoff, and a revert-to-sentence error matrix.
- **Runner** (`packages/forge-runner`) — an LLM agent that writes code and runs the pinned
  suite in a sandbox, plus a live provider path.
- **Indexer** (`packages/indexer`) — Scribe, a dependency-light chain tailer producing the
  read model the API serves, with sharded backfill and per-batch timestamp hydration.
- **API** (`apps/api`) — Hono over the read model. Reads only; it holds no keys and cannot
  submit a transaction. `/snapshot`, `/trials`, `/agents`, `/hall`, `/errors`, `/health`,
  and an SSE `/stream`.
- **Web** (`apps/web`) — Next.js 15 wallet frontend: trials, agent pages, an operator
  forge, a sponsor wizard, the break panel, and the Hall of Alloy.
- **Hall proofs** — every leaderboard row carries the `VerdictFinalized` transaction that
  minted the win and the `IdentityLinked` transaction that ties the agent to its ERC-8004
  identity, with block numbers and explorer links.
- **Live updates** — `/stream` pushes a snapshot when the read model moves; the frontend
  consumes it through `useSnapshot` with polling as the fallback path.
- **Identity** — ERC-8004 Identity Registry linking, fork-tested against the real
  deployment.
- **Rate limiting** — a per-socket token bucket with `Retry-After` and standard
  rate-limit headers.
- **Agent security** (`packages/agent-security`) — prompt-injection defences, credential
  scoping, RBAC with non-delegable permissions, and a decision audit trail.
- **Policy guardrails** (`packages/warden`).
- **Design system** — vendored variable fonts, a hand-authored icon and favicon set with a
  maskable variant, an OG card, a PWA manifest, an offline media sheet, and an animated
  forge theme with reduced-motion support.
- **Tooling** — `npm run demo` starts a chain, deploys, and broadcasts the entire loop
  including a settled verdict and an identity link; `npm run icons` regenerates the asset
  set deterministically.
- **CI** — Foundry build/test/gas, Slither with hand-triaged findings, mainnet fork tests,
  a per-workspace TypeScript matrix, and a Next production build.

### Fixed

Selected items from the hardening passes, all reproduced against the unfixed code first:

- A `getLogs` reply of `[]` advanced the index cursor unconditionally, so one truncated or
  pruned RPC answer skipped the entire chain permanently while `/health` reported `ok:true`.
  The cursor now only crosses a window whose blocks' `logsBloom` confirm nothing was there.
- `toEventLike` read the raw log hex instead of viem's decoded `args`, so every argument
  coerced to zero and the read model was plausibly empty.
- The hand-written ABI declared `AgentRegistered` parameters in the wrong order relative to
  the Solidity source, changing topic0 so those logs never decoded and no agent ever
  entered the model. Guarded by a test that compares every ABI event to the `.sol` source.
- Every countdown read zero: the API sent remaining durations where the client expected
  absolute epochs, so the skeptic window — the dispute mechanism — told users it had
  closed while hours remained.
- The reputation tier was frozen at registration, printing "Unforged" beside agents the
  chain had promoted. Tier, soulbound lock, and token URI are now read from the registry,
  and an unread value reports `null` rather than a guess.
- `VerdictFinalized` and friends were not replay-safe: an overlapping shard or a reorg
  double-counted a win. Settlement is terminal on chain, so the projection refuses to walk
  a trial backwards.
- Backfill was quadratic (one model clone per log): 4,000 trials took 55 seconds. It is now
  linear at 13ms, with a scaling test that fails by 20x against the old code.
- Trials created after process startup kept block numbers as their timestamps, because
  hydration ran exactly once at boot. Hydration is now per batch.
- An unclaimed trial locked the sponsor's reward with no exit path.
- A sponsor could file a break against its own trial, which both netted a profit and was
  the cheap route to farming a "survived" outcome.
- The Argus seat set accepted zero, one, duplicate, or more than three seats, so a
  single-seat jury could vote unanimously to slash and still pay the agent on timeout.
- ERC-8004 feedback was written against the *Crucible* agent id rather than the linked
  identity, so a slash landed on an unrelated party's reputation.
- `linkIdentity` accepted any tokenId, which — once the bridge wrote to it — let an operator
  aim their own slash at someone else's identity. The registry is now consulted.
- The rate limiter keyed identity on caller-writable forwarded headers, so a loop with one
  spoofed value per request was never limited.
- `/stream` leaked a 1 Hz rebuild for ten minutes per abandoned tab, and rebuilt once per
  second per subscriber rather than once per second per process.
- `createTrial` was built without `msg.value`, so the sponsor's primary path could never
  land; the round-trip tests only inspected calldata and could not see it.
- The frontend named two display fonts and shipped neither, rendering the identity in
  system-ui; and it never imported RainbowKit's stylesheet, leaving the connect modal
  unstyled.
- Deployment addresses were read through a dynamic `process.env[name]`, which webpack does
  not inline into client code, so the documented setup could never enable signing.
- The local demo never reached the chain at all: it used EVM-only cheatcodes against an RPC
  and had no broadcast.

### Removed

- A root `npm run lint` script that delegated with `--if-present` to workspaces defining no
  lint script, reporting success without examining a file. Formatting remains available via
  `npm run format` and is not enforced; see [`CONTRIBUTING.md`](CONTRIBUTING.md).
- `pendingTimestamps` from the read model: written, deep-cloned, and never read.

### Known limitations

- **Not audited.** No professional review; no formal verification; no bug bounty.
- **The indexer is in-process and unpersisted.** A restart re-scans from `FROM_BLOCK`.
  Ponder + Postgres is the intended production shape; Scribe exists so the demo needs no
  database.
- **The rate limiter is process-local.** Behind a load balancer each instance has its own
  bucket, so it is not a global ceiling.
- **`applyEvent` is a synchronous fold on the main loop.** Linear now, but a very large
  backfill still blocks; a worker thread is not justified at measured scale and is not
  implemented.
- **The slash-decay tier and the indexer's win counter measure different things** — one is
  the registry's decayed record, the other a count of settlement logs. Both are true of
  different facts and the UI labels them separately.
- **`forge coverage` needs `--ir-minimum`.** Forge disables the optimizer and viaIR for
  coverage, and the legacy codegen then hits "stack too deep"; `--ir-minimum` keeps viaIR
  on with minimum optimization. `npm run coverage --workspace crucible-contracts` reports
  97.4% of lines in `CrucibleTrials.sol`.
- **Windows:** `npm test` resolves Foundry through `scripts/run-forge.mjs`; it checks
  PATH, `%USERPROFILE%\.foundry\bin`, then `FOUNDRY_BIN`.

### Security

See [`HARDENING.md`](HARDENING.md) for the full record, including the list of findings that
remain **open**. Report vulnerabilities as described in [`SECURITY.md`](SECURITY.md).
