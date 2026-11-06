# Security architecture

One view of what actually runs, who can make it do things, and where the boundaries are
drawn. It describes the tree as it is, not the target; the target is
[`docs/enterprise/target-architecture.md`](../enterprise/target-architecture.md) and the
threats are [`docs/enterprise/security-threat-model.md`](../enterprise/security-threat-model.md).
Every claim below names the file that carries it, so a reviewer can check it rather than
believe it.

## 1. Services, and the one thing each can do

| Service | Role | Can move money? | Can sign? | Source |
| --- | --- | --- | --- | --- |
| `web` | Next.js UI, server-rendered | no | no — the browser's wallet signs | `apps/web` |
| `api` | read models, voice, auth, MCP | no | **holds no chain key by design** (ADR-0006) | `apps/api/src/server.ts` |
| `keeper` | serial finaliser: `finalize`, `reclaimExpired`, backfill | yes, but only calls permissionless entry points | yes — one `PRIVATE_KEY` | `compose.yaml`, ADR-0007 |
| `juror` | an Argus seat: commit and reveal a verdict | no — its verdict is weighted by protocol rules | yes — `SEAT_PRIVATE_KEY` | `apps/juror`, `docs/adr/0004-*` |
| `funder` | demo test-ETH allocation | no chain key; calls a hosted wallet API | no | `apps/funder` |
| `anvil`, `seed` | local chain and its one-shot fixture | n/a | test keys only, refused off-`31337` | `crucible-contracts/script/` |

`docker compose` gives a chain credential to exactly two services — `keeper` and `juror` —
and the deploy workflow refuses to start the keeper on a host that has none
(`.github/workflows/deploy.yml`). The API's credentials are `AUTH_SECRET` and two provider
keys; it is the service the public internet talks to, and it cannot spend anything. That is
the whole of ADR-0006, and it is the reason a full API compromise does not reach a wallet.

## 2. Where a request lands

```
browser ──HTTPS──> edge (Caddy) ──> web ──> api ──read-only RPC──> chain
                     │                       │
                     └── /anvil refused ──────┴── provider keys (server-side only)
```

- **The edge is a policy point, not a convenience.** `deploy/edge/` provisions a gate that
  refuses to proxy `/anvil` through to the node, so a public URL cannot become an
  unrestricted RPC. Its refusals are tested in `test/edge/` (`npm run test:edge`) — the
  suite that exists because that gate once shipped proxying the node straight out, green.
- **Response policy** is in `apps/web/next.config.mjs` and is explained in
  [`docs/security-headers.md`](../security-headers.md): CSP with a nonce, `nosniff`, frame
  and referrer restrictions, and HSTS applied where the protocol is actually known.
- **Every spend is initiated by the user's own wallet.** `apps/web/src/lib/useTx.ts` builds
  the transaction, wagmi sends it, and the API is never in the path. The builders are pinned
  by decode round-trip tests in `apps/web/test/wallet.test.ts`, including which calls carry
  `msg.value` — because a builder that drops the value compiles, decodes, and can never land.

## 3. Untrusted code: the highest-priority boundary

A submitted agent runs in `packages/forge-runner/src/sandbox.ts`.

- **Isolation is a container, not a microVM.** The reason is stated where it is decided: the
  enforcement primitives that matter are kernel-level (network namespace, cgroups, mount
  flags, capability set), and they are *measured*, not asserted — `test/sandbox-docker.test.ts`
  runs real containers and asserts that egress fails, that an over-allocator is OOM-killed
  while the parent keeps serving, that a wall-clock overrun is terminated, that stdout past
  the cap is truncated, and that writes outside `/tmp` and `/work` are refused. Six tests,
  and when Docker is absent they report SKIPPED with a printed reason rather than green.
- **The base filesystem is read-only, the capability set is dropped, and there is no
  fallback.** `allowLocalFallback` was deleted from the type: an unisolated run cannot be
  produced by an argument any more, only by the test-only `forceLocal` flag, whose artifact
  is marked `degraded` and says so in the manifest and on the status line.
- **No daemon socket, no host paths, no secrets in the job.** The runner passes the agent a
  purpose-scoped environment; the module graph the agent's code lives in is scanned by
  `npm run lint:imports --workspace @crucible/forge-runner` (gate 502) so it cannot reach
  `fs`, `child_process`, `net` or any wallet library.
- **The pinned suite is never shown to the agent.** `runner.ts` hands the model the one file
  it may edit (`EDITABLE_GLOBS = ["src/Forge.sol"]`) and refuses a patch that touches the
  tests (`touchesTests`, `packages/forge-runner/src/agent.ts`) — the guard exists because it
  once answered "safe" for a diff that could have rewritten them.

## 4. Money rules the architecture cannot route around

- Settlement writes a **pull ledger**; `withdraw()` is a separate transaction (ADR-0003).
  No code path pushes ETH from a settlement.
- `finalize` and `reclaimExpired` are **permissionless** and revert when already settled —
  the revert is the idempotency guarantee, and per-trial error isolation lives in the warden.
- The escrow has **no `receive()`**: it cannot passively take ETH, so the conservation
  invariant `balance == totalStakes + totalPending + escrowed` is an equality that a fuzz
  campaign tries to break on every commit (`crucible-contracts/test/Invariants.t.sol`).
- EVM-side authority cannot be granted by configuration: the v1 escrow has no upgrade, pause
  or owner-withdraw function at all. Its `owner` is `immutable`, set in the constructor
  (ADR-0021), and gates only whether the reputation bridge is wired
  (`crucible-contracts/contracts/CrucibleTrials.sol:321-329`) — a privilege the contract
  deliberately keeps, because turning reputation off must not require a redeploy. The fee is
  `FEE_BPS = 500`, asserted against the deployed contract by
  `crucible-contracts/scripts/assert-deployment.sh:102` on every deploy.

## 5. Environments do not share anything

ADR-0020 names them; `scripts/deploy-network.mjs` enforces it. Each of `local`, `testnet`
and `production` binds an explicit chain id, RPC variable and deployment manifest; the
script asks the node its `eth_chainId` **before** signing anything and refuses a mismatch,
refuses a missing key, and refuses to use an Anvil well-known key anywhere a real chain
could be reached (`DevKeyScript` in `crucible-contracts/script/Deploy.s.sol`, which exists
because `vm.envOr("PRIVATE_KEY", DEFAULT_PK)` meant a forgotten variable silently deployed
with a key everyone knows).

## 6. What is not here, stated plainly

- **No durable store.** The indexer is in-memory (ADR-0008) and the API keeps no database.
  `packages/agent-security/src/{database,cache,queue}.ts` implement ADR-0023's PostgreSQL /
  Redis / BullMQ layer, and nothing on a runtime path imports them; their service-backed
  tests skip with a printed reason because CI runs no database. Treat that layer as designed
  and unit-asserted, not as an operational dependency.
- **No external audit.** The plan is [`docs/audit-plan.md`](../audit-plan.md); nothing in
  this repository constitutes one.
- **The verifier image default is a mutable tag.** An operator who does not set
  `CRUCIBLE_VERIFIER_IMAGE` gets a run that honestly reports the tag it used and is not
  pinned to a digest.
- **Alerting reaches the dead-letter queue, not a person, on this deployment.**
  `packages/warden` can notify; the keeper attaches no notifier, so nothing is delivered
  (recorded in `HARDENING.md`).
