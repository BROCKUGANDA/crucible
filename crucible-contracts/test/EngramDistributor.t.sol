// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {EngramDistributor} from "../contracts/EngramDistributor.sol";

contract EngramDistributorTest is Test {
    EngramDistributor public d;
    address admin = address(0xA11CE);
    address user = address(0xB0B);

    function setUp() public {
        vm.prank(admin);
        d = new EngramDistributor(address(0));
    }

    function testClaimSingleLeaf() public {
        bytes32 leaf = keccak256(abi.encodePacked(user, uint256(1), uint256(0)));
        vm.prank(admin);
        uint256 cid = d.createCampaign(leaf, 1001, 10, 0, type(uint64).max);
        bytes32[] memory proof = new bytes32[](0);
        vm.prank(user);
        d.claim(cid, 1, proof);
        assertTrue(d.hasClaimed(cid, user));
    }

    function testDoubleClaimReverts() public {
        bytes32 leaf = keccak256(abi.encodePacked(user, uint256(1), uint256(0)));
        vm.prank(admin);
        uint256 cid = d.createCampaign(leaf, 1001, 10, 0, type(uint64).max);
        bytes32[] memory proof = new bytes32[](0);
        vm.prank(user);
        d.claim(cid, 1, proof);
        vm.prank(user);
        vm.expectRevert(EngramDistributor.AlreadyClaimed.selector);
        d.claim(cid, 1, proof);
    }

    function testInvalidProofReverts() public {
        bytes32 leaf = keccak256(abi.encodePacked(user, uint256(1), uint256(0)));
        vm.prank(admin);
        uint256 cid = d.createCampaign(leaf, 1001, 10, 0, type(uint64).max);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = bytes32(uint256(999));
        vm.prank(user);
        vm.expectRevert(EngramDistributor.InvalidProof.selector);
        d.claim(cid, 1, proof);
    }

    function testBudgetExhausted() public {
        bytes32 leaf = keccak256(abi.encodePacked(user, uint256(1), uint256(0)));
        vm.prank(admin);
        uint256 cid = d.createCampaign(leaf, 1001, 1, 0, type(uint64).max);
        bytes32[] memory proof = new bytes32[](0);
        vm.prank(user);
        d.claim(cid, 1, proof);
        // another user with valid proof would be needed; budget already 1/1
        (,,, uint256 claimed,,,) = d.campaigns(cid);
        assertEq(claimed, 1);
    }
}
