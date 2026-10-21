#!/bin/sh
# Post-deploy assertions.
#
# A deploy that succeeds is not the same as a deploy that is correct. This
# script is the difference: it reads the chain that is actually live and fails
# when what it finds is not what the deployment claims.
#
# It runs after every deploy, and by hand. It is read-only — it calls the
# contracts and the public API, and it moves nothing.
#
#   RPC_URL=http://anvil:8545 \
#   TRIALS_ADDRESS=0x… ALLOY_ADDRESS=0x… \
#   PUBLIC_URL=https://crucible.svalley.tech \
#   sh scripts/assert-deployment.sh
#
# The exit code is what matters: 0 is a deployment that can be trusted, and
# anything else is a deployment that must not be treated as live.
set -eu

RPC="${RPC_URL:-http://anvil:8545}"
TRIALS="${TRIALS_ADDRESS:-}"
ALLOY="${ALLOY_ADDRESS:-}"
PUBLIC_URL="${PUBLIC_URL:-https://crucible.svalley.tech}"

fail=0
checks=0

ok() {
  checks=$((checks + 1))
  printf '  ok    %s\n' "$1"
}

bad() {
  checks=$((checks + 1))
  fail=$((fail + 1))
  printf '  FAIL  %s\n' "$1"
}

# expect <label> <expected> <actual>
expect() {
  if [ "$2" = "$3" ]; then
    ok "$1 = $3"
  else
    bad "$1: expected $2, got $3"
  fi
}

# `cast` prints a big number in two forms: the plain digits, and an exponent
# gloss in brackets. The digits are exact; the gloss is not, and the shell
# cannot do arithmetic on it. The plain form is what a comparison needs.
number() {
  sed -E 's/ \[[^]]*\]$//' | tr -d '[:space:]'
}

# An address is the same address whatever its case. `cast` returns the
# checksummed form; the configuration holds a lower-case one.
address() {
  tr 'A-Z' 'a-z' | tr -d '[:space:]'
}

call() {
  # call <address> <signature>
  cast call "$1" "$2" --rpc-url "$RPC" 2>/dev/null | head -n 1
}

call_number() {
  call "$1" "$2" | number
}

call_address() {
  call "$1" "$2" | address
}

echo "asserting the deployment at $RPC"

if [ -z "$TRIALS" ] || [ -z "$ALLOY" ]; then
  echo "TRIALS_ADDRESS and ALLOY_ADDRESS are required" >&2
  exit 2
fi

# ── the contracts are there ────────────────────────────────────────────────
for pair in "CrucibleTrials:$TRIALS" "AlloyRegistry:$ALLOY"; do
  name="${pair%%:*}"
  addr="${pair#*:}"
  code=$(cast code "$addr" --rpc-url "$RPC" 2>/dev/null || echo "0x")
  if [ "${#code}" -gt 2 ]; then
    ok "$name holds code at $addr"
  else
    bad "$name holds no code at $addr"
  fi
done

if [ "$fail" != "0" ]; then
  echo "the contracts are not where the deployment says they are; stopping here" >&2
  exit 1
fi

# ── the economics are the ones the README documents ───────────────────────
expect "settlement fee (bps)" "500" "$(call_number "$TRIALS" 'FEE_BPS()(uint256)')"
expect "bond denominator" "5" "$(call_number "$TRIALS" 'BOND_DEN()(uint256)')"
expect "minimum bond (wei)" "10000000000000000" "$(call_number "$TRIALS" 'MIN_BOND()(uint256)')"
expect "Argus threshold" "2" "$(call_number "$TRIALS" 'ARGUS_THRESHOLD()(uint256)')"

# ── the roles are wired, not merely present ───────────────────────────────
owner=$(call_address "$TRIALS" 'owner()(address)')
treasury=$(call_address "$TRIALS" 'treasury()(address)')
zero="0x0000000000000000000000000000000000000000"
if [ "$owner" != "$zero" ] && [ -n "$owner" ]; then ok "the owner is set ($owner)"; else bad "the owner is zero"; fi
if [ "$treasury" != "$zero" ] && [ -n "$treasury" ]; then ok "the treasury is set ($treasury)"; else bad "the treasury is zero"; fi

# The escrow must point at the registry it settles into, and the registry must
# accept writes from the escrow and from nobody else. A registry that accepts
# a second writer is a reputation system anybody can inflate.
expect "the escrow's alloy registry" "$(printf '%s' "$ALLOY" | address)" "$(call_address "$TRIALS" 'alloy()(address)')"
expect "the registry's forge" "$(printf '%s' "$TRIALS" | address)" "$(call_address "$ALLOY" 'forge()(address)')"

# ── the money invariant, on the live chain ────────────────────────────────
# The contract's own invariant: the ETH the contract holds covers everything
# it owes. A test proves the code cannot break it; this proves the DEPLOYED
# contract has not.
escrowed=$(call_number "$TRIALS" 'escrowed()(uint256)')
pending=$(call_number "$TRIALS" 'totalPending()(uint256)')
balance=$(cast balance "$TRIALS" --rpc-url "$RPC" 2>/dev/null | number || echo 0)
owed=$((escrowed + pending))
if [ "$owed" -le "$balance" ]; then
  ok "the contract holds $balance wei against $owed wei of liabilities"
else
  bad "the contract holds $balance wei but owes $owed wei"
fi

# ── the public surface is answering ───────────────────────────────────────
# The chain can be perfectly correct while the site points somewhere else:
# the web bundle bakes its contract address at build time, and the API reads
# its own. If those two ever disagree, a judge connects a wallet and talks to
# a contract that is not the one the site is showing.
for probe in "$PUBLIC_URL/" "$PUBLIC_URL/api/ready" "$PUBLIC_URL/api/health"; do
  code=$(wget -q -O /dev/null --server-response --timeout=10 "$probe" 2>&1 | awk '/^  HTTP\//{code=$2} END{print code+0}')
  if [ "${code:-0}" = "200" ]; then
    ok "$probe answers 200"
  else
    bad "$probe answered ${code:-0}"
  fi
done

# The API's own idea of the contract must be the one we just asserted.
reported=$(wget -q -O - --timeout=10 "$PUBLIC_URL/api/hall" 2>/dev/null | sed -n 's/.*"trialsAddress":"\([^"]*\)".*/\1/p')
if [ -n "$reported" ]; then
  expect "the API's trials address" "$TRIALS" "$reported"
else
  bad "the API did not report a trials address"
fi

# ── the indexer is not stuck ──────────────────────────────────────────────
health=$(wget -q -O - --timeout=10 "$PUBLIC_URL/api/health" 2>/dev/null || echo "{}")
sync_error=$(printf '%s' "$health" | sed -n 's/.*"syncError":\([^,}]*\).*/\1/p')
if [ "$sync_error" = "null" ] || [ -z "$sync_error" ]; then
  ok "the indexer reports no sync error"
else
  bad "the indexer reports a sync error: $sync_error"
fi

echo ""
if [ "$fail" = "0" ]; then
  echo "all $checks assertions passed — the deployment can be trusted"
  exit 0
fi
echo "$fail of $checks assertions FAILED — do not treat this deployment as live" >&2
exit 1
