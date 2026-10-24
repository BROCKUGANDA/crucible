#!/usr/bin/env bash
# apply a mutation, run one test, restore. Prints the verdict for the audit record.
run() { # label  file  from  to  test
  local label="$1" file="$2" from="$3" to="$4" test="$5"
  python3 - "$file" "$from" "$to" <<'PY'
import sys
p,a,b=sys.argv[1],sys.argv[2],sys.argv[3]
s=open(p,encoding='utf-8').read()
assert a in s, "anchor missing for "+p
open(p,'w',encoding='utf-8',newline='').write(s.replace(a,b,1))
PY
  out=$( cd crucible-contracts && node ../scripts/run-forge.mjs test --match-test "$test" 2>&1 | grep -E "Suite result" | tail -1 )
  python3 - "$file" "$to" "$from" <<'PY'
import sys
p,a,b=sys.argv[1],sys.argv[2],sys.argv[3]
s=open(p,encoding='utf-8').read()
assert a in s
open(p,'w',encoding='utf-8',newline='').write(s.replace(a,b,1))
PY
  echo "$label -> $out"
}
A=crucible-contracts/contracts/Arena.sol
run "M1 docket ranks by LOWEST stake" "$A" "if (cand.stake > cur.stake || (cand.stake == cur.stake && cand.committedAt < cur.committedAt)) best = i;" "if (cand.stake < cur.stake) best = i;" "test_742_Docket_KeepsTheHighestStakesAndRefundsTheRest"
run "M2 every landed break gets the prize" "$A" "                if (!prizeGiven) {" "                if (true) {" "test_743_O3_ABreakLanded_SponsorWholeSkepticPrizedBondSplits"
run "M3 ghost ledger skips the bond side" "$A" "        t.paidOut += bond;
        _credit(treasury, treasuryShare);" "        _credit(treasury, treasuryShare);" "test_744_Ledger_EveryStepKeepsDepositedEqualToPaidPlusHeld"
run "M4 any address may post a ballot" "$A" "        if (!_isPanelSeat(p, msg.sender)) revert NotSeat();
        if (_voteCommit[id][t.round][msg.sender] != bytes32(0)) revert AlreadyCommitted();" "        if (_voteCommit[id][t.round][msg.sender] != bytes32(0)) revert AlreadyCommitted();" "test_Vote_AStrangerMayNotFillTheBallotSlot"
run "M5 cancel ignores that a claim was ever held" "$A" "        if (t.everClaimed) revert BadState();" "        if (t.status != Status.Open) revert BadState();" "test_734_Cancel_RevertsOnceSomeoneHasHeldTheClaim"
