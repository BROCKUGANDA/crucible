// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";

/**
 * Extends a chain that already carries the demo loop with trials a visitor can act on.
 *
 * The seed leaves four settled trials: a hall worth reading, and nothing to do. Every
 * trial on it is closed, so a visitor who arrives has no trial to claim, nothing to
 * break and nothing to wait for. The product is a market, and a market with no open
 * lot is a screenshot.
 *
 * This script tops the chain back up. It keeps a minimum number of trials open for a
 * claim, and keeps one claimed and waiting for a run, so the demo always has both
 * shapes on it — including after a visitor claims the open one, which is the case the
 * original "extend once and stop" version got wrong: the demo ran down to nothing and
 * nothing put it back.
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

    /// How many trials are kept open for a claim.
    ///
    /// Three is enough for a visitor to see a market with more than one lot in it, and
    /// enough that a judge who claims one still finds two. One is not: a single open
    /// trial that a judge claims is a demo with nothing left to look at.
    uint256 constant MIN_OPEN_TRIALS = 3;

    CrucibleTrials internal trials;

    function run() external {
        address trialsAddress = vm.envAddress("TRIALS_ADDRESS");
        trials = CrucibleTrials(trialsAddress);

        uint256 pkOperatorA = vm.deriveKey(DEV_MNEMONIC, PK_OPERATOR_A);
        uint256 pkSponsor = vm.deriveKey(DEV_MNEMONIC, PK_SPONSOR);

        require(trials.agentIdOf(vm.addr(pkOperatorA)) != 0, "operator A is not registered on this chain");
        require(vm.addr(pkSponsor).balance > 4 ether, "sponsor is not funded on this node");

        uint256 open = _count(CrucibleTrials.Status.Open);
        uint256 assigned = _count(CrucibleTrials.Status.Assigned);
        console.log("open trials:", open, "assigned:", assigned);

        // 1. Keep enough trials open for a visitor to claim.
        if (open >= MIN_OPEN_TRIALS) {
            console.log("enough open trials already; leaving them alone");
        } else {
            uint256 wanted = MIN_OPEN_TRIALS - open;
            for (uint256 i = 0; i < wanted; i++) {
                vm.broadcast(pkSponsor);
                uint256 id = trials.createTrial{value: REWARD}(
                    keccak256(abi.encodePacked("spec-open", i, block.timestamp)),
                    keccak256(abi.encodePacked("tests-open", i, block.timestamp)),
                    uint64(block.timestamp + RUN_WINDOW),
                    BREAK_WINDOW
                );
                console.log("  open trial   #", id, "- sponsored, awaiting a claim");
            }
        }

        // 2. Keep one trial at the anvil: claimed, waiting for a run. It shows the
        //    in-flight state and the countdown that goes with it, which a chain of
        //    settled trials cannot show.
        if (assigned == 0) {
            uint256 freeStake = _freeStake(pkOperatorA);
            uint256 bond = trials.bondFor(REWARD);
            if (freeStake >= bond) {
                vm.broadcast(pkSponsor);
                uint256 id = trials.createTrial{value: REWARD}(
                    keccak256(abi.encodePacked("spec-anvil", block.timestamp)),
                    keccak256(abi.encodePacked("tests-anvil", block.timestamp)),
                    uint64(block.timestamp + RUN_WINDOW),
                    BREAK_WINDOW
                );
                vm.broadcast(pkOperatorA);
                trials.claimTrial(id);
                console.log("  anvil trial  #", id, "- claimed, awaiting a run");
            } else {
                console.log("  operator A has no free stake left for a bond; no anvil trial");
            }
        } else {
            console.log("a trial is already at the anvil; leaving it alone");
        }

        console.log("");
        console.log("open trials now:", _count(CrucibleTrials.Status.Open));
    }

    /// How many trials are in a given status.
    function _count(CrucibleTrials.Status status) internal view returns (uint256 n) {
        uint256 count = trials.trialCount();
        for (uint256 id = 1; id <= count; ++id) {
            (, , , , , , , , , , , CrucibleTrials.Status s, ) = trials.trials(id);
            if (s == status) n += 1;
        }
    }

    /// The agent's free stake — the part a bond can come out of.
    function _freeStake(uint256 operatorPk) internal view returns (uint256) {
        uint256 agentId = trials.agentIdOf(vm.addr(operatorPk));
        if (agentId == 0) return 0;
        (address operator, address runner, , uint128 stake, ) = trials.agents(agentId);
        operator;
        runner;
        return stake;
    }
}
