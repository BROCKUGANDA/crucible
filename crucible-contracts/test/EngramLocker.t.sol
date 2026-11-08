// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {EngramLocker} from "../contracts/EngramLocker.sol";

contract EngramLockerTest is Test {
    EngramLocker public l;
    address admin = address(0xA11CE);
    address user = address(0xB0B);

    function setUp() public {
        vm.prank(admin);
        l = new EngramLocker(address(0));
    }

    function testLockAndUnlock() public {
        vm.prank(admin);
        uint256 id = l.lock(user, 1001, 5, 100);
        assertTrue(l.isLocked(id));
        vm.warp(block.timestamp + 101);
        vm.prank(user);
        l.unlock(id);
        assertFalse(l.isLocked(id));
    }

    function testUnlockTooEarlyReverts() public {
        vm.prank(admin);
        uint256 id = l.lock(user, 1001, 5, 100);
        vm.prank(user);
        vm.expectRevert(EngramLocker.StillLocked.selector);
        l.unlock(id);
    }

    function testNonOwnerCannotUnlock() public {
        vm.prank(admin);
        uint256 id = l.lock(user, 1001, 5, 100);
        vm.warp(block.timestamp + 101);
        vm.prank(address(0xC0FFEE));
        vm.expectRevert(EngramLocker.NotOwner.selector);
        l.unlock(id);
    }

    function testZeroAmountReverts() public {
        vm.prank(admin);
        vm.expectRevert(EngramLocker.ZeroAmount.selector);
        l.lock(user, 1001, 0, 100);
    }

    function testLocksOf() public {
        vm.prank(admin);
        l.lock(user, 1001, 1, 10);
        vm.prank(admin);
        l.lock(user, 1002, 2, 20);
        assertEq(l.locksOf(user).length, 2);
    }
}
