// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";

/**
 * Extends a chain that already carries the demo loop with trials a visitor can act on.
 *
 * The seed leaves four settled trials: a hall worth reading, and nothing to do. Every
 * trial on it is closed, so a visitor who arrives has nothing to claim, nothing to
 * break and nothing to wait for. The product is a market, and a market with no open
 * lot is a screenshot.
 *
 * This script adds two:
 *
 *   1. an **open** trial — sponsored, unclaimed. A wallet with an agent can claim it,
 *      submit a run, and watch it settle against the same machinery the seeded history
 *      went through. This is the "light a trial, take the work" path a visitor can
 *      actually walk.
 *   2. a trial **at the anvil** — claimed, awaiting a run. It shows the in-flight state
 *      and the countdown that goes with it, which the settled history cannot show.
 *
 * It extends the chain in place. Nothing is redeployed, so the addresses the API and
 * the web bundle already carry stay valid, and the settled hall is preserved: the
 * proof rows the site is built around keep pointing at the transactions that made them.
 *
 *   TRIALS_ADDRESS=0x... forge script script/Extend.s.sol:Extend --rpc-url $RPC --broadcast
 */
contract Extend is Script {
    /// Anvil's published development mnemonic. Not a secret: every account it derives is
    /// publicly known, which is exactly why the funds in them are worthless.
    string constant DEV_MNEMONIC = "test test test test test test test test test test test junk";

    /// The operator the demo registered first. It already holds a registered agent, so
    /// claiming a trial is all it needs — registering again would revert.
    uint32 constant PK_OPERATOR_A = 4;

    /// The sponsor that funds the extra trials.
    uint32 constant PK_SPONSOR = 6;

    /// The reward each extra trial carries, in wei. The same figure the seed uses.
    uint256 constant REWARD = 1 ether;

    /// How long the work may take, and how long the sceptic window stays open after a run.
    uint64 constant RUN_WINDOW = 30 days;
    uint64 constant BREAK_WINDOW = 12 hours;

    CrucibleTrials internal trials;

    function run() external {
        address trialsAddress = vm.envAddress("TRIALS_ADDRESS");
        trials = CrucibleTrials(trialsAddress);

        uint256 pkOperatorA = vm.deriveKey(DEV_MNEMONIC, PK_OPERATOR_A);
        uint256 pkSponsor = vm.deriveKey(DEV_MNEMONIC, PK_SPONSOR);

        require(trials.agentIdOf(vm.addr(pkOperatorA)) != 0, "operator A is not registered on this chain");
        require(vm.addr(pkSponsor).balance > 4 ether, "sponsor is not funded on this node");

        // The guard is the point of this script: it extends a chain that is already
        // seeded, and running it twice would leave a trail of half-finished trials
        // that nobody asked for. An open trial is the fingerprint of a chain that has
        // already been extended, so its presence is the signal to stop.
        if (_alreadyExtended()) {
            console.log("chain already carries an open trial - it has been extended, nothing to do");
            return;
        }

        uint256 before = trials.trialCount();

        console.log("extending chain", trialsAddress);
        console.log("trials before:", before);

        // 1. Open for claim: sponsored, nobody has taken it.
        vm.broadcast(pkSponsor);
        uint256 openId = trials.createTrial{value: REWARD}(
            keccak256("spec-open"), keccak256("tests-open"), uint64(block.timestamp + RUN_WINDOW), BREAK_WINDOW
        );
        console.log("  open trial   #", openId, "- sponsored, awaiting a claim");

        // 2. At the anvil: sponsored and claimed, waiting for a run.
        vm.broadcast(pkSponsor);
        uint256 claimedId = trials.createTrial{value: REWARD}(
            keccak256("spec-anvil"), keccak256("tests-anvil"), uint64(block.timestamp + RUN_WINDOW), BREAK_WINDOW
        );
        vm.broadcast(pkOperatorA);
        trials.claimTrial(claimedId);
        console.log("  anvil trial  #", claimedId, "- claimed, awaiting a run");

        console.log("trials after:", trials.trialCount());
        console.log("");
        console.log("a visitor can now claim trial", openId, "and settle it themselves.");
    }

    /// True when the chain already holds an open trial, which is this script's
    /// fingerprint. It makes the script idempotent: re-running it is a no-op rather
    /// than a second pair of trials nobody asked for.
    function _alreadyExtended() internal view returns (bool) {
        uint256 count = trials.trialCount();
        for (uint256 id = 1; id <= count; ++id) {
            (, , , , , , , , , , , CrucibleTrials.Status status, ) = trials.trials(id);
            if (status == CrucibleTrials.Status.Open) return true;
        }
        return false;
    }
}
