# Transaction Abstraction Baseline — Stage A

Status: **Baseline audit (Stage A of the transaction-abstraction directive).** Grounded in
the repository at commit range after `8828fe5` (2026-11-09). Nothing here is a claim about
production behavior that was not verified in the tree.

## 1. Current behavior in one paragraph

The application is 100% EOA wallet-signed, user-pays-gas. Every consequential EVM action is
built in `apps/web/src/lib/useTx.ts` and sent from the browser via wagmi
`sendTransactionAsync` (`useTx.ts:195`); the API holds **no chain keys** and exposes **no
transaction-submission endpoint** (ADR-0006). Server-side signing exists only in the keeper
(crank/settlement, `apps/keeper/src/main.ts:6`, serialized through a single-writer
`write-queue.ts:24-47`), the juror (Argus seat, `apps/juror/src/config.ts:70`), and the
funder (CDP USDC transfers on Base Sepolia, `apps/funder/src/server.ts:171`). RPC
transports are raw `http()` against publicnode/loopback (`apps/web/src/lib/networks.ts:263-277`,
`apps/api/src/server.ts:133,315`).

## 2. Signing surfaces (who signs what)

| Action | Signer | Builder | Notes |
|---|---|---|---|
| Agent register + stake | user wallet | `useTx.ts:286-295` | payable, bond as value |
| Trial create (reward escrow) | user wallet | `useTx.ts:269-284` | payable |
| File a break (challenge) | user wallet | `useTx.ts:360-369` | payable |
| Finalize | user wallet | `useTx.ts:371-373` | permissionless |
| Unstake / withdraw / add stake | user wallet | `useTx.ts:375-388` | two-step unstake→credit→withdraw |
| Treasury withdraw | **Safe UI** (calldata copied) | `treasury/page.tsx:159-166` | no tx from the web app |
| Run submit | runner key (EIP-712) | `useTx.ts:397-408` | wallet only relays calldata |
| Faucet / sponsorship | server (funder) | `app.ts:2068-2173` → `funder/server.ts:66-208` | USDC, not gas |
| SIWE auth | user wallet | `ForgeAuth.tsx:57-78` | see §3 |

## 3. SIWE and session state

- Full EIP-4361 flow in `apps/api/src/auth.ts`: challenge cookie + 5-min TTL
  (`:211-238`), exact-replay tolerance (`:593-607`), atomic single-use consume
  (`:623-625`), HMAC session token (`:302-316`), `__Host-` cookie, 7-day TTL.
- Nonce store is pluggable (`packages/agent-security/src/nonce-store.ts:278-283`):
  **Redis-backed in production** (Lua-atomic consume `:148-163`), in-memory/globalThis
  fallback in dev (`:192-199`). Risk: silent degradation if Redis is unreachable without
  `REDIS_REQUIRED=1` (`:119-125`).
- Session revocation is an in-process `Set` (`auth.ts:50-59`) — the "PG/Redis mirror"
  the comment promises does not exist; multi-instance logout fails open.

## 4. Provider / chain state

- API public client is **hardcoded `foundry`** (`server.ts:315`) with a boot-time
  chain-id proof against `CHAIN_ID` (default 31337, `server.ts:329-364`). Any Sepolia /
  mainnet path needs a per-chain client.
- Chain IDs pinned at `networks.ts:28-32` (1 / 11155111 / 31337); profile gate
  `profile.ts:55` requires 31337 for demo.
- `NEXT_PUBLIC_*` RPC URLs are baked into the browser bundle (`networks.ts:269-277`) —
  **an Alchemy key URL placed there leaks the key to every visitor.** Any Alchemy
  transport must be served behind the edge (`deploy/edge/rpc-gate/gate.mjs`), which
  fronts Anvil today and explicitly disclaims auth for value-bearing chains (`:14-18`).

## 5. Alchemy integration state

`integrations/alchemy/` contains demo scripts only (eth-demo, sol-demo, a standalone
HMAC-verified Notify receiver). **Nothing is imported by any app or package.** ADR-0020
governs the boundary: provider webhooks are hints, never settlement inputs; HMAC over
raw body; a durable webhook inbox (tables) is deliberately deferred and "needs its own
ADR" (`docs/adr/0020-...md:59-60`).

## 6. Solana state

