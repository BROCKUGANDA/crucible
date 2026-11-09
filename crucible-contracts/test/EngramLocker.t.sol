// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {EngramLocker} from "../contracts/EngramLocker.sol";

/// Locker is intentionally disabled until custodial semantics are audited.
/// These tests pin the disabled behavior: every custody path reverts.
contract EngramLockerTest is Test {
    EngramLocker public l;

    function setUp() public {
        l = new EngramLocker();
    }

    function testLockDisabled() public {
        vm.expectRevert(EngramLocker.LockerDisabled.selector);
        l.lock(address(0xB0B), 1001, 5, 100);
    }

    function testUnlockDisabled() public {
        vm.expectRevert(EngramLocker.LockerDisabled.selector);
        l.unlock(0);
    }

    function testLocksOfEmpty() public view {
        assertEq(l.locksOf(address(0xB0B)).length, 0);
    }

    function testIsLockedFalse() public view {
        assertFalse(l.isLocked(0));
    }
}
