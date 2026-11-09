# Deployment profiles

One codebase, three profiles, never a browser toggle. `CRUCIBLE_PROFILE` selects a
pre-approved configuration at boot; the API refuses to start when the host does not meet
the profile's invariants. The long form is in
`Crucible_Public_Demo_and_Production_Infrastructure_Runbook.md`; this page is the part
the code enforces.

## What this build implements

| Profile | Boots? | Invariants enforced at startup |
|---|---|---|
| `demo` (default) | yes | `CHAIN_ID=31337`; `REAL_VALUE_OPERATIONS=0`; the RPC's own `eth_chainId` must equal `CHAIN_ID`; `TRIALS_ADDRESS` must have bytecode (`verifyChainAtBoot`) |
| `preview` | **no — refused** | needs Sepolia contracts, verified bytecode, durable PostgreSQL/object storage, separate testnet secrets |
| `production` | **no — refused** | needs the signed deployment manifest, two verified Safes, audit sign-off, durable state, on-call and backup drills |

The chain id is never taken from a client or from `NEXT_PUBLIC_*`; the API asks the
configured RPC (`eth_chainId`) and refuses on a mismatch. The refusals live in
`apps/api/src/profile.ts` and are unit-tested in `apps/api/test/profile.test.ts`.

## Host files (never in git)

`/etc/crucible/{demo,preview,production}.env`, root-owned, mode `0600`. `SET` and `EMPTY`
only in documents — values are copied to the host by hand, never `scp`'d, never tarred
(`.gitignore` retires `*.tar.gz` for exactly this reason).

```dotenv
# demo — the profile this repo ships
CRUCIBLE_PROFILE=demo
CRUCIBLE_ENVIRONMENT_ID=demo-<yyyy-mm>
CRUCIBLE_DEMO_RESET_NOTICE=Daily reset; test data only
CHAIN_ID=31337
REAL_VALUE_OPERATIONS=0
ALLOW_PUBLIC_GUESTS=1
ALLOW_GUEST_WRITES=0

# built into the browser bundle per profile (NEXT_PUBLIC_* is build-time, not runtime)
NEXT_PUBLIC_CHAIN=foundry
NEXT_PUBLIC_API_URL=<the edge origin, e.g. https://demo.example/api>
NEXT_PUBLIC_ANVIL_RPC=<the gated RPC path, e.g. https://demo.example/anvil>
NEXT_PUBLIC_TRIALS_ADDRESS=0x...
NEXT_PUBLIC_ALLOY_ADDRESS=0x...
```

`preview.env` and `production.env` use the same keys with their own chain ids
(11155111 / 1), their own contract addresses and their own secrets — and, in this build,
the API refuses to boot with them. That refusal is the point: a profile that starts
before its gates exist is a profile nobody can trust.

## The compose overlay

`compose.public-demo.yaml` un-publishes the origin ports (`!reset []`, compose 2.24+),
so the demo is reachable only through `deploy/edge`. An origin answering on
`:3000`/`:8787`/`:8555` is reachable by anyone who finds the IP and bypasses everything
the edge enforces.

```bash
docker compose --project-name crucible-demo \
  --env-file /etc/crucible/demo.env \
  -f compose.yaml -f compose.public-demo.yaml \
  config --quiet

docker compose --project-name crucible-demo \
  --env-file /etc/crucible/demo.env \
  -f compose.yaml -f compose.public-demo.yaml \
  up -d --build
```

Never run `down -v` against a shared host project as a cleanup shortcut.

## What still has to be true before preview/production are switched on

The runbook's Stage B/C list, unchanged: signed deployment manifest, verified Safe
owners/thresholds, external audit with findings closed, durable PostgreSQL + object
storage, automated backups with a tested restore, alerts with a named on-call, and a
mainnet preflight that exits 0 on the audited commit. Until then, `preview` and
`production` refuse to boot on purpose.
