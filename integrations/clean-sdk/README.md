# `@crucible/clean-bridge`

The isolated home of `@human.tech/clean.sdk`. One read is exposed to Crucible: the
unauthenticated L1 eligibility check (`GET /api/attestation/l1-eligibility`), which runs the
vendor's POCH -> Passport cascade plus a sanctions screen keyed only on an Ethereum address.
The API reads it over loopback as a Passport credential source.

**It is not a workspace and nothing in the escrow imports it.** The SDK carries an Ethereum
<-> Aztec bridge and a native level store. Crucible's settlement is native ETH on Anvil with a
5 percent fee (ADR-0001); token bridging, USDC and ERC-20s are a product pivot, not a package
install. The bridge methods are never called here, and no key is held by this process.

## Install

```bash
npm install --ignore-scripts --no-audit --no-fund
```

`--ignore-scripts` is required on Windows/Node 26: `leveldown@6.1.1`'s install script fails
with `0xC0000142` (DLL init) and npm rolls the whole tree back. The eligibility route never
loads that binding — the tests below prove the SDK path works without it. On Linux CI the
same command is used for determinism, not necessity.

## Run

```bash
CLEAN_API_URL=https://shield.human.tech \
L1_RPC_URL=http://127.0.0.1:8545 \
node src/server.mjs
```

Then point the API at it:

```bash
CLEAN_PASSPORT_URL=http://127.0.0.1:8789
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLEAN_PASSPORT_PORT` | `8789` | Loopback port |
| `CLEAN_PASSPORT_HOST` | `127.0.0.1` | Bind address; do not expose publicly |
| `CLEAN_API_URL` | `https://shield.human.tech` | Vendor API base |
| `L1_RPC_URL` | `http://127.0.0.1:1` | Constructor requirement; eligibility never dials it |
| `CLEAN_DOMAIN` | `localhost` | Constructor requirement in Node |

## Test

```bash
npm test
```

The tests stand up a local upstream and drive the real SDK through it. No vendor key, no live
network, and the unreachable `l1RpcUrl` is deliberate: if eligibility ever started dialling an
L1 node, the tests would hang rather than pass.

## What this is not

- Not a settlement dependency: the API has no build-time or runtime import of the SDK.
- Not a bridge: `bridgeL1ToL2`, `withdrawL2ToL1` and the fuel swap are unused.
- Not an attestation of humanity by itself: an eligible score is one signal, a sanctions match
  is one negative, and "not eligible" contributes nothing (see `apps/api/src/identity.ts`).
