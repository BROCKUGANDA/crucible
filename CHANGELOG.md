# Changelog

All notable changes to Crucible. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Versioning note:** `0.x` releases are pre-stable. The contracts hold real ETH in
escrow with no upgrade or pause path, so a breaking contract change is a redeploy, not a
migration. See [`SECURITY.md`](SECURITY.md) before deploying value.

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
