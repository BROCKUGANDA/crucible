// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";
import {AlloyRegistry} from "../contracts/AlloyRegistry.sol";

/**
 * Every guard, called by the wrong caller, asserting the exact error.
 *
 * These branches used to be covered by accident: the invariant fuzzer was allowed to use the
 * escrow itself as a caller, so `msg.sender != operator/owner/isArgus` reverts were hit by a
 * contract no real chain can make a call from. Excluding that sender is correct — it was
 * generating an unreachable state — but it dropped CrucibleTrials branch coverage from 89.9%
 * to 80.9%, below the 88% floor. The eight missing branches were exactly these access checks.
 *
 * Testing them deliberately is what should have been happening all along: an access-control
 * guard that only a fuzzing artifact ever exercised is a guard nobody ever proved.
 */
contract CrucibleTrialsGuards is Test {
    CrucibleTrials trials;
    AlloyRegistry alloy;

    address owner = makeAddr("g.owner");
    address treasury = makeAddr("g.treasury");
    address operator = makeAddr("g.operator");
    address stranger = makeAddr("g.stranger");
    address runner = makeAddr("g.runner");
    address[] seats;

    uint256 constant RUNNER_KEY = 0xA11CE;
    bytes32 constant SPEC = keccak256("guards.spec");
    bytes32 constant TESTS = keccak256("guards.tests");
    bytes32 constant RUN = keccak256("guards.run");

    function setUp() public {
        seats = new address[](3);
        seats[0] = makeAddr("g.argus1");
        seats[1] = makeAddr("g.argus2");
        seats[2] = makeAddr("g.argus3");
        alloy = new AlloyRegistry();
        trials = new CrucibleTrials(owner, address(alloy), seats);
        alloy.setForge(address(trials));

        vm.deal(operator, 10 ether);
        vm.prank(operator);
        trials.registerAgent{value: 5 ether}("ipfs://guards", vm.addr(RUNNER_KEY));
    }

    // ── owner-only setters ────────────────────────────────────────────────
    function test_setReputationBridge_rejectsNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(CrucibleTrials.NotOwner.selector);
        trials.setReputationBridge(makeAddr("g.bridge"));
    }

    function test_setIdentityRegistry_rejectsNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(CrucibleTrials.NotOwner.selector);
        trials.setIdentityRegistry(makeAddr("g.identity"));
    }

    function test_setVerificationReceipt_rejectsNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(CrucibleTrials.NotOwner.selector);
        trials.setVerificationReceipt(makeAddr("g.receipt"));
    }

    function test_setReceiptsEnabled_rejectsNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(CrucibleTrials.NotOwner.selector);
        trials.setReceiptsEnabled(true);
    }

    // ── identity link ─────────────────────────────────────────────────────
    function test_linkIdentity_rejectsNonOperator() public {
        vm.prank(stranger);
        vm.expectRevert(CrucibleTrials.NotOperator.selector);
        trials.linkIdentity(1, 7);
    }

    function test_linkIdentity_rejectsZeroIdentity() public {
        vm.prank(operator);
        vm.expectRevert(CrucibleTrials.ZeroIdentity.selector);
        trials.linkIdentity(1, 0);
    }

    // ── runner key ────────────────────────────────────────────────────────
    function test_setRunner_rejectsNonOperator() public {
        vm.prank(stranger);
        vm.expectRevert(CrucibleTrials.NotOperator.selector);
        trials.setRunner(1, makeAddr("g.other-runner"));
    }

    function test_setRunner_rejectsZeroRunner() public {
        vm.prank(operator);
        vm.expectRevert(CrucibleTrials.ZeroRunner.selector);
        trials.setRunner(1, address(0));
    }

    // ── registration ──────────────────────────────────────────────────────
    function test_registerAgent_rejectsZeroRunner() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(CrucibleTrials.ZeroRunner.selector);
        trials.registerAgent{value: 1 ether}("ipfs://x", address(0));
    }

    function test_registerAgent_rejectsValueBelowFloor() public {
        vm.deal(stranger, 1 ether);
        // Hoisted: a contract read inside the expectRevert argument would consume the
        // expectation itself, and the test would pass on the wrong call.
        uint256 belowFloor = trials.MIN_BOND() - 1;
        vm.prank(stranger);
        vm.expectRevert(CrucibleTrials.StakeTooSmall.selector);
        trials.registerAgent{value: belowFloor}("ipfs://x", makeAddr("g.r2"));
    }

    function test_registerAgent_rejectsValueAboveUint128() public {
        // The stake is stored in uint128; a larger value must be refused rather than truncated.
        uint256 tooLarge = uint256(type(uint128).max) + 1;
        vm.deal(stranger, tooLarge);
        vm.prank(stranger);
        vm.expectRevert(CrucibleTrials.StakeTooSmall.selector);
        trials.registerAgent{value: tooLarge}("ipfs://x", makeAddr("g.r3"));
    }

    // ── posting ───────────────────────────────────────────────────────────
    function test_createTrial_rejectsZeroSpec() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(CrucibleTrials.ZeroSpec.selector);
        trials.createTrial{value: 1 ether}(1 ether, bytes32(0), TESTS, uint64(block.timestamp + 2 hours), 1 hours);
    }

    function test_createTrial_rejectsZeroTests() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(CrucibleTrials.ZeroTests.selector);
        trials.createTrial{value: 1 ether}(1 ether, SPEC, bytes32(0), uint64(block.timestamp + 2 hours), 1 hours);
    }

    function test_createTrial_rejectsValueNotEqualToReward() public {
        vm.deal(stranger, 2 ether);
        vm.prank(stranger);
        vm.expectRevert(CrucibleTrials.RewardMismatch.selector);
        trials.createTrial{value: 1 ether}(2 ether, SPEC, TESTS, uint64(block.timestamp + 2 hours), 1 hours);
    }

    function test_createTrial_rejectsRewardAboveCeiling() public {
        uint256 reward = trials.MAX_REWARD() + 1;
        vm.deal(stranger, reward);
        vm.prank(stranger);
        vm.expectRevert(CrucibleTrials.RewardTooLarge.selector);
        trials.createTrial{value: reward}(reward, SPEC, TESTS, uint64(block.timestamp + 2 hours), 1 hours);
    }

    function test_createTrial_rejectsDeadlineInsideTheRunWindow() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(CrucibleTrials.BadDeadline.selector);
        trials.createTrial{value: 1 ether}(1 ether, SPEC, TESTS, uint64(block.timestamp + 30 minutes), 1 hours);
    }

    function test_createTrial_rejectsWindowOutsideBounds() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(CrucibleTrials.BadWindow.selector);
        trials.createTrial{value: 1 ether}(1 ether, SPEC, TESTS, uint64(block.timestamp + 2 hours), 30 minutes);
    }

    // ── Argus committee ───────────────────────────────────────────────────
    function test_commitVote_rejectsNonArgus() public {
        uint256 id = _judgingWithBreak();
        vm.prank(stranger);
        vm.expectRevert(CrucibleTrials.NotArgus.selector);
        trials.commitVote(id, keccak256("commit"));
    }

    function test_revealVote_rejectsNonArgus() public {
        uint256 id = _judgingWithBreak();
        vm.prank(stranger);
        vm.expectRevert(CrucibleTrials.NotArgus.selector);
        trials.revealVote(id, true, keccak256("salt"));
    }

    // ── settlement idempotency ────────────────────────────────────────────
    function test_finalize_rejectsAnAlreadySettledTrial() public {
        uint256 id = _judgingTrial();
        vm.warp(block.timestamp + 3 hours); // past the submission deadline
        trials.finalize(id); // permissionless, and pays
        // The outer guard fires first; `_settle`'s own AlreadySettled check is the defence
        // for its other callers and is not reachable through this door. Asserting the error
        // the caller actually gets is worth more than forcing the internal one.
        vm.expectRevert(CrucibleTrials.NotFinalizable.selector);
        trials.finalize(id);
    }

    // ── signature shape ───────────────────────────────────────────────────
    function test_submitRun_rejectsAShortSignature() public {
        uint256 id = _assignedTrial();
        vm.prank(makeAddr("g.relayer"));
        vm.expectRevert(CrucibleTrials.BadSig.selector);
        trials.submitRun(id, RUN, new bytes(64), uint64(block.timestamp + 10 minutes));
    }

    function test_submitRun_rejectsAnOutOfRangeV() public {
        uint256 id = _assignedTrial();
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                trials.DOMAIN(),
                keccak256(abi.encode(trials.RUN_TYPEHASH(), id, 1, RUN, uint64(block.timestamp + 10 minutes)))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, digest);
        bytes memory sig = abi.encodePacked(r, s, uint8(v + 2)); // v = 29
        vm.prank(makeAddr("g.relayer"));
        vm.expectRevert(CrucibleTrials.BadSig.selector);
        trials.submitRun(id, RUN, sig, uint64(block.timestamp + 10 minutes));
    }

    // ── fixtures ──────────────────────────────────────────────────────────
    function _assignedTrial() internal returns (uint256 id) {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        id = trials.createTrial{value: 1 ether}(1 ether, SPEC, TESTS, uint64(block.timestamp + 2 days), 1 hours);
        vm.prank(operator);
        trials.claimTrial(id);
    }

    function _judgingTrial() internal returns (uint256 id) {
        id = _assignedTrial();
        uint64 sd = uint64(block.timestamp + 10 minutes);
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", trials.DOMAIN(), keccak256(abi.encode(trials.RUN_TYPEHASH(), id, 1, RUN, sd)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, digest);
        vm.prank(makeAddr("g.relayer"));
        trials.submitRun(id, RUN, abi.encodePacked(r, s, v), sd);
    }

    function _judgingWithBreak() internal returns (uint256 id) {
        id = _judgingTrial();
        address skeptic = makeAddr("g.skeptic");
        vm.deal(skeptic, 1 ether);
        vm.prank(skeptic);
        trials.fileBreak{value: 0.01 ether}(id, keccak256("g.proof"));
    }
}
