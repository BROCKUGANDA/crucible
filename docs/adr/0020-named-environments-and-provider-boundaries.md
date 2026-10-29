# ADR-0020: three named environments, a provider that is asked rather than told, and Shield kept outside the escrow

- **Status:** accepted (2026-10-29)
- **Decides:** how Crucible names the chain it is on and to whom it will talk, whether an RPC provider's webhooks enter the money path, and where the human.tech Shield bridge may and may not touch settlement
- **Depends on:** ADR-0002 (native ETH escrow), ADR-0003 (pull payments), ADR-0006 (no chain key in the API), ADR-0008 (in-memory indexer), ADR-0011 (fees as parameters), ADR-0019 (both fee schedules legible)
- **Prompted by:** two external implementation briefs received 2026-10-29 — an Alchemy + human.tech Shield integration master prompt, and a security-hardening master prompt

## Context

Crucible runs on one local chain. `RPC_URL ?? "http://127.0.0.1:8545"` is read independently in
`apps/api/src/server.ts:116` and `apps/keeper/src/main.ts:168`; `apps/juror/src/config.ts:64` requires
`RPC_URL` outright; `apps/web/src/lib/wagmi.ts:160-170` carries its own chain switch with a public
Sepolia fallback. `foundry.toml` already declares `sepolia` and `mainnet` RPC endpoints, and
`params/crucible.params.json` is chain-agnostic. So the code is simultaneously Anvil-only (the
product, the demo, the deployed site) and Sepolia-ready (the web app's default chain is literally
`sepolia`, per `apps/web/.env.example:9`).

That seam is where the two briefs land, and it produces three findings that must be stated before any
provider is wired in.

1. **A chain-id check inside a Foundry script cannot guard a deployment.** Measured with forge 1.8.5:
   `forge script --rpc-url <node>` evaluates the script in a local EVM that reports `block.chainid`
   31337 whatever node it targets. The fix that looked right — moving `Deploy.s.sol`'s
   `vm.envOr("PRIVATE_KEY", DEFAULT_PK)` behind a chain test — would have been a control that never
   fires. The interrogation has to happen outside, over JSON-RPC, before `forge` starts.
2. **`Deploy.s.sol` was silently adopting a public key.** `DEFAULT_PK` is Anvil's documented account
   #0. The keeper beside it already refuses that key unless the host is loopback **and** the node
   answers `eth_chainId` with 31337 (`apps/keeper/src/main.ts:55-95`), with the reasoning written
   down; the deploy script was the one caller that did not.
3. **There is nothing for Alchemy to serve yet.** Zero references in the tree. Its RPC would replace
   the local node the whole demo depends on, its Admin usage metrics would report traffic Crucible
   does not generate, and its Notify webhooks would be the first inbound, signed,
   externally-triggered write path in a system whose indexer already polls with a checkpoint, a
   quiet-tail proof, digest-keyed deduplication and a reorg rebuild (`packages/indexer/src/scribe.ts`)
   — behind an RPC gate that already refuses `eth_accounts` and is verified by a post-deploy probe
   against the public URL.

## Decision

1. **Environments are named, never inferred.** `npm run deploy:network -- --env local|testnet|production`
   is the only supported deployment path. Each name carries an expected chain id
   (`local` 31337, `testnet` 11155111, `production` 1); the node is asked, and a disagreement is a
   refusal, not a warning. A missing `--env` or an empty RPC variable is a refusal: no environment is
   ever chosen because a variable was absent. Production additionally requires
   `npm run mainnet:preflight` to pass, which is the rule that already gates launch.
2. **The published dev key is admissible only where it is provably worthless.** No key configured
   means `Deploy.s.sol` reverts unless `ALLOW_ANVIL_DEV_KEY=1` is set deliberately; the wrapper sets
   nothing like that itself, and admits the key only when the chain id is 31337 **and** the host is
   loopback. An explicit `PRIVATE_KEY` remains an operator decision, matching the keeper. The bracket
   nuance is load-bearing and was caught by a test: `URL.hostname` returns `[::1]`, which matched no
   loopback entry in the first draft.
