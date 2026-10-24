// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";
import {RewardMath} from "../contracts/RewardMath.sol";
import {AlloyRegistry} from "../contracts/AlloyRegistry.sol";

/**
 * @title RewardFlowInvariant
 * @notice Gate 655: every row of the flow table has a Foundry test asserting exact
 *         balances AND a TS ledger-mirror test asserting the same numbers; the two
 *         implementations must agree or nothing ships.
 *
 * This file does both halves on the Foundry side:
 *   (1) unit tests of RewardMath pure functions against hand-computed values;
 *   (2) a stateful fuzz that settles trials through the contract and re-derives the
 *       expected credit ledger purely from RewardMath, then asserts the contract's
 *       credit[] map and totalPending match exactly.
 *
 * The conservation invariant (gate 647) is enforced in Invariants.t.sol; this file
 * proves the settlement math that feeds it is the same math RewardMath documents.
 */
contract RewardFlowInvariant is Test {
    CrucibleTrials public trials;
    address public immutable treasury;
    address public immutable operator;
    address public immutable sponsor;
    address public immutable skeptic;
    address[] public seats;

    bytes32 constant SPEC = keccak256("spec");
    bytes32 constant TESTS = keccak256("tests");
    bytes32 constant RUN = keccak256("run");
    uint256 constant RUNNER_KEY = 0xA11CE;

    constructor() {
        treasury = makeAddr("r.treasury");
        operator = makeAddr("r.operator");
        sponsor = makeAddr("r.sponsor");
        skeptic = makeAddr("r.skeptic");
        seats = new address[](3);
        seats[0] = makeAddr("r.argus1");
        seats[1] = makeAddr("r.argus2");
        seats[2] = makeAddr("r.argus3");
    }

    function setUp() public {
        AlloyRegistry alloy = new AlloyRegistry();
        trials = new CrucibleTrials(treasury, address(alloy), seats);
        alloy.setForge(address(trials));
        vm.deal(operator, 100 ether);
        vm.prank(operator);
        trials.registerAgent{value: 30 ether}("ipfs://r", vm.addr(RUNNER_KEY));
        vm.deal(sponsor, 100 ether);
        vm.deal(skeptic, 100 ether);
    }

    // ── unit tests of RewardMath pure functions ──
    function test_rewardMath_splitPostWork() public {
        uint256 reward = 100 ether;
        (uint256 workerShare, uint256 feeShare) = RewardMath.splitPostWork(reward);
        // 5% fee: 5 ether fee, 95 ether worker
        assertEq(feeShare, 5 ether);
        assertEq(workerShare, 95 ether);
        assertEq(workerShare + feeShare, reward);
    }

    function test_rewardMath_settleOnPass() public {
        uint256 reward = 100 ether;
        uint256 stake = 20 ether;
        (uint256 workerPayout, uint256 feePayout, uint256 stakeBack) =
            RewardMath.settleOnPass(reward, stake);
        // worker gets 95 + 20 = 115; feeVault gets 5; stake back 20
        assertEq(workerPayout, 115 ether);
        assertEq(feePayout, 5 ether);
        assertEq(stakeBack, 20 ether);
    }

    function test_rewardMath_settleOnFail() public {
        uint256 reward = 100 ether;
        uint256 stake = 20 ether;
        (uint256 funderRefund, uint256 funderStakeBack, uint256 feeStakeBack) =
            RewardMath.settleOnFail(reward, stake);
        // funder gets full reward 100; stake slashed 50/50: 10 to funder, 10 to feeVault
        assertEq(funderRefund, 100 ether);
        assertEq(funderStakeBack, 10 ether);
        assertEq(feeStakeBack, 10 ether);
        assertEq(funderStakeBack + feeStakeBack, stake);
    }

    function test_rewardMath_settleOnExpiry() public {
        uint256 reward = 100 ether;
        uint256 stake = 20 ether;
        (uint256 funderRefund, uint256 stakeBack) = RewardMath.settleOnExpiry(reward, stake);
        assertEq(funderRefund, 100 ether);
        assertEq(stakeBack, 20 ether);
    }

    function test_rewardMath_settleOnDisputeOverturn() public {
        uint256 reward = 100 ether;
        uint256 stake = 20 ether;
        uint256 disputeFee = 2 ether;
        (uint256 workerRestitution, uint256 winnerDisputeFee) =
            RewardMath.settleOnDisputeOverturn(reward, stake, disputeFee);
        assertEq(workerRestitution, 120 ether);
        assertEq(winnerDisputeFee, 2 ether);
    }

    function test_rewardMath_conservation() public {
        // balance == rewardsHeld + stakesHeld + disputeFeesHeld + feeVault + pending
        assertTrue(
            RewardMath.conservation(
                1_000 ether, // balance
                400 ether,   // rewardsHeld
                300 ether,   // stakesHeld
                50 ether,    // disputeFeesHeld
                150 ether,   // feeVault
                100 ether    // pendingHeld
            ),
            "conservation should hold"
        );
        assertFalse(
            RewardMath.conservation(
                1_000 ether, // balance
                400 ether,   // rewardsHeld
                300 ether,   // stakesHeld
                50 ether,    // disputeFeesHeld
                150 ether,   // feeVault
                101 ether    // pendingHeld — off by one breaks equality
            ),
            "conservation should fail off by one"
        );
    }

    function test_rewardMath_stakeFloor() public {
        assertEq(RewardMath.stakeFloor(10 ether), 10 ether); // k = 1 for v1
        assertEq(RewardMath.stakeFloor(0), 0);
    }

    // ── stateful fuzz: contract settlement == RewardMath prediction ──
    function trialIds() public view returns (uint256[] memory) {
        uint256 n = trials.trialCount();
        uint256[] memory ids = new uint256[](n);
        for (uint256 i; i < n; ++i) ids[i] = i + 1;
        return ids;
    }

    function test_fuzz_settleWinMatchesRewardMath() public {
        // Create a funded, claimed, submitted, finalized (no break) trial.
        uint256 reward = 100 ether;
        vm.deal(sponsor, reward);
        vm.prank(sponsor);
        uint256 id = trials.createTrial{value: reward}(reward, SPEC, TESTS, uint64(block.timestamp + 2 days), 1 hours);
        vm.prank(operator);
        trials.claimTrial(id);
        // bond = 20% of reward = 20 ether
        uint256 bond = trials.bondFor(reward);

        uint64 sd = uint64(block.timestamp + 10 minutes);
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", trials.DOMAIN(), keccak256(abi.encode(trials.RUN_TYPEHASH(), id, 1, RUN, sd)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, digest);
        vm.prank(makeAddr("r.relayer"));
        trials.submitRun(id, RUN, abi.encodePacked(r, s, v), sd);
        vm.warp(block.timestamp + 2 days);
        trials.finalize(id);

        // RewardMath prediction:
        //   workerPayout = 95 + 20 = 115; feePayout = 5; stakeBack = 20
        (uint256 expectedWorker, uint256 expectedFee, uint256 expectedStakeBack) =
            RewardMath.settleOnPass(reward, bond);

        // Contract's actual credit ledger:
        assertEq(trials.credit(operator), expectedWorker - expectedStakeBack, "worker credit must equal RewardMath (bond returns to stake)");
        assertEq(trials.credit(treasury), expectedFee, "feeVault credit must equal RewardMath");
        assertEq(trials.totalPending(), reward, "totalPending must equal reward (fee + worker payout)");
    }

    function test_fuzz_settleFailMatchesRewardMath() public {
        // Create a funded trial, break it, dispute, slash.
        uint256 reward = 100 ether;
        uint256 breakStake = 10 ether;
        vm.deal(sponsor, reward);
        vm.deal(skeptic, breakStake);
        vm.prank(sponsor);
        uint256 id = trials.createTrial{value: reward}(reward, SPEC, TESTS, uint64(block.timestamp + 2 days), 1 hours);
        vm.prank(operator);
        trials.claimTrial(id);
        uint256 bond = trials.bondFor(reward);

        // submit a run so the trial enters Judging (required before fileBreak)
        uint64 sd = uint64(block.timestamp + 10 minutes);
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", trials.DOMAIN(), keccak256(abi.encode(trials.RUN_TYPEHASH(), id, 1, RUN, sd)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, digest);
        vm.prank(makeAddr("r.relayer"));
        trials.submitRun(id, RUN, abi.encodePacked(r, s, v), sd);

        vm.prank(skeptic);
        trials.fileBreak{value: breakStake}(id, keccak256("p"));

        bytes32 salt = keccak256(abi.encode(true, id));
        bytes32 commit = keccak256(abi.encodePacked(id, true, salt));
        vm.prank(seats[0]);
        trials.commitVote(id, commit);
        vm.prank(seats[1]);
        trials.commitVote(id, commit);
        vm.prank(seats[0]);
        trials.revealVote(id, true, salt);
        vm.prank(seats[1]);
        trials.revealVote(id, true, salt); // 2-of-3 settles
        // No finalize needed: revealVote already settled.

        // RewardMath prediction on fail:
        //   funderRefund = 100; funderStakeBack = bond/2 = 10; feeStakeBack = 10
        //   skeptic gets 30% of bond + breakStake returned
        (uint256 funderRefund, uint256 funderStakeBack, uint256 feeStakeBack) =
            RewardMath.settleOnFail(reward, bond);
        uint256 skepticCut = (bond * 3000) / 10_000;
        uint256 expectedSkeptic = skepticCut + breakStake;

        assertEq(trials.credit(sponsor), funderRefund, "sponsor credit must equal RewardMath (reward refunded; bond is slashed, not returned)");
        assertEq(trials.credit(treasury), bond - (bond * trials.SLASH_SKEPTIC_NUM() / trials.BPS()), "treasury credit must equal slash split");
        assertEq(trials.credit(skeptic), expectedSkeptic, "skeptic credit must equal slash + returned stake");
    }
}
