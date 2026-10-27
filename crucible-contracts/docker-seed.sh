#!/bin/sh
# Bring a chain up to the state the site expects, and publish the addresses that
# *actually* got deployed.
#
# Two phases, and the second one is the newer:
#
#   1. The chain carries the demo loop — two operators, four settled trials, two
#      identity links. On a fresh chain the contracts are deployed and the loop
#      replayed. On a chain that already has them — the VPS, where the stack has
#      been up for days — they are kept: redeploying would move the addresses out
#      from under the API and the web bundle, and the settled hall the site is
#      built around would stop matching the transactions that produced it.
#
#   2. The chain carries something a visitor can act on — one trial open for
#      claim, one claimed and waiting for a run. The seed on its own leaves four
#      closed trials, which is a hall worth reading and nothing to do. A market
#      with no open lot is a screenshot.
#
# Demo.s.sol deploys its own AlloyRegistry and CrucibleTrials (plus the mock
# identity registry), so the addresses are whatever the script prints — never
# assumed. The file is read by the API's entrypoint; the EXPECTED_* check
# catches a .env whose baked web bundle has drifted from the script chain.
set -eu

RPC="${SEED_RPC_URL:-http://anvil:8545}"
OUT="${DEPLOYED_ENV_PATH:-/run/crucible/deployed.env}"

i=0
until cast block-number --rpc-url "$RPC" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "seed: anvil never answered at $RPC" >&2
    exit 1
  fi
  sleep 1
done

lower() {
  printf '%s' "$1" | tr 'A-Z' 'a-z'
}

has_code() {
  # A hex string that is longer than "0x" means the address holds code.
  code=$(cast code "$1" --rpc-url "$RPC" 2>/dev/null || echo "0x")
  [ "${#code}" -gt 4 ]
}

carries_the_loop() {
  # Holding code is not proof that this is the chain the demo was replayed on: a
  # stale address from a .env would also hold code if the chain were rebuilt
  # around it. A non-zero trial count is the proof — only the replayed demo
  # leaves trials behind.
  has_code "$1" || return 1
  count=$(cast call "$1" "trialCount()(uint256)" --rpc-url "$RPC" 2>/dev/null || echo 0)
  [ "$count" -gt 0 ] 2>/dev/null
}

# ── phase 1: the demo loop ───────────────────────────────────────────────
trials="${EXPECTED_TRIALS_ADDRESS:-}"
alloy="${EXPECTED_ALLOY_ADDRESS:-}"

if [ -n "$trials" ] && [ -n "$alloy" ] && carries_the_loop "$trials"; then
  echo "seed: the chain already carries $trials - keeping it"
else
  echo "seed: replaying the demo loop (compiles on first run)"
  out=$(forge script script/Demo.s.sol:Demo --rpc-url "$RPC" --broadcast 2>&1) || {
    printf '%s\n' "$out" >&2
    exit 1
  }
  printf '%s\n' "$out" | tail -n 30

  trials=$(printf '%s\n' "$out" | awk '/CrucibleTrials 0x/{print $2}' | tail -n 1)
  alloy=$(printf '%s\n' "$out" | awk '/AlloyRegistry 0x/{print $2}' | tail -n 1)
  if [ -z "$trials" ] || [ -z "$alloy" ]; then
    echo "seed: could not parse the deployed addresses" >&2
    exit 1
  fi

  # The parse found a hex string; prove it is a live contract on this chain.
  for addr in "$trials" "$alloy"; do
    if ! has_code "$addr"; then
      echo "seed: $addr holds no code on $RPC - parse is wrong" >&2
      exit 1
    fi
  done

  if [ -n "${EXPECTED_TRIALS_ADDRESS:-}" ] && \
    [ "$(lower "$EXPECTED_TRIALS_ADDRESS")" != "$(lower "$trials")" ]; then
    echo "seed: TRIALS_ADDRESS drifted - .env says $EXPECTED_TRIALS_ADDRESS, chain says $trials" >&2
    echo "seed: update .env and rebuild the web image" >&2
    exit 1
  fi
  if [ -n "${EXPECTED_ALLOY_ADDRESS:-}" ] && \
    [ "$(lower "$EXPECTED_ALLOY_ADDRESS")" != "$(lower "$alloy")" ]; then
    echo "seed: ALLOY_ADDRESS drifted - .env says $EXPECTED_ALLOY_ADDRESS, chain says $alloy" >&2
    echo "seed: update .env and rebuild the web image" >&2
    exit 1
  fi
fi

# ── phase 2: something a visitor can act on ──────────────────────────────
echo "seed: extending the chain with trials a visitor can act on"
TRIALS_ADDRESS="$trials" forge script script/Extend.s.sol:Extend --rpc-url "$RPC" --broadcast 2>&1 | tail -n 20

# ── phase 3: a team ledger with a team in it ──────────────────────────────
# The indexer, GET /teams and the page beneath them all read a TeamLedger address. Deployed by
# nobody, every one of those paths could only ever say `projected: false` — true of the host,
# useless to a visitor, and not a thing any test would catch.
echo "seed: deploying the team ledger and running one team through it"
teams_out=$(TRIALS_ADDRESS="$trials" forge script script/Teams.s.sol:Teams --rpc-url "$RPC" --broadcast 2>&1)
team_ledger=$(printf '%s\n' "$teams_out" | grep -oE 'TeamLedger 0x[0-9a-fA-F]{40}' | head -n1 | awk '{print $2}')
if [ -z "$team_ledger" ]; then
  echo "seed: Teams.s.sol deployed no TeamLedger - the /teams projection would have nothing" >&2
  printf '%s\n' "$teams_out" | tail -n 20 >&2
  exit 1
fi
# The same bytecode check the demo path makes, through the same helper: a parsed address holding
# no code means the API would index an empty account and publish an empty team list as a reading.
if ! has_code "$team_ledger"; then
  echo "seed: $team_ledger holds no bytecode on $RPC" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
printf 'TRIALS_ADDRESS=%s\nALLOY_ADDRESS=%s\nTEAM_LEDGER_ADDRESS=%s\n' "$trials" "$alloy" "$team_ledger" > "$OUT"
echo "seed: CrucibleTrials  $trials"
echo "seed: AlloyRegistry   $alloy"
echo "seed: TeamLedger      $team_ledger"
echo "seed: published $OUT"
