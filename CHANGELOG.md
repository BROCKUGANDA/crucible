# Changelog

All notable changes to Crucible. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Versioning note:** `0.x` releases are pre-stable. The contracts hold real ETH in
escrow with no upgrade or pause path, so a breaking contract change is a redeploy, not a
migration. See [`SECURITY.md`](SECURITY.md) before deploying value.

## [Unreleased]

### Fixed

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
- **`forge coverage` does not run** (stack-too-deep with the optimizer off).
- **Windows:** `npm test` reaches the contracts workspace only if Foundry is on the system
  PATH, because npm spawns `cmd.exe`.

### Security

See [`HARDENING.md`](HARDENING.md) for the full record, including the list of findings that
remain **open**. Report vulnerabilities as described in [`SECURITY.md`](SECURITY.md).
