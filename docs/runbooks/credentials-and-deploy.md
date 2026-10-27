# Credentials and deploy — where everything comes from

Checklist for taking this repo from a fresh clone to a live deployment.
Local status below was measured on 2026-10-27 (SET/EMPTY only — values are
never written here). `.env` is gitignored; nothing on this page goes into git.

## 0. If you pasted a key into a chat, rotate it first

An `api.developer.coinbase.com` RPC URL with an embedded key was pasted into
an agent chat during this work. Treat it as exposed: rotate it at
https://portal.cdp.coinbase.com, store the new one as an env var
(`BASE_RPC_URL` for a Base endpoint), and never paste keys into chats, docs,
or screenshots again. This repo has no `BASE_RPC_URL` reader yet — add the
reader before the value, so a set var always means a wired var.

## 1. Credential table

| Credential | Env var | Where to get it | Local `.env` |
|---|---|---|---|
| Session signing secret | `AUTH_SECRET` | Generate: `openssl rand -base64 48` (or `node -e "console.log(require('crypto').randomBytes(36).toString('base64'))"`). ≥16 chars. | SET (generated 2026-10-27) |
| Juror voting key | `JUROR_SEAT_PRIVATE_KEY` | Must be a **granted Argus seat** on the target chain (`commitVote` reverts otherwise; `apps/juror` checks `isArgus` at startup). Demo chain: Anvil dev-mnemonic accounts #1/#2/#3. New chain: grant first, then set. Never a random key. | MISSING (by design — see §2) |
| CDP sandbox key | `CDP_SANDBOX_API_KEY_FILE` or `CDP_SANDBOX_API_KEY_ID` + `CDP_SANDBOX_API_KEY_SECRET` | https://portal.cdp.coinbase.com → create Secret API key, sandbox env. Guide: https://docs.cdp.coinbase.com/wallets/quickstart/api-key-auth. Full local setup: `docs/runbooks/coinbase-sandbox.md`. | ID+SECRET set; FILE empty (either mode works) |
| CDP live key | `CDP_LIVE_API_KEY_ID`/`_SECRET`/`_FILE` + `CDP_ENV=live` | Same portal, live environment. Keep `CDP_ENABLE_LIVE=0` until mainnet readiness (Phase 1) is signed. | empty (correct for now) |
| Funder URL (host scripts) | `FUNDER_URL` | Local: `http://127.0.0.1:8788`. In compose the API uses `http://funder:8788` (already wired). | SET |
| Keeper signer | `KEEPER_PRIVATE_KEY` | Operator wallet. Demo: Anvil dev key #0 works only on loopback `:31337`; anything else refuses rather than sign with a public key. | SET |
| Base Sepolia test funds | (in the CDP wallet) | Faucet: https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet into the funder's CDP address, or `requestFaucet` on the sandbox wallet. The funder dispenses USDC on Base Sepolia (ADR-0015); with no funds it reports unconfigured, it does not fake a transfer. | fund on demand |
| Mainnet RPC pair | `MAINNET_RPC_URL` / `MAINNET_RPC_FALLBACK_URL` | Any **archive** chain-id-1 endpoint at the pinned block (drpc + publicnode measured 2026-10-26; only drpc served the fork block). | SET |
| Sponsor on-ramp landing | `NEXT_PUBLIC_ONRAMP_URL` | Coinbase Pay landing: `https://pay.coinbase.com/landing`. Live sessions are minted per-click through the funder when CDP is configured. | SET |
| Warden push channel | `WARDEN_WEBHOOK_URL` | Any HTTPS webhook that accepts `{"text": ...}`. Empty disables delivery (gate 807); the keeper never logs the value. | empty (correct for demo) |

## 2. Why the juror key stays empty locally

A random `JUROR_SEAT_PRIVATE_KEY` would produce a service that reports
healthy and reverts every vote — worse than an honest refusal. Set it only
to an address the trials contract granted on the chain you are running:

- Demo/Anvil: dev accounts #1/#2/#3 (worthless on purpose).
- Any other chain: `cast` the grant first, then set the key, then watch one
  patrol find (or correctly not find) a dispute.

## 3. Deploy-box steps (VPS)

1. Copy `.env` values to the box by hand (never `scp .env` over an
   untrusted link; never commit it). Minimum live set: `AUTH_SECRET`,
   `AUTH_ORIGIN` (= box URL), `TRUST_PROXY`, `KEEPER_PRIVATE_KEY`,
   `TRIALS_ADDRESS`/`ALLOY_ADDRESS`, `MAINNET_RPC_URL` pair,
   `NEXT_PUBLIC_ONRAMP_URL`. Add `JUROR_SEAT_PRIVATE_KEY` and CDP keys only
   when those seats/wallets exist on the target chain.
2. The funder starts without CDP keys and reports `configured:false`
   (`/health`, `/allocate`, `/onramp/session` → 503 with reason). That is
   the correct degraded state, not a failed deploy.
3. `npm run verify:all`, then `npm run test:e2e`, then promote through the
   normal ladder (develop → staging → main). Do not merge stale local
   branches into the box; see the worktree note in `HARDENING.md`.
4. Live `/api/auth/nonce` must stop returning 503 `auth_unconfigured` once
   `AUTH_SECRET` is set — that 503 today is the config gate working.

## 4. Mainnet go-live (from the CDP integration notes, adapted)

1. Swap the funder wallet `network: "base-sepolia"` to `"base"` and remove
   `requestFaucet` (testnet-only). No code path should reference Sepolia
   after this except the refused-by-name fork guard.
2. Fund the live wallet with real ETH (transfer or onramp) — plus the
   Phase-1 sign-offs in `docs/business/roadmap.md`. Code readiness without
   the five signatures is still a red preflight.
3. Use a dedicated production CDP API key + Wallet Secret (cleaner audit
   logs than reusing sandbox credentials).
4. Full guide: https://docs.cdp.coinbase.com/wallets/quickstart/api-key-auth.
