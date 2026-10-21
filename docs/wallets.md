# Wallets: what to connect, and what it costs to set up

The app already signs its on-chain actions with a connected wallet: create a
trial, register an agent, claim a trial, file a break, finalize a window and
withdraw a credit. The current stack is
**wagmi v2 + RainbowKit** with injected wallets and WalletConnect. The API holds
no chain key (ADR-0006).

This page is a decision guide, not an integration. Pick one path, set the
configuration, and rebuild the web image: `NEXT_PUBLIC_*` values are baked at
build time.

## Recommendation for the current demo

1. **Keep injected wallets** (Rabby, MetaMask, Brave, anything EIP-6963). Zero
   setup, best desktop demo, and it is already tested.
2. **Add a WalletConnect Cloud project id** for mobile. Free, one environment
   variable, no code change: `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=...`.
3. **Use a Safe multisig** for the owner/treasury on any chain with value. That
   is an operations wallet, not an end-user connector.

Do not add Privy or another embedded-wallet provider unless you decide to pivot
away from wallet-only identity (see below).

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

## Option B — Coinbase Wallet / Base Account

**What it buys:** a path for users already in the Base/Coinbase ecosystem, and
smart-wallet features if you adopt Base Account.

**Setup:** add the `coinbaseWallet` connector in `apps/web/src/lib/wagmi.ts` and
remove the matching webpack aliases in `apps/web/next.config.mjs`
(`@base-org/account`, `@coinbase/cdp-sdk`) once the connector is actually
reachable. Test the build, because the current aliases exist to stop the
Coinbase/x402 bundling from leaking into the browser.

**Cost:** no protocol fee for the connector; Base Account features have their
own provider terms. **Risk:** a new connector changes the bundle and the
wallet-modal UX; it does not change custody, since the user still signs.

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

> Bring an EIP-6963 wallet or scan with WalletConnect. Crucible never asks for
> a seed phrase, never holds your key, and never submits a transaction for you.
> The demo chain is an Anvil development chain and has no real value.

## Verification checklist

- `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` present in the build environment.
- The web image was rebuilt after changing it.
- Connect on desktop (injected) and mobile (WalletConnect).
- Wrong-network guard shows the chain name and switches.
- A write action signs from the connected address; the API response contains no
  transaction submission.
