# Hardening & runtime audit

Scope: the four contracts, the TS services (`api`, `forge-runner`, `smith-sdk`,
`agent-security`), and the frontend. What was checked, what is fixed, what is
deliberately accepted, and why.

This is not a triumphant list. Several rows read "not exploitable because of X, and
also still fixed" — that combination is what a parser-auditor wants to see.

## Rate limiting

The API previously had none. Every route is a read, but reads are not free:
`/snapshot` rebuilds the read model on every call, and the event loop is shared with the
indexer thread that trails the chain. One client looping on `/snapshot` would starve
every other request and the chain sync behind them.

- `apps/api/src/rate-limit.ts`: token bucket keyed on the socket peer, `60 req/min`
  sustained with a `20`-token burst. Refills continuously (not in discrete bursts), so a
  client pounding at a steady rate gets a steady answer rather than a wall.
- Identity comes from the connection, not from a header. It used to read
  `cf-connecting-ip` / `X-Forwarded-For` / `x-real-ip` first, which are all
  caller-writable: 200 requests carrying 200 distinct spoofed values produced 200 fresh
  buckets and zero 429s, so the limiter was decoration. Forwarded headers are honoured
  only with `TRUST_PROXY=1`, which asserts that something in front overwrites them.
- Bounds: `limit`, `windowMs`, and `burst` are validated at construction; a bucket can
  never go negative or fractional.
- `Retry-After` is surfaced on a 429 so a well-behaved client backs off instead of
  hammering. Standard rate-limit headers on 200s.
- An unidentifiable request falls into a *shared* bucket rather than being waved through,
  because "no identity" is an attack, not a feature. It fails closed.
- Buckets are swept once they are full, so the map does not grow without bound.
- Overridable per app so tests can toggle it off and the demo can loosen it.
- `/stream` is one request that never ends, so the limiter cannot see what it spends: a
  subscriber costs one token at connect and then rebuilds the read model on a timer. It
  now shares one rebuild per tick across every subscriber and stops when the request
  signal aborts — previously an abandoned tab kept a 1 Hz loop alive for ten minutes, and
  hono only wires its own abort listener on old Bun, so `stream.onAbort` never fired.

Not fixed, by design: a load balancer would give each instance its own bucket, which is
no longer a true global ceiling. The honest note in the source says to swap the `Map`
for Redis if that becomes the deployment.

## Race conditions

**Indexer (`Scribe`).** The single-threaded event loop makes the concern mostly
hypothetical, but two real ones:

- `watch()` calls `await this.sync()` and then `setTimeout`. `sync()` assigns
  `this.model = replay(...)` *after* its awaits, so a request that reads `state`
  mid-sync sees the previous complete model, and the swap into the new model is atomic.
  No tearing. Documented as verified, not assumed.
- `attachCids` / `attachSignatures` **mutate** the current model in place, while
  `sync()` and `hydrate()` replace the model wholesale. If they disagree about the
  trial's `createdAt` timestamps, a hydrate after a attach loses the attachment unless
  `replay` preserves it. The test treats this as a contract: attachments must survive a
  hydrate only through replay preserving them. No code change; flagged for the indexer
  maintainer.

**Wallets (`useTx`).** The receipt-to-terminal-state transition was a boolean. If two
`useTx` hooks (or a double click) overlapped, the second would sometimes miss the
transition. It now transitions through one effect keyed on the receipt state, so a
later receipt cannot get lost.

## Edge cases

- **Zero-value stake check is closed twice.** `parseEth` returns `bigint`, and a zero
  bond is a revert at `createTrial` *and* a zero min-stake would otherwise accept a
  no-stake break. The panel computes `minStakeWei = rewardWei / 100`, which is `0`
  when `rewardWei` is `0`, and the caller disables on that; the contract independently
  rejects a zero stake.
- **`extractDiff` fails closed.** A non-empty patch whose files cannot be identified is
  treated as a violation, because it has not been shown to be safe. A clean patch is
  one whose files are all non-test.
