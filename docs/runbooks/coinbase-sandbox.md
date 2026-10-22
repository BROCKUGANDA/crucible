# Runbook: Coinbase CDP CLI and Sandbox

## Two CLIs, two keys

| CLI | Package | Environment | Key |
|---|---|---|---|
| `coinbase` | `@coinbase/coinbase-cli` | Advanced Trade + x402 (`live`) | A **live** CDP API key scoped to a portfolio |
| `cdp` | `@coinbase/cdp-cli` | CDP Sandbox / custodial APIs (`sandbox`) | A **Sandbox** CDP API key |

Do not use a live key for sandbox work, and do not point the Advanced Trade CLI
at sandbox balances. They are different products.

Both CLIs are installed globally on this machine (`coinbase 0.0.10`,
`cdp 2.0.119`). The Qoder skills are installed at `C:\Users\HP\.qoder\skills`
(`coinbase*`, `cdp-*`, and the `coinbase-agent-skill` from
`coinbase.com/skill.md`).

## Feature flags: one `.env`, both keys

Both modes can live in the same file; the flag selects which one runs:

```bash
CDP_ENV=sandbox                 # demo / hackathon default
CDP_ENABLE_LIVE=0               # live is refused unless this is 1

# Either the JSON path or the inline pair for each mode:
CDP_SANDBOX_API_KEY_FILE=C:\Users\HP\Downloads\sandbox-api-key.json
CDP_SANDBOX_API_KEY_ID=
CDP_SANDBOX_API_KEY_SECRET=
CDP_LIVE_API_KEY_FILE=C:\Users\HP\Downloads\live-api-key.json
CDP_LIVE_API_KEY_ID=
CDP_LIVE_API_KEY_SECRET=

CDP_ALLOW_PLAINTEXT_SECRETS=1   # only where the OS keychain is unavailable
CDP_SANDBOX_BASE_URL=https://sandbox.cdp.coinbase.com
```

The wrapper selects the `sandbox` or `live` pair by `CDP_ENV`; a mode can use
either its key-file path or its ID/secret pair. `CDP_API_KEY_FILE` remains an
optional single-key fallback. A live run requires both `CDP_ENV=live` and
`CDP_ENABLE_LIVE=1`; the demo never sets the second flag.

If both modes are in one `.env`, use the explicit `CDP_SANDBOX_*` and
`CDP_LIVE_*` names. Do not reuse `CDP_API_KEY_ID`/`CDP_SECRET` for both: the
duplicate is ambiguous and the last value wins.

These flags belong to the **agent tooling**, not the Crucible web app. The app
does not call the CDP API; the VPS flag keeps the operational default explicit.

## Set up the CDP Sandbox for an agent

