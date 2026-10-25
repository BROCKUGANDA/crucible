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
#
# Wei does not fit the shell's arithmetic. `$(( ))` and `[ -le ]` are 64-bit
# signed, so a contract holding 10.04 ETH made the comparison error out and a
# healthy surplus print as a FAIL, and a liability sum past 2^63 wraps negative
# — which would have reported "owes -8 ETH" as a pass. The dangerous direction is
# the silent one, so the sums below are decimal on digit strings, and the helpers
# are checked against the numbers from that incident before anything relies on
# them.
LC_ALL=C
export LC_ALL

dec_norm() {
  d=$1
  while [ "${d#0}" != "$d" ] && [ -n "$d" ]; do d=${d#0}; done
  printf '%s' "${d:-0}"
}

# dec_add <decimal> <decimal> — schoolbook addition, right to left. `${x%?}` and
# `${x#"$y"}` are POSIX; the substring form `${x:1:1}` is not, and this runs
# under dash inside the seed container.
dec_add() {
  a=$(dec_norm "$1")
  b=$(dec_norm "$2")
  carry=0
  out=""
  while [ -n "$a" ] || [ -n "$b" ] || [ "$carry" -ne 0 ]; do
    da=${a#"${a%?}"}
    a=${a%?}
    db=${b#"${b%?}"}
    b=${b%?}
    [ -n "$da" ] || da=0
    [ -n "$db" ] || db=0
    sum=$((da + db + carry))
    if [ "$sum" -ge 10 ]; then
      carry=1
      sum=$((sum - 10))
    else
      carry=0
    fi
    out="${sum}${out}"
  done
  printf '%s' "$(dec_norm "$out")"
}

# dec_cmp <a> <b> — -1, 0 or 1. Equal-length digit strings compare as bytes under C.
dec_cmp() {
  a=$(dec_norm "$1")
  b=$(dec_norm "$2")
  if [ "${#a}" -gt "${#b}" ]; then printf '%s' 1; return; fi
  if [ "${#a}" -lt "${#b}" ]; then printf '%s' -1; return; fi
  if [ "$a" = "$b" ]; then printf '%s' 0; return; fi
  if [ "$a" \> "$b" ]; then printf '%s' 1; else printf '%s' -1; fi
}

# The canary: 10.04 ETH held against 8.44 ETH owed is the case the shell got
# wrong, and 8.44 + 2.00 is the sum that used to wrap negative.
if [ "$(dec_cmp 10040000000000000000 8440000000000000000)" != 1 ] ||
  [ "$(dec_add 8440000000000000000 2000000000000000000)" != "10440000000000000000" ] ||
  [ "$(dec_cmp "$(dec_add 9223372036854775807 1)" 9223372036854775808)" != 0 ]; then
  bad "the decimal helpers disagree with known values — the money check below is not trustworthy"
else
  ok "the decimal helpers agree with the values that broke 64-bit arithmetic"
fi

escrowed=$(call_number "$TRIALS" 'escrowed()(uint256)')
pending=$(call_number "$TRIALS" 'totalPending()(uint256)')
stakes=$(call_number "$TRIALS" 'totalStakes()(uint256)')
balance=$(cast balance "$TRIALS" --rpc-url "$RPC" 2>/dev/null | number || echo 0)
# The same equality `test/Invariants.t.sol:170` asserts on every fuzzed transition:
# balance == totalStakes + totalPending + escrowed. The previous check here was one-directional
# and left out stakes, so ETH that had already left the escrow without a book entry — the actual
# money-loss case — passed it. The escrow has no `receive()`, so there is no legitimate way for
# the two sides to differ: over or under, a mismatch is an incident, and it is named as one.
books=$(dec_add "$stakes" "$(dec_add "$pending" "$escrowed")")
case "$(dec_cmp "$books" "$balance")" in
  0)
    ok "the escrow's ETH equals its books exactly: $balance wei = stakes $stakes + credits $pending + escrow $escrowed"
    ;;
  1)
    bad "the escrow owes $books wei but holds only $balance — ETH has left a contract that cannot pay out except through withdraw()"
    ;;
  *)
    bad "the escrow holds $balance wei against $books wei of liabilities — unaccounted ETH is on a contract with no receive()"
    ;;
esac

# The public surface is NOT probed from here.
#
# This script runs inside the seed container, on the compose network, where it
# can reach anvil and the contracts. The public URLs are the other side of
# the proxy, and asking about them from inside the network was answering 0:
# the container does not resolve or reach the public name the way a visitor
# does, so the probe measured the container's network rather than the site's.
#
# The public probes run on the HOST, in the deploy job, where they measure
# what a visitor measures.

echo ""
if [ "$fail" = "0" ]; then
  echo "all $checks chain assertions passed — the deployment can be trusted"
  exit 0
fi
echo "$fail of $checks chain assertions FAILED — do not treat this deployment as live" >&2
exit 1
