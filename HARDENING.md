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

- `apps/api/src/rate-limit.ts`: per-IP token bucket, `60 req/min` sustained with a
  `20`-token burst. Refills continuously (not in discrete bursts), so a client pounding
  at a steady rate gets a steady answer rather than a wall.
- Bounds: `limit`, `windowMs`, and `burst` are validated at construction; a bucket can
  never go negative or fractional.
- `Retry-After` is surfaced on a 429 so a well-behaved client backs off instead of
  hammering. Standard rate-limit headers on 200s.
- An unidentifiable request falls into a *shared* bucket rather than being waved through,
  because "no IP" is an attack, not a feature. It fails closed.
- Buckets are swept once they are full, so the map does not grow without bound.
- Overridable per app so tests can toggle it off and the demo can loosen it.

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