- **`parseEth` refuses what a float would lie about.** Eighteenth-of-wei precision is
  refused rather than truncated, and sub-wei amounts return `null` rather than `0n`, so
  the caller sees "not a number" instead of silently backing a wrong amount.
- **Reverts are decoded for operators**, not surfaced as raw selectors. An unknown
  revert falls back to "try again" with no selector escaped.
- **The adversarial path is explicit.** `--scenario injection` runs the full live loop
  against a spec that tries to edit the pinned tests, and asserts the guard rejects it
  in the first iteration — before the runner's own `touchesTests` check is ever asked.

## Runtime & production hardening

- **No secrets in the client bundle.** All chain addresses come from `NEXT_PUBLIC_*`,
  which is fine — they are on-chain data. No API keys are, by construction. `wagmi`
  holds no key, and `GROQ_API_KEY`/`ANTHROPIC_API_KEY` are read only in the Node
  process, never shipped to a browser.
- **The agent never ships a secret to the model.** The `system` message is fixed and
  contains no credentials; the model input is a digest, not a full spec dump.
- **Untuned prompt is labeled, not hidden.** The live script and README state that the
  fixture is one narrow task, not a real sponsor repo.
- **Process hygiene.** `scribe.watch()` is not left dangling on exit; the demo's anvil
  process is killed on SIGINT. The `rateLimit` sweeper uses `unref()` so a misbehaving
  loop does not hold the process open.
- **`forge clean` between campaigns.** A stale persisted invariant-failure file replays
  the old failure, which is exactly how "CI says red" happened without a real bug.
  The full suites now pass three runs in a row on a clean tree.

## Functionality hardening — what the first live run exposed

Four real bugs, every one of which passed every stub test:

1. **A guard that failed open.** `extractDiff`/`filesTouched` only understood
   `diff --git a/x b/y`. A real model emitting bare `---/+++` caused `touchesTests` to
   report "clean". Both forms are now parsed and an unidentifiable patch is a violation.
2. **`extractDiff` trimmed the trailing newline**, which `git apply` requires — a
   correct response rejected as `corrupt patch`.
3. **The agent was never shown the file it was patching.** It now carries editable
   files in `WorkContext`, and the prompt instructs it to copy context verbatim. The
   pinned suite is deliberately not shown.
4. **The model miscounts hunk headers.** `git apply --recount` is used. It does not
   weaken the guard: context lines are still matched byte-for-byte.

A fifth was in the live script itself: it checked `suite.ok`, but `CommandResult` has
`code`, so a suite printing `4 passed, 0 failed` was reported as red. It is fixed and
its own test is in the file.

## What is deliberately not changed

- **`forge coverage` still does not work.** `via_ir = true` is required to compile;
  disabling the optimizer re-triggers stack-too-deep. Not quoted anywhere.
- **ERC-4337 / Safe are still skipped.** A paymaster or Safe signer is a polish surface,
  not a correctness one. Identity registration is done (link-only, fork-tested); that
  was the gap worth closing now.
- **`@wagmi` advisory set is unchanged.** RainbowKit 2.2.11 pins `wagmi ^2.9`, and the
  only fix is the wagmi-3 major, which would drop the modal a judge actually sees.
  Documented, not swapped away.
## The live-chain pass — what the first real index exposed

Everything above was written against tests. This pass ran the actual stack: Anvil, the
seeded protocol, the API, the browser. Four of these produced no error and no output —
they produced a plausible-looking empty, which is worse.

