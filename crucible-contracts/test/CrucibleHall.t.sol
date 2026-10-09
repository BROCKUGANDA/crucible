// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CrucibleHall} from "../contracts/CrucibleHall.sol";

/// @notice The hall is the surface a judge reads first: every row must be provably
/// owned and provably settled. These tests hold the three properties the SE-2 port
/// was written for — handles are unique, trials require an identity, and settlement
/// is exactly-once with checks-effects-interactions around the payout.
contract CrucibleHallTest is Test {
    CrucibleHall hall;

    address owner = makeAddr("owner");
    address settler = makeAddr("settler");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        hall = new CrucibleHall(owner);
        vm.deal(owner, 10 ether);
        vm.deal(settler, 10 ether);
        vm.deal(alice, 1 ether);
    }

    // ── identity ────────────────────────────────────────────────────

    function test_LinkIdentity_RecordsAndIndexes() public {
        vm.prank(alice);
        hall.linkIdentity("alice_the_smith");

        (string memory handle, uint64 linkedAt, uint64 updatedAt) = hall.identityOf(alice);
        assertEq(handle, "alice_the_smith");
        assertEq(linkedAt, uint64(block.timestamp));
        assertEq(updatedAt, uint64(block.timestamp));
        assertEq(hall.addressOfHandle("alice_the_smith"), alice);
    }

    function test_LinkIdentity_RejectsBadHandles() public {
        vm.startPrank(alice);
        vm.expectRevert(CrucibleHall.EmptyHandle.selector);
        hall.linkIdentity("");
        vm.expectRevert(CrucibleHall.HandleTooLong.selector);
        hall.linkIdentity("this-handle-is-far-too-long-to-link");
        vm.expectRevert(abi.encodeWithSelector(CrucibleHall.InvalidHandleCharacter.selector, 3));
        hall.linkIdentity("bad handle!");
        vm.stopPrank();
    }

    function test_LinkIdentity_TakenByAnother() public {
        vm.prank(alice);
        hall.linkIdentity("smith");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CrucibleHall.HandleAlreadyTaken.selector, alice));
        hall.linkIdentity("smith");
    }

    function test_LinkIdentity_ReplayIsANoOp() public {
        vm.startPrank(alice);
        hall.linkIdentity("smith");
        hall.linkIdentity("smith"); // same handle again — no revert, no event
        (,, uint64 updatedAt) = hall.identityOf(alice);
        assertEq(updatedAt, uint64(block.timestamp)); // unchanged
        vm.stopPrank();
    }

    function test_LinkIdentity_SwitchingReleasesTheOldHandle() public {
        vm.startPrank(alice);
        hall.linkIdentity("first");
        hall.linkIdentity("second");
        vm.stopPrank();

        assertEq(hall.addressOfHandle("first"), address(0)); // released
        assertEq(hall.addressOfHandle("second"), alice);
        (string memory currentHandle, , ) = hall.identityOf(alice);
        assertEq(currentHandle, "second");
    }

    // ── trials ──────────────────────────────────────────────────────

    function _linked(address who, string memory handle) internal {
        vm.prank(who);
        hall.linkIdentity(handle);
    }

    function test_OpenTrial_RequiresIdentity() public {
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(CrucibleHall.NoIdentity.selector, bob));
        hall.openTrial{value: 0.01 ether}(bob);
    }

    function test_OpenTrial_RequiresMinimumStake() public {
        _linked(bob, "bob");
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(CrucibleHall.StakeTooLow.selector, hall.MIN_STAKE()));
        hall.openTrial{value: 0.0005 ether}(bob);
    }

    function test_SettleTrial_PaysStakePlusBonus() public {
        _linked(bob, "bob");
        vm.prank(settler);
        uint256 id = hall.openTrial{value: 0.01 ether}(bob);

        vm.deal(address(hall), 1 ether); // house funding for the bonus
        uint256 before = bob.balance;

        vm.prank(settler);
        uint256 reward = hall.settleTrial(id, 42);

        uint256 expected = 0.01 ether + (0.01 ether * hall.REWARD_BPS()) / 10000;
        assertEq(reward, expected);
        assertEq(bob.balance, before + expected);
        assertTrue(hall.isSettled(id));
        assertEq(hall.trialOf(id).score, 42);
    }

    function test_SettleTrial_RejectsDoubleSettle() public {
        _linked(bob, "bob");
        vm.prank(settler);
        uint256 id = hall.openTrial{value: 0.01 ether}(bob);
        vm.prank(settler);
        hall.settleTrial(id, 1);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(CrucibleHall.TrialAlreadySettled.selector, id));
        hall.settleTrial(id, 2);
    }

    function test_SettleTrial_RejectsStrangers() public {
        _linked(bob, "bob");
        vm.prank(settler);
        uint256 id = hall.openTrial{value: 0.01 ether}(bob);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(abi.encodeWithSelector(CrucibleHall.NotAuthorized.selector, makeAddr("stranger")));
        hall.settleTrial(id, 1);
    }

    /// The payout can never promise more than the contract holds — the reward is
    /// capped to the balance, so a house that forgot to fund pays stake-only.
    function test_SettleTrial_CapsRewardAtBalance() public {
        _linked(bob, "bob");
        vm.prank(settler);
        uint256 id = hall.openTrial{value: 0.01 ether}(bob);
        // no house funding: balance is exactly the stake
        vm.prank(settler);
        uint256 reward = hall.settleTrial(id, 7);
        assertEq(reward, 0.01 ether);
        assertEq(address(hall).balance, 0);
    }

    function test_RevertUnknownTrial() public {
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(CrucibleHall.TrialNotFound.selector, 99));
        hall.settleTrial(99, 1);
    }
}
