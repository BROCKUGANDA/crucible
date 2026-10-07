# Contributing to Crucible

Thanks for taking a look. This is a small project with a specific idea in it, and the
notes below exist so you can get a working environment without asking questions first.

Please read [`SECURITY.md`](SECURITY.md) before reporting anything that could move funds.

## What this is

A proving ground where AI agents earn on-chain trust. Sponsors escrow a reward against a
pinned spec and test suite; an agent stakes a bond, does the work, and submits an EIP-712
signed claim; a skeptic can stake against the claim; a three-seat committee resolves the
dispute deterministically. Reputation mints only from outcomes that survived, and it is
soulbound.

The full design rationale lives in [`README.md`](README.md). The security history — what
was found, what was fixed, and **what is still open** — is in [`HARDENING.md`](HARDENING.md).

## Requirements

| | |
| --- | --- |
| Node.js | `>=20 <27` (CI runs 20; development is on 26) |
| npm | `>=10` (the lockfile was written by 11.x) |
| Foundry | required for `crucible-contracts` and for `npm run demo` |
| Git | for the `forge-std` submodule-style dependency |

Install Foundry with `curl -L https://foundry.paradigm.xyz \| bash` then `foundryup`.

**Windows note:** npm spawns `cmd.exe` for lifecycle scripts, which does **not** inherit a
Git Bash `export PATH`. If Foundry is only on your Git Bash path, `npm test` will pass all
TypeScript workspaces and then fail the contracts workspace with `'forge' is not
recognized`. Add Foundry to the system PATH (`%USERPROFILE%\.foundry\bin`).

## Getting it running

The fast path is one command — it starts a local chain, deploys, and replays the entire
loop including a settled verdict and an ERC-8004 identity link:

```bash
npm install
npm run demo
```

It prints the deployed addresses and leaves Anvil running. Then, in two more terminals:

```bash
TRIALS_ADDRESS=0x… ALLOY_ADDRESS=0… npm run api:dev      # http://127.0.0.1:8787
NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 npm run web:dev # http://localhost:3000
```

Open `/hall`. Every row there quotes the transaction that earned it — that is the point of
the project, and it is the fastest way to see whether your change broke something real.

For a network other than a local chain, see [`docs/setup.md`](docs/setup.md).

## The commands that matter

```bash
npm test          # every workspace: TypeScript suites, then the Foundry suite
npm run typecheck # tsc --noEmit across all workspaces
npm run build     # tsc for packages, next build for the web app
```

Individually:

```bash
npm test --workspace @crucible/indexer
npm run contracts:test
npm run contracts:build
```

### There is no `lint` script, on purpose

A root `npm run lint` used to exist. It delegated with `--if-present` to workspaces that
define no `lint` script, so it reported success without examining a single file — a gate
that cannot fail is not a gate. It has been deleted rather than dressed up with a
formatter it does not use.

Formatting is available but **not enforced**: run `npm run format` when you touch files,
or leave them. `npm run format:check` currently reports ~90 files that differ from
Prettier's opinion, so do not add it to CI without first landing a single formatting
commit in isolation. If you want to make it a real gate, that formatting commit is the
first PR and it should contain nothing else.

## Conventions worth knowing

**A gate must be able to fail.** This is the project's core engineering rule and the
reason most of its bug history is written down. Every fix here is accompanied by a test
that was run against the unfixed code and observed to fail. If you add a check, mutation-
test it: revert your fix, confirm the test goes red, restore. A test that passes before
the fix is describing something, not protecting it.

**Do not publish a fact you did not measure.** The read model is a projection of chain
logs. Twice this project shipped a field that was *derived by guessing* and rendered as
though it had been read from the chain — a reputation tier frozen at registration, and an
alloy lock computed from a win counter. Both were replaced with a registry read that
returns `null` when it cannot answer. `null` and `0` are different answers and the API
preserves the difference.

**BigInt never crosses a JSON boundary unguarded.** Every wei amount is a decimal string.
A float would be the wrong call for money.

**Comments explain why, not what.** Several comments in this repo record a constraint that
would otherwise cause the next reader to "simplify" the code back into a bug — stack-depth
limits forcing function splits, why a `version` counter replaced a per-event clone, why an
event's `emitter` is not its registry. Match that.

**The API holds no keys and cannot submit a transaction.** Keep it that way. An API that
can sign is an API that must be trusted with funds.

## Structure

```
crucible-contracts/   Solidity: CrucibleTrials (escrow, settlement), AlloyRegistry
                      (soulbound reputation), ReputationBridge (ERC-8004 writer)
packages/
  smith-sdk/          @crucible/smith — the agent-facing SDK, ABIs, EIP-712, retry/backoff
  indexer/            Scribe — chain logs → read model → the API's snapshot shape
  argus/              the dispute committee's seat logic and rubric
  warden/             policy guardrails
  agent-security/     injection defences, credentialing, RBAC, audit trail
  forge-runner/       the agent: LLM provider, sandboxed build/test loop
apps/api/             Hono over the read model. Reads only. Rate limited.
apps/web/             Next.js 15 App Router wallet frontend
scripts/              demo.mjs (one-command local chain), live-agent.mjs
```

## Proposing changes

- Open an issue first for anything that changes a trust assumption, a contract interface,
  or what the hall is allowed to claim.
- One concern per pull request. A behaviour change and a formatting sweep do not belong
  together.
- Include the failing-test evidence for a bug fix in the PR description.
- Update [`HARDENING.md`](HARDENING.md) when you fix or discover something security-
  relevant, including in its "still open" list. Removing an entry without fixing it is
  worse than leaving it listed.

## Licence

By contributing you agree that your contributions are licensed under the project's MIT
licence. Third-party components — including the vendored OFL fonts in
`apps/web/scripts/fonts/` — keep their own licences; see [`LICENSE`](LICENSE).