Read-only devnet console (`apps/web/src/app/solana/page.tsx`: Phantom detection, connect
only, no web3.js, no signing). Campaigns support `chain: "solana"` devnet-only with a
hardcoded mainnet-beta refusal (`apps/api/src/campaigns.ts:424-425`). **No Anchor
program, no SPL code in-tree.** The rewards page only *reserves* Solana claims
("Reservation is not payment"). The native-SOL escrow rewrite is outstanding — matches
the directive's assumption.

## 7. Durability state (queues, outbox, idempotency)

- Postgres is the system of record (4 migrations; `forge_watch_events`, orgs/workspaces,
  runtime+rewards, STAMP foundation). PG pool required in production
  (`packages/agent-security/src/database.ts:33-37`).
- Redis is used for SIWE nonces only. **No BullMQ / job queue** exists.
- A real, tested outbox exists but is scoped to forge-watch telemetry only
  (`packages/forge-watch/src/outbox.ts:46-98`: SKIP LOCKED, lease, bounded backoff).
- Sponsorship queue and funder caps are in-memory (`apps/api/src/sponsorship.ts:15-91`,
  `apps/funder/src/server.ts:217-225`) — restart wipes state; multi-replica unsafe.
- Faucet → funder allocate is a plain `fetch` with **no idempotency key**
  (`app.ts:2106-2130`).

## 8. Gas / sponsorship / account abstraction

**None.** No ERC-4337, bundler, paymaster, or Gas Manager code anywhere. ADR-0006
explicitly rejected sponsored gas as a product decision (`:22-29`); `docs/gates.yml:1230`
lists "relayer sponsorship caps" as an unimplemented gate. A relayer/sponsor rollout
requires a new ADR superseding that boundary — that is the first required migration step,
not code.

## 9. Defects and risks for a sponsorship/relayer rollout

1. In-memory sponsorship queue / funder caps / session revocation / dev nonce fallback —
   all lose state on restart (§3, §7).
2. No money-path outbox or idempotency on the faucet path (§7).
3. API chain client hardcoded to foundry (§4) — blocks Sepolia sponsorship.
4. RPC URLs are client-baked — key leakage hazard (§4).
5. No durable inbound webhook inbox; Alchemy code is unwired (§5).
6. Keeper nonce management is process-local — single-instance by design; a second
   replica collides nonces (`write-queue.ts:5-14`).
7. Client tx lifecycle has no retry/resubmit or fee bump (`useTx.ts:195-207`).
8. Solana has no signing infrastructure to build a devnet sponsor on (§6).

## 10. Required migration steps (order)

1. New ADR: relayer / sponsored-execution boundary (supersedes the ADR-0006 rejection
   for the specific sponsored path; keep ADR-0006 invariants for everything else).
2. Durable nonce/revocation/queue state: move session revocation and the sponsorship
   queue into Postgres/Redis (Stage H prerequisites).
3. Per-chain server client + chain-id validation beyond 31337.
4. Alchemy transport behind the edge gate; app credentials per environment
   (demo / preview / production) — keys never in `NEXT_PUBLIC_*`.
5. Idempotency keys on all money-path submissions; outbox extension from telemetry to
   transaction intents (persist intent before submission).
6. Gas Manager policy (preview: Sepolia first), budget caps, ledger, kill switch.
7. Solana devnet adapter as an independent track (native-SOL escrow rewrite first).

## 11. Manual steps requiring account-owner action

- Create three Alchemy applications (demo / preview / production) with least-privilege
  keys; record app IDs. Verify current plan entitlements for Gas Manager and (if ever
  needed) Solana fee sponsorship — the latter requires Enterprise access per Alchemy
  docs; do not plan around it.
- Provide `ALCHEMY_RPC_URL` (server-only) and webhook signing keys via the VPS root-owned
  env files (`/etc/crucible/*.env` pattern from the deployment runbook).
- Confirm whether `.env` `DEPLOYER_PRIVATE_KEY` (`0xda78…`) is a disposable test key —
  it is not one of the standard published Anvil keys; verify before any reuse.

## 12. Reusable code that already exists

- `useTx.ts` builder pattern (named, schema-shaped calldata builders — the "named
  operations" the directive wants are half-built already).
- `packages/smith-sdk/src/client.ts` (public + wallet clients, per-method gas cache).
- forge-watch outbox + `appendWithOutbox` atomic insert pattern — the blueprint for a
  transaction-intent outbox.
- Redis nonce store (atomic consume) — the pattern for durable idempotency.
- Edge RPC gate (method allowlist, rate limit, batch cap) — the natural seat for an
  Alchemy transport.
