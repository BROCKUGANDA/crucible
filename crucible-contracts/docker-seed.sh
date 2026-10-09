#!/bin/sh
# Deploy the demo loop against a running anvil and publish the addresses that
# *actually* got deployed. Demo.s.sol deploys its own AlloyRegistry and
# CrucibleTrials (plus the mock identity registry), so the addresses are whatever
# the script prints — never assumed. The file is read by the API's entrypoint; the
# EXPECTED_* check catches a .env whose baked web bundle has drifted from the
# script chain.
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
  code=$(cast code "$addr" --rpc-url "$RPC" 2>/dev/null || echo "0x")
  if [ "${#code}" -le 4 ]; then
    echo "seed: $addr holds no code on $RPC — parse is wrong" >&2
    exit 1
  fi
done

lower() {
  printf '%s' "$1" | tr 'A-Z' 'a-z'
}

if [ -n "${EXPECTED_TRIALS_ADDRESS:-}" ] && \
  [ "$(lower "$EXPECTED_TRIALS_ADDRESS")" != "$(lower "$trials")" ]; then
  echo "seed: TRIALS_ADDRESS drifted — .env says $EXPECTED_TRIALS_ADDRESS, chain says $trials" >&2
  echo "seed: update .env and rebuild the web image" >&2
  exit 1
fi
if [ -n "${EXPECTED_ALLOY_ADDRESS:-}" ] && \
  [ "$(lower "$EXPECTED_ALLOY_ADDRESS")" != "$(lower "$alloy")" ]; then
  echo "seed: ALLOY_ADDRESS drifted — .env says $EXPECTED_ALLOY_ADDRESS, chain says $alloy" >&2
  echo "seed: update .env and rebuild the web image" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
printf 'TRIALS_ADDRESS=%s\nALLOY_ADDRESS=%s\n' "$trials" "$alloy" > "$OUT"
echo "seed: CrucibleTrials  $trials"
echo "seed: AlloyRegistry   $alloy"
echo "seed: published $OUT"
