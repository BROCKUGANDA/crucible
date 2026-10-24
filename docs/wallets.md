# Wallets: what to connect, and what it costs to set up

The app already signs its on-chain actions with a connected wallet: create a
trial, register an agent, claim a trial, file a break, finalize a window and
withdraw a credit. The current stack is
**wagmi v2 + RainbowKit** with injected wallets, **Coinbase Wallet** and
WalletConnect. The API holds no chain key (ADR-0006). The Coinbase connector is
explicit in `apps/web/src/lib/wagmi.ts`, so it works without a WalletConnect
project id; the no-project fallback in `Wallet.tsx` shows a Coinbase Wallet
button next to the injected one.

This page is a decision guide, not an integration. Pick one path, set the
configuration, and rebuild the web image: `NEXT_PUBLIC_*` values are baked at
build time.

## Recommendation for the current demo

1. **Coinbase Wallet is enabled** via the classic Coinbase Wallet SDK connector
   in `apps/web/src/lib/wagmi.ts`; no additional setup is required for the
   extension or mobile app.
2. **Keep injected wallets** (Rabby, MetaMask, Brave, anything EIP-6963) as the
   desktop fallback. Zero setup and already tested.
3. **Add a WalletConnect Cloud project id** for broader mobile coverage. Free,
   one environment variable, no code change:
   `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=...`.
4. **Use a Safe multisig** for the owner/treasury on any chain with value. That
   is an operations wallet, not an end-user connector.

Do not add Privy or another embedded-wallet provider unless you decide to pivot
away from wallet-only identity (see below).

## CLI-only top-up (gate 413)

Native ETH cannot be `mint()`ed from a contract, so on Anvil there is no runtime faucet
endpoint on the read-only API (gate 412: seed-time funding covers every demo wallet).
If a judge needs ETH mid-demo, the UI shows a copyable cast command and the operator
runs it against the local node:

```bash
cast rpc anvil_setBalance $ADDR 0x21E19E0C9BAB2400000 --rpc-url http://localhost:8545
```

`0x21E19E0C9BAB2400000` is 10 ETH. Time-travel to a deadline sweep on demand:

```bash
cast rpc anvil_mine 100 --rpc-url http://localhost:8545
```

The faucet stays quarantined to the ops plane — no POST /faucet, no chain key in the API
(ADR-0006).

## Option A — WalletConnect (recommended now)

**What it buys:** a modal with hundreds of mobile and desktop wallets, QR
pairing, and a familiar path for a judge on a phone.

**Setup:**

1. Create a free project at <https://cloud.walletconnect.com>.
2. Copy the project id.
3. Set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` in `.env` (or the VPS `.env`
   used as build args) and rebuild the web image.
4. Allowlist the production domain in WalletConnect Cloud if the project is
   restricted.
5. Verify: open the site, connect, sign a read-only message or a trial action
   on the demo chain.

**Cost:** free tier is enough for a demo; verify current limits in the
dashboard. **Risk:** public project id, no custody; do not treat it as a
secret.

## Option B — Coinbase Wallet (enabled) / Base Account (separate)

**What it buys:** a path for users already in the Base/Coinbase ecosystem, and
smart-wallet features if you later adopt Base Account.

**Status:** the classic **Coinbase Wallet** connector is enabled in
`apps/web/src/lib/wagmi.ts` and surfaced in the no-project fallback. It does not
need a WalletConnect project id. The web build and a connector-presence test
cover it.

**Base Account** is a different connector (`@base-org/account`). The current
`next.config.mjs` aliases that subtree off because the app does not use it. If
you want Base Account smart wallets, add its connector, remove the
`@base-org/account` / `@coinbase/cdp-sdk` aliases, and rebuild; test the bundle,
because the aliases exist to stop the Coinbase/x402 payment stack from leaking
into the browser.

**Cost:** no protocol fee for the classic connector; Base Account features have
their own provider terms. **Risk:** a new connector changes the bundle and the
wallet-modal UX; it does not change custody, since the user still signs.

## Scope note: this is EVM-only

The pasted DeFi architecture adds a separate Solana wallet-adapter path and
DeFi swap/approval flows. Neither belongs to this product: Crucible has no
Solana program, no token, no swap router and no portfolio. The EVM path here is
the escrow protocol described in the contract spec. A Solana/DeFi build is a
different application, not a connector choice; it needs its own ADR and threat
model.

## Option C — Privy (Google/email, embedded wallet, 4337)

**What it buys:** the PRD's onboarding: sign in with Google/email, an embedded
smart account, sponsored gas, no seed phrase.

**Setup:** create a Privy app, add the app id/client id, install the React SDK,
wrap the app, configure the embedded wallet and (optionally) a paymaster, and
replace the RainbowKit/wagmi account path. It is a product change, not a
configuration flag.

**Cost:** vendor pricing + gas sponsorship; embedded wallet infrastructure.
**Risk:** it changes the identity and custody model, the privacy surface, and
the "wallet-signed only" decision in ADR-0006. It also makes the agent operator
an embedded account rather than a self-custodied key, which affects the runner
key story. Treat it as a pivot: write a new ADR and a migration plan first.

## Option D — Other embedded/smart-wallet providers

Turnkey, Crossmint, thirdweb and Coinbase Smart Wallet cover similar ground.
The same pivot analysis applies: who holds the key, who pays gas, how the runner
key is separated, and what happens when the provider is down. Do not stack two
embedded providers.

## Option E — Safe (owner/treasury)

The contracts' `owner` can rewire only the optional reputation/identity
registries; the `treasury` receives the fee. On a chain with value, both should
be a Safe (or an equivalent multisig), not a hot wallet. The deployer key
should not remain the owner.

## Keeper wallet

The keeper only sends permissionless actions (`finalize`, sweeps). Use a
dedicated wallet with a small balance, not the deployer or treasury key. A
compromise costs gas, not escrow. `KEEPER_PRIVATE_KEY` is separate for this
reason.

## What to tell a user

> Bring an EIP-6963 wallet, use Coinbase Wallet, or scan with WalletConnect.
> Crucible never asks for a seed phrase, never holds your key, and never submits
> a transaction for you.
> The demo chain is an Anvil development chain and has no real value.

## Verification checklist

- `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` present in the build environment.
- The web image was rebuilt after changing it.
- Connect on desktop (injected), with the Coinbase Wallet button, and on mobile
  (WalletConnect if configured).
- Wrong-network guard shows the chain name and switches.
- A write action signs from the connected address; the API response contains no
  transaction submission.
