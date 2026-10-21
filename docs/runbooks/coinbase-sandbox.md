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

## Set up the CDP Sandbox for an agent

1. Sign in to the [CDP Portal](https://portal.cdp.coinbase.com/) and switch to
   **Sandbox** mode.
2. **Settings → Create secret API key**, download the JSON file, and store it
   outside this repository (for example
   `C:\Users\HP\Downloads\cdp_api_key.json`).
3. Set the path in `.env`:
   ```bash
   CDP_ENV=sandbox
   CDP_API_KEY_FILE=C:\Users\HP\Downloads\cdp_api_key.json
   CDP_SANDBOX_BASE_URL=https://sandbox.cdp.coinbase.com
   ```
   Never commit this file. `.gitignore` covers `cdp_api_key*.json`, `.cdp/`
   and `*.cdp-key.json`.
4. Configure and verify:
   ```bash
   npm run cdp:sandbox
   ```
   The wrapper imports the key into the `cdp` CLI, switches to the sandbox
   environment, and runs a read-only `cdp accounts list`. It refuses to run when
   the path is empty or the file is missing, and it never prints the key.
5. Create and fund a **Sandbox account** in the Portal: **Sandbox → Accounts →
   Create test account**, then add simulated USD/USDC/USDT balances. The CLI
   cannot fund it from a blockchain; Sandbox balances are simulated only.
6. Verify:
   ```bash
   cdp accounts list
   cdp accounts balances <accountId>
   ```

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
- `CDP_API_KEY_FILE is empty`: the wrapper is deliberately refusing; download the
  Sandbox key and set the path.
- `No CDP Sandbox key file`: the path is wrong or the file was moved.
- `Environment "sandbox" has no stored credentials`: run
  `npm run cdp:sandbox` after setting the key.
- An empty account list is normal on a fresh Sandbox; create/fund the account in
  the Portal.

## Related

- [CDP Sandbox quickstart](https://docs.cdp.coinbase.com/get-started/sandbox/quickstart)
- [Coinbase for Agents skill](https://docs.cdp.coinbase.com/coinbase-for-agents/skill.md)
- [x402 overview](https://docs.cdp.coinbase.com/x402/how-it-works)