3. **A provider webhook is a hint, and never a settlement input.** Alchemy Notify (or any provider
   event delivery) does not enter the money path. The canonical chain read stays the only thing that
   can move `credit[]`, mint a receipt or change a tier — which is already this repository's rule for
   unsigned payloads, and the rule that makes ADR-0003 and ADR-0006 hold. If notification latency
   ever justifies a webhook, the receiver must verify HMAC-SHA256 over the **raw body** in constant
   time before any parsing, deduplicate on the provider event id, and hand the scribe a *hint* whose
   effect is to trigger a read it would otherwise have done on its own schedule.
4. **A durable webhook inbox is not free here — it needs its own ADR.** The briefs ask for
   `webhook_inbox`, `indexed_chain_event` and `provider_usage_snapshot` tables. ADR-0008 deleted the
   database on purpose: the read model is rebuilt from chain events, and the cursor file is the only
   durable state. Accepting a queue means either re-opening ADR-0008 or accepting that a process
   restart drops accepted-but-unprocessed events, which is a lie about durability. Neither is decided
   here. What is decided: **no inbox is built until that choice is written down.**
5. **Shield stays outside the escrow.** The existing integration — `integrations/clean-sdk`, an
   isolated sidecar exposing one unauthenticated `GET /eligibility/:address` reading the POCH→Passport
   cascade and a sanctions screen, consumed by `apps/api/src/passport.ts` with three honest states —
   is kept and is *not* extended into a bridge. The Ethereum↔Aztec bridge is Mode B in the brief's own
   terms, and it moves funds across a layer boundary with separate assets, addresses, fees and
   recovery states. Crucible's escrow is native ETH on one chain, settled by pull payments
   (ADR-0002, ADR-0003). Therefore: Mode A (a clearly-named external hand-off that says the user is
   leaving Crucible) is permissible; Mode B is not, and no bridge event may mark a trial passed,
   change reputation, unlock a bond, pay a reward or alter a schedule. If bridge reconciliation is
   ever wanted, it arrives as a separate contract, a separate ADR and a separate threat model.
6. **Provider credentials are separated by trust, not convenience.** An RPC URL that a browser holds
   is public and rate-limited, never a secret; an Admin/Usage key is server-only and read-scoped; a
   webhook signing key is per-environment and never logged. Nothing that carries a credential is
   printed — the wrapper logs `rpcHost`, not `rpcUrl`, because an Alchemy endpoint keeps its key in
   the path.

## Consequences

- A Sepolia deployment is now a *supported* action with a preflight that fails closed, rather than an
  ad-hoc `forge script` invocation. It still requires three things no code in this repository can
  supply: a Sepolia-funded deployer key, an RPC endpoint for it (the tree currently holds a
  non-Alchemy `SEPOLIA_RPC_URL`), and a decision about what the deployed site's chain should be at
  all — the demo's whole argument is that worthless metal with real mechanics beats valuable metal
  with none.
- The web app's `NEXT_PUBLIC_CHAIN=sepolia` default and the deployed Anvil reality are now a known
  inconsistency rather than a hidden one. Until the operator chooses, a fresh clone points at a
  network the product does not use.
- Declining the webhook inbox keeps ADR-0008 intact and leaves one of the briefs' acceptance criteria
  explicitly unmet, which is the honest state: it is recorded as blocked on a decision, not as done.
- `Deploy.s.sol` will now revert for anyone who ran it without a key. The runbook states the opt-in
  variable and the reason; `scripts/demo.mjs` is unaffected because it deploys through `Demo.s.sol`
  and passes `--private-key` explicitly.

## Validation

- `packages/eval/test/deploy-network.test.ts` — 13 assertions against a fake RPC that answers
  `eth_chainId` on demand: chain mismatch, missing key on a foreign chain, the published key offered
  explicitly on a non-local chain, an empty RPC variable, unreachable node, the loopback+id pair, and
  that production still demands the preflight. Mutation-proven twice (drop the loopback half; let a
  missing key fall back silently) — each turned the file red, and it is green again.
- `forge build` must compile `script/`: `forge test` does not, which is how a broken deploy script
  once stayed green across 266 tests.
- Not verified, and not claimed: an actual Sepolia broadcast. `--dry-run` proves the plan and the
  refusals; only a funded key on the real chain proves the deployment, and that is the operator's
  action with the operator's credential.
