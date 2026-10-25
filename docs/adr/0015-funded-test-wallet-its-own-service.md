# ADR-0015: A funded test wallet is its own service, and the API still holds no key

- **Status:** proposed (2026-10-25) — scope only; no code in this decision
- **Decides:** where Coinbase CDP credentials may live if CRUCIBLE funds guest wallets on a test
  network, and which existing rule would break if they were placed anywhere else
- **Reads with:** ADR-0006 (the API holds no chain key), ADR-0003 (settlement never pushes ETH)

## Context

The ask is to let a visitor on the demo try the loop without bringing an ETH balance: a wallet that
already holds test funds when the page opens. Two facts in this tree make it a decision rather than a
feature:

1. **The credentials exist and are not in the repository.** `.env` carries `CDP_LIVE_API_KEY_ID`,
   `CDP_LIVE_API_KEY_SECRET`, `CDP_LIVE_BASE_URL`, `CDP_SANDBOX_API_KEY_ID`,
   `CDP_SANDBOX_API_KEY_SECRET`, `CDP_SANDBOX_BASE_URL` and `CDP_CLIENT_API_KEY`. `.env` is
   gitignored (`.gitignore:25`) and the repository is public, so the only safe statement about those
   values is that they are read, never echoed, and never committed.
2. **`apps/api` holds no chain key today, by decision.** A grep for any private key across
   `apps/api/src` returns nothing, and `AGENTS.md` records it as ADR-0006. The API is the one process
   a browser talks to. Putting a funding credential there converts the read model into an account
   that can move value, and the property that makes it safe to expose — *no route can move funds* —
   stops being structural and becomes a code-review promise.

The Solana side is not ready to receive the result either: `crucible-contracts/solana/Anchor.toml:18`
pins `cluster = "Localnet"`, and there is no devnet provider, no devnet deploy, and no Anchor or
Cargo toolchain on the machine that would run this. Funding a wallet before there is a program on
that network would produce a balance nobody can spend in this product.

## Decision (proposed, pending the go)

1. **A separate service owns the credential.** `apps/funder` — its own process, its own container,
   its own secret, not reachable from the browser, and not on the API's image. The API may ask it for
   an allocation over an internal socket; it may not hold the key it uses to make that request.
2. **Sandbox credentials only, and the network is a constant, not a setting.** The first build uses
   `CDP_SANDBOX_*`. A live key is a separate, explicit change with its own review, because "which
   network does the funder touch" must not be answerable by an environment typo.
3. **Estimate before spend, and refuse above a cap.** Every allocation is logged as
   `requested → estimated → granted`, with a per-wallet and per-day ceiling. A funder that cannot
   produce the estimate is a funder that does not spend.
4. **The funded wallet is a demo affordance, not a claim about value.** Test funds are test funds;
   the landing page's money warning already says so in plain words, and nothing the funder mints may
   be presented as earned. Withdrawals to a visitor's own wallet stay the after-phase they were
   assigned to.
5. **It lands after the chain it funds exists.** Order: devnet provider config + a compiled and
   deployed Solana program → then the funder. Building the wallet faucet first produces a service
   with no customer.

## Rejected

- **The key in `apps/api`.** Ends ADR-0006 as a structural property.
- **The key in CI as a secret.** The runners are systemd services on the box that serves the site
  and other projects; a build-time secret there is readable by whatever a future workflow step runs.
- **Client-side funding through `CDP_CLIENT_API_KEY`.** Puts a spend-capable credential in a
  browser that anyone can open a devtools window on.
- **Funding the EVM demo chain.** `anvil` already gives every account 10,000 ETH; a faucet on a
  local chain solves nothing and adds a key to the picture.

## Consequences if built

A visitor can reach a real transaction without a wallet setup step, which is the difference between
a demo that is read and a demo that is used. The cost is one more process holding one more
credential on a shared box, and one more thing that can spend — bounded by caps, an estimate-first
rule, and a sandbox-only constant.

## Verification

None yet. This ADR is the scope, not the implementation, and it is marked **proposed** for exactly
that reason: nothing here has been built, no credential has been used, and no wallet has been
funded. When the implementation lands it must arrive with a test that the API's image contains no
funding credential, and one that the funder refuses to spend without an estimate — both of which can
fail, and neither of which exists today.
