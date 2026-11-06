// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {RewardsTreasury} from "../contracts/RewardsTreasury.sol";

contract RewardsTreasuryTest is Test {
    RewardsTreasury public t;
    address admin = address(0xA11CE);

    function setUp() public {
        vm.prank(admin);
        t = new RewardsTreasury();
    }

    function testFundAndClaim() public {
        vm.prank(admin);
        t.setBudget(1, 100);
        vm.prank(admin);
        t.fund(1, 60);
        vm.prank(admin);
        t.recordClaim(1, 10);
        assertEq(t.remaining(1), 50);
    }

    function testOverClaimReverts() public {
        vm.prank(admin);
        t.setBudget(1, 100);
        vm.prank(admin);
        t.fund(1, 60);
        vm.prank(admin);
        vm.expectRevert(RewardsTreasury.OverClaimed.selector);
        t.recordClaim(1, 70);
    }

    function testOverFundReverts() public {
        vm.prank(admin);
        t.setBudget(1, 100);
        vm.prank(admin);
        vm.expectRevert(RewardsTreasury.OverFunded.selector);
        t.fund(1, 101);
    }

    function testInactiveToggle() public {
        vm.prank(admin);
        t.setBudget(1, 100);
        vm.prank(admin);
        t.toggle(1, false);
        vm.prank(admin);
        vm.expectRevert(RewardsTreasury.Inactive.selector);
        t.fund(1, 10);
    }
}