| Found | Symptom | Cause | Status |
| --- | --- | --- | --- |
| Log decoding | `/hall` answered `[]` on a chain with four settled trials | `toEventLike` iterated `log.data` (raw hex) instead of viem's decoded `args`, so every argument coerced to zero | fixed, `scribe.test.ts` encodes and decodes real logs |
| ABI drift | No agent ever entered the read model | `AgentRegistered` declared `metadataURI, runner` where the Solidity says `runner, metadataURI`; parameter order changes topic0, so the logs decoded as unknown | fixed, plus `abi-drift.test.ts` compares every ABI event to the `.sol` source |
| The demo never reached a chain | 0 logs after `npm run demo` | `vm.prank`/`deal`/`warp` are EVM cheatcodes; against an RPC they do nothing to the sender, so the "replay" ran in a simulation. There was no `startBroadcast` at all | fixed — real Anvil keys derived from the published dev mnemonic, and an ERC-8004 registry wired so the identity link exists to be quoted |
| Ingest was not replay-safe | A duplicate log double-counted a win | Overlapping shards and reorgs re-apply `VerdictFinalized`; a re-read `AgentRegistered` reset counters it had already earned | fixed — settlement is terminal, so the projection refuses to walk a trial backwards |
| A skipped chain, forever | `/health` `ok:true`, `/hall` `[]`, HTTP 200, permanently | `getLogs` answering `[]` is indistinguishable from a node that has no answer, and the cursor advanced either way | fixed — the cursor only crosses a window each block's `logsBloom` vouches for; `/health` reports `indexedTo`/`head`/`syncError` and returns 503 when stalled |
| Every countdown read zero | "break window closes in 0s" with 10 hours left | `useCountdown` subtracts the server clock from an absolute epoch; the API sent a remaining duration, so the result was deeply negative and clamped | fixed — `deadlineAt`/`breakWindowEndsAt`, absolute seconds, null when nothing counts down |
| Sponsor path could not execute | `createTrial` always reverted `RewardTooSmall` | `buildCreateTrial` returned bare calldata with no `msg.value`; the round-trip tests only ever inspected calldata | fixed, with value assertions on all three payable builders |
| Hydration mismatch on every page with a header | React discarded and rebuilt the tree | The unconfigured-deployment notice depends on `NEXT_PUBLIC_*` reaching the bundle, which is not guaranteed to agree between the server's `process.env` and the client's compile-time inlining | fixed — the notice mounts client-side only |

The pattern worth naming: each of these was invisible because the failure mode was
*emptiness*, and emptiness is also what a quiet system looks like. A guard that can only
fire on an exception cannot see any of them. That is why the fixes are mostly assertions
that a thing must be non-empty to be believed, and why the bloom check asks the blocks
rather than asking `getLogs` again.

## Still open from this pass, by severity

Not fixed here, listed so nobody has to rediscover them.

- ~~**CRITICAL, contracts** — a trial that is never claimed locks the sponsor's ETH.~~
  **Fixed** — `Open` past the deadline is reclaimable and returns only the reward. The test
  that had been asserting the lock as expected behaviour is replaced with the rejections that
  should hold.
- **HIGH, contracts** — `ReputationBridge` writes ERC-8004 feedback keyed by the *Crucible*
  agentId instead of `identityOf[agentId]`, so a slash lands on an unrelated wallet's
  identity and the offender's own identity hears nothing. The existing test seeds the mock
  with the same conflation, which is why it passes.
- ~~**HIGH, contracts** — a sponsor can `fileBreak` on its own trial.~~ **Fixed** — sponsor
  and assigned operator are both rejected with `SelfBreak`; an unrelated skeptic still breaks.
- **HIGH, contracts** — the Argus seat set is unvalidated. With one seat, that seat voting
  to slash still settles `Paid` on timeout: 100% of the jury said break and the protocol
  paid. `ARGUS_THRESHOLD` is a fixed 2, so it is unreachable.
- **HIGH, indexer** — `applyEvent` deep-clones the entire model per log: 1,000 trials
  replays in 10s, 4,000 in 73s. Quadratic, and it cannot tail a busy chain.
- **HIGH, indexer** — no persistence. A restart re-scans from `FROM_BLOCK`, and there is no
  recoverable cursor. Documented as the intended shape (Ponder is the production index),
  but it is a real limit, not a detail.
- **MEDIUM, web** — `/agents/[id]` renders its not-found state while loading, because
  `!agent` conflates "absent" with "not yet". The four panels on `/trials/[id]` are
  unstyled spans with no handler — they look like tabs and do nothing.
- **Environment** — `npm test` fails on Windows unless Foundry is on the *system* PATH:
  npm spawns `cmd.exe`, which does not inherit a Git Bash `export`. The contracts suite
  passes when it is.
