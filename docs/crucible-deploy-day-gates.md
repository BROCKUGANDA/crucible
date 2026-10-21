# Crucible - deploy-day gates

Corrected for the built system: native ETH on Anvil, wallet-signed writes, a
read-only API, no Postgres/Redis/KMS/pause. The pasted 50-gate
USDC/Postgres/KMS checklist does not describe this deployment.

**The one rule:** money moves only through the contract's pull ledger. Never
settle by hand.

## Before merge

- [ ] `npm run verify:all` green: typecheck, 887 TypeScript tests, 135 Foundry tests (131 run, 4 fork tests skipped without a mainnet RPC).
- [ ] `forge fmt --check`, `forge test`, coverage with `--ir-minimum`, and slither are green.
- [ ] The six invariants hold: balance = free stake + pending credit + escrow; escrow and pending never exceed balance; bond rule; terminal verdicts; tier range.
- [ ] Source-gated promotion: CI on the exact source commit is green; the ladder waits and refuses a red gate.
- [ ] `gitleaks` history scan is green; no `.env`, key JSON, or seed phrase is staged.
- [ ] `next build` and the dependency audit are green.

## Contracts

- [ ] Native ETH only: no USDC, ERC-20, or EIP-2612 permit; `createTrial` is payable.
- [ ] 5% fee deducted from the agent, not added to the sponsor; 20% bond; 1% break stake.
- [ ] EIP-712 run signature binds trial, agent, run hash and deadline; high-s rejected; replay impossible; relay is permissionless.
- [ ] Self-break and self-claim both revert.
- [ ] Three Argus seats, 2-of-3 reveal; commits close on the 24h clock; 3-day timeout settles for the agent.
- [ ] Settlement runs once; payouts use the pull ledger; `withdraw` is nonReentrant and the UI exposes it.
- [ ] Reputation backfill is canonical and write-once per trial; an ERC-8004 outage never blocks a verdict.
- [ ] No pause and no upgrade, intentionally: an incident is a redeploy. The owner holds no funds.

## Indexer and API

- [ ] Cursor means "next block": `head + 1` is caught up, only beyond it is a reset.
- [ ] `/api/ready` is true with lag 0 and no sync error; `/health` and `/ready` tell the same story.
- [ ] `/stream` serves one snapshot, is exempt from the read budget, and has a 200-stream ceiling.
- [ ] Per-IP rate limit, CORS allowlist, body cap, HTTPS/HSTS boot checks.
- [ ] The API holds no chain key and submits no transaction; auth origins are bound to configuration.
- [ ] DLQ and breaker state are visible; a real chain reset rebuilds instead of freezing.
- [ ] Mobile: 320px and 390px have no horizontal overflow; the hamburger opens the nav sheet; reduced motion is respected.

## Deploy

- [ ] CI builds web and API before the swap; the swap uses `--no-deps`; anvil keeps its chain.
- [ ] The host `.env` is never overwritten or synced.
- [ ] The shared edge is attached to `crucible_default`; the repair cron writes to `/home/ubuntu/crucible-edge-attach.log`; `/api/health` answers 200.
- [ ] `assert-deployment.sh` matches the fee, bond rule, committee, roles and money invariant.
- [ ] Public surface: site 200, `/api/ready` green, `/hall` rows quote real settlement and identity transactions.
- [ ] No immutable image tags or rollback button: rollback is `git revert` + redeploy; contracts cannot roll back.

## Security and operations

- [ ] Key inventory reviewed: owner, treasury, keeper, Argus seats; the owner has no funds and cannot settle.
- [ ] Keeper passes are serialized; the breaker covers the RPC hop; the kill switch is outside the breaker.
- [ ] Voice key stays server-side; `/voice/status` is configured; `VOICE_DISABLED=1` silences it without a deploy.
- [ ] CDP Sandbox profile: `CDP_ENV=sandbox`, `CDP_ENABLE_LIVE=0`; live is refused; a valid Sandbox Secret API Key with the Accounts scope is required.
- [ ] Incident: preserve the transaction and logs, do not settle manually, do not invent a pause.
- [ ] No secret in code or git history; the key JSON and `.env` are ignored.

## Not applicable to this deployment

USDC/Base, ERC-20/permit, 15% fee, Privy/ERC-4337, Ponder/Postgres, Redis/BullMQ,
IPFS/Pinata, AWS KMS, Sentry/OpenTelemetry, pause/canary, outbox, idempotency
keys on money POSTs, append-only-ledger-with-derived-balances, and a DB-to-chain
reconciliation job. Writes are wallet-signed; the keeper and Warden are serial.
Those gates describe a different product.

## Still open for production

No professional audit or formal verification; no pause or upgrade path; demo ETH
keys; no KMS or epoch rotation; no immutable image/rollback path; no Sentry,
OpenTelemetry, RED metrics or SLOs; no database reconciliation; no public
transparency page, SBOM, ToS or sanctions checks; no chaos drill. CDP Sandbox is
still blocked on a valid Sandbox key (the available keys answer 401).

**Three gates that catch most outages here:** the source-gated promotion, the
`head + 1` cursor rule, and the edge attachment with a writable repair log.
