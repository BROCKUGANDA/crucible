# Runbook: indexer stalled, reset or oscillating

## Symptom

- `/api/ready` returns 503 with a `reason`, or flips between true and false.
- `/hall` is empty or losing rows.
- `/api/health` shows `syncError`, a lag, or an `indexedTo` that does not move.
- The site loads (200) but shows no trials.

## Read the fields

```bash
curl -sS https://crucible.svalley.tech/api/ready
curl -sS https://crucible.svalley.tech/api/health
```

- `head` — the chain's latest block.
- `indexedTo` — the cursor, i.e. the **next block to read**. A caught-up index
  is `head + 1`, not `head`.
- `lag` — `max(0, head - indexedTo)`; a caught-up index has lag 0.
- `syncError` — the indexer's own sentence. Treat it as the primary clue.
- `trials` — the read model's row count. Zero with a healthy chain is a data
  problem, not a quiet chain.

## Decision tree

### 1. `syncError` names a reset, and `indexedTo` returns to 0 repeatedly

A cursor beyond `head + 1` is a real reset: the chain is shorter than the
cursor, so the indexer clears the model and rebuilds. That is correct once; it
is a bug if it repeats every idle tick. A caught-up cursor (`head + 1`) must
not be treated as a reset. See
[ADR-0010](../adr/0010-index-cursor-semantics.md).

Confirm the fix is in the deployed image:

```bash
cd ~/crucible
grep -n 'cursor === head + 1n' packages/indexer/src/scribe.ts
docker inspect crucible-api-1 --format '{{.Image}}'
```

If the source has the fix but the image is old, rebuild the API (see
[deploy-and-promote.md](deploy-and-promote.md)) and recreate only the API:

```bash
docker compose -f compose.yaml -f compose.vps.yaml build api
docker compose -f compose.yaml -f compose.vps.yaml up -d --no-deps api
```

### 2. The chain really was reset (anvil restart / rebuilt devnet)

A real reset is expected to empty the read model and rebuild from the start
block. Watch it settle:

```bash
for i in $(seq 1 10); do sleep 3; curl -sS https://crucible.svalley.tech/api/ready; echo; done
```

It should reach `ready:true` with a stable `indexedTo`. If it oscillates, use
step 1.

### 3. `syncError` says a block could not be read or may hold an event

The cursor stops at the unreadable/suspicious block rather than crossing it.
Check the RPC (`RPC_URL`), the node's pruning, and the API log. Do not advance
the cursor by hand; the next tick retries.

### 4. `FROM_BLOCK` is too high, or the cursor file is from another chain

A cursor file can survive a chain rebuild. On a fresh chain, either remove the
stale cursor file (only after confirming it is not the only record of a real
deployment) or let the reset path rebuild. Do not set `FROM_BLOCK` above the
deployment block.

## Verify

```bash
for i in $(seq 1 10); do
  sleep 3
  curl -sS -o /tmp/ready.json -w '%{http_code} ' https://crucible.svalley.tech/api/ready
  cat /tmp/ready.json; echo
done
```

Expect ten consecutive `200` responses with `"ready":true`, `"lag":0`, and the
same `trials` count. A single transient is worth noting; a repeating pattern is
not fixed.

## Do not

- Do not clear the model or delete the cursor to make readiness green; that
  hides the cause.
- Do not run a full compose `up` on a live chain.
- Do not assume a 200 page means the read model is healthy; check `/ready`.