1. Sign in to the [CDP Portal](https://portal.cdp.coinbase.com/) and switch to
   **Sandbox** mode (top-left switcher — not Live).
2. **Settings → Create Secret API Key**, enable the **Accounts** permission,
   download the JSON file, and store it outside this repository.
3. Set either `CDP_SANDBOX_API_KEY_FILE` or the
   `CDP_SANDBOX_API_KEY_ID`/`CDP_SANDBOX_API_KEY_SECRET` pair, and keep
   `CDP_ENV=sandbox` / `CDP_ENABLE_LIVE=0` in `.env`. Never commit the key;
   `.gitignore` covers `cdp_api_key*.json`, `.cdp/` and `*.cdp-key.json`.
4. Configure and list:
   ```bash
   npm run cdp:sandbox
   ```
   The wrapper imports the key, switches to `sandbox`, and runs a read-only
   `GET /platform/v2/accounts`. It refuses to run when the path is empty or the
   file is missing, never prints the key, and refuses live unless
   `CDP_ENABLE_LIVE=1`.
5. Create a dedicated account (the CLI does **not** auto-prepend the base path):
   ```bash
   MSYS_NO_PATHCONV=1 cdp api -X POST /platform/v2/accounts \
     name="Crucible Agent Sandbox" -e sandbox
   ```
   Git Bash needs `MSYS_NO_PATHCONV=1`; PowerShell does not. A 409 means the
   name already exists — list the accounts instead.
6. Fund it in the Portal: **Sandbox → Accounts → click the account → Add test
   assets → 10 USDC**. The CLI cannot add simulated balances. Hard-refresh the
   portal if the new account is not visible.
7. Verify:
   ```bash
   MSYS_NO_PATHCONV=1 cdp api /platform/v2/accounts -e sandbox
   MSYS_NO_PATHCONV=1 cdp api /platform/v2/accounts/$ACCOUNT_ID/balances -e sandbox
   ```
   Use the long form; the `cdp accounts balance` singular shortcut is not present
   in every CLI version. Our 2.0.119 has `cdp accounts balances <id>`, but the
   long form is the documented path.

A 401 on the Sandbox almost always means a **Live** key or a key created in Live
mode. Create a new Secret API Key while the portal is in Sandbox mode. A 403
means the key was created without the **Accounts** permission; that cannot be
edited after creation, so make a new key.

That diagnosis needs proof before it needs a new key: run the pair against
**both** hosts. On 2026-10-21 the stored sandbox pair and the stored live pair
each returned 401 against `sandbox.cdp.coinbase.com` **and** against
`api.cdp.coinbase.com`, which rules the mode out and leaves the credential —
the CLI signs a JWT from a PEM EC key or an Ed25519 seed, and a Portal *Client*
key string is neither.

## Transfers: validate, then execute, with headers on both calls

```bash
npm run cdp:transfer -- --validate-only          # inspect fees, move nothing
npm run cdp:transfer                             # validate → fees → execute → poll → summary
npm run cdp:transfer -- --amount=1.00 --target=0xC05691A17dce4e65Be539adbd7b82be48f933F95
```

`scripts/cdp-transfer.mjs` prints the request and response headers of every call
with credential values redacted, because three of this API's behaviours are only
visible there:

- **A header token must start with an uppercase letter.** `cdp api` reads a bare
  `Name:value` argument as an HTTP header, and its parser decides by looking at
  the first character: `Idempotency-Key:abc` is a header, `idempotency-key:abc`
  is silently a body field. Lowercasing one of these is a bug that still returns
  200.
- **`-v`, not `-i`, keeps the response parseable.** `--include` writes the header
  block to *stdout*, ahead of the JSON body; `--verbose` writes the same block to
  *stderr*. The wrapper uses `-v`, parses the `> `/`< ` lines, and prints them
  itself with `Authorization` and friends redacted.
- **`Idempotency-Key` is what makes a retry safe.** The wrapper derives it from a
  run id printed at the top of every run, so a transfer whose connection dropped
  mid-flight can be re-run as `CDP_RUN_ID=<id> npm run cdp:transfer` and the API
  replays its first answer instead of paying twice.

The validate call sends `validateOnly:=true` **and** `execute:=false`; the API
returns 400 without the second one, and the printed `fees` array is the point of
running it. Execution against `live` is refused unless `CDP_ENABLE_LIVE=1` *and*
`--execute-live` are both present — one of those is a feature flag, the other is
a human deciding.

## What the Sandbox is — and is not

- It is an isolated, simulated **custodial** environment with the same
  endpoints and response shapes as Live.
- It has **no blockchain or testnet connectivity**. Sandbox deposit destinations
  are placeholders; do not send real or testnet crypto to them.
- Transfers are simulated: webhooks fire and statuses change, but no chain or
  fiat rail moves. The reserved test addresses and emails in the CDP Sandbox
  docs are the fixtures.
- It is **not** a Base testnet and it does not make x402 payments. x402 uses
  USDC on Base and is a live payment rail (5 USDC per-payment cap in the
  catalog CLI).
- Onramp/Offramp are live products with trial limits, KYC and compliance
  requirements. They are not part of the Crucible app and are not configured by
  this repository.

## Advanced Trade CLI (live, only with explicit approval)

The `coinbase` CLI places **real orders** and makes **real x402 payments**:

```bash
coinbase env live --key-file <path-to-live-key.json>
coinbase balance
coinbase x402 resources q==nansen
```

For an agent:

- Use a dedicated Coinbase portfolio and a key scoped only to it.
- Start read-only: `coinbase balance`, `coinbase products *`,
  `coinbase orders list/get/fills`, `coinbase portfolios list/get`.
- Do not grant trade/transfer or `coinbase *` without an explicit, per-task
  budget and human approval. x402 payments have a 5 USDC per-payment cap and
  settled payments are irreversible.
- Keep the live key out of the repo and out of sandbox profiles.

## Troubleshooting

- `coinbase`/`cdp` not found: the npm global bin is
  `C:\Users\HP\scoop\persist\nodejs\bin`; add it to the shell PATH or use the
  full path. Both commands are installed.
- `CDP_SANDBOX_API_KEY_FILE is empty, and the ..._API_KEY_ID/_SECRET pair is
  incomplete`: the wrapper is deliberately refusing; set one of the two forms.
- `No CDP Sandbox key file`: the path is wrong or the file was moved.
- `Environment "sandbox" has no stored credentials`: run
  `npm run cdp:sandbox` after setting the key.
- `401 Unauthorized` against Sandbox: the key is a Live key or was created in
  Live mode. Make a new key in Sandbox mode; the two modes are separate.
- `403` on create: the key lacks the **Accounts** scope. Create a new key with
  it enabled; existing keys cannot be modified.
- `404` on `/accounts`: use the full `/platform/v2/accounts`; the CLI does not
  prepend it.
- `Could not retrieve API key secret from OS keychain`: set
  `CDP_ALLOW_PLAINTEXT_SECRETS=1` in `.env` only if this harness cannot reach the
  keychain; the CLI then stores the secret in its own config file. Remove the
  profile with `cdp env sandbox --remove` when rotating.
- An empty account list is normal on a fresh Sandbox; create/fund the account in
  the Portal.

## Related

- [CDP Sandbox quickstart](https://docs.cdp.coinbase.com/get-started/sandbox/quickstart)
- [Coinbase for Agents skill](https://docs.cdp.coinbase.com/coinbase-for-agents/skill.md)
- [x402 overview](https://docs.cdp.coinbase.com/x402/how-it-works)
