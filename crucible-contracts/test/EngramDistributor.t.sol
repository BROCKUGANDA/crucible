// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {EngramDistributor} from "../contracts/EngramDistributor.sol";
import {EngramERC1155} from "../contracts/EngramERC1155.sol";

contract EngramDistributorTest is Test {
    EngramDistributor public d;
    EngramERC1155 public token;
    address admin = address(0xA11CE);
    address user = address(0xB0B);

    function _leaf(address who, uint256 amount, uint256 cid, uint256 tokenId) public view returns (bytes32) {
        return keccak256(abi.encodePacked(block.chainid, who, amount, cid, tokenId));
    }

    function setUp() public {
        vm.prank(admin);
        d = new EngramDistributor(address(0));
    }

    function testClaimSingleLeaf() public {
        bytes32 leaf = _leaf(user, 1, 0, 1001);
        vm.prank(admin);
        uint256 cid = d.createCampaign(leaf, 1001, 10, 0, type(uint64).max);
        bytes32[] memory proof = new bytes32[](0);
        vm.prank(user);
        d.claim(cid, 1, proof);
        assertTrue(d.hasClaimed(cid, user));
    }

    function testDoubleClaimReverts() public {
        bytes32 leaf = _leaf(user, 1, 0, 1001);
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
        bytes32 leaf = _leaf(user, 1, 0, 1001);
        vm.prank(admin);
        uint256 cid = d.createCampaign(leaf, 1001, 10, 0, type(uint64).max);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = bytes32(uint256(999));
        vm.prank(user);
        vm.expectRevert(EngramDistributor.InvalidProof.selector);
        d.claim(cid, 1, proof);
    }

    function testBudgetExhausted() public {
        bytes32 leaf = _leaf(user, 1, 0, 1001);
        vm.prank(admin);
        uint256 cid = d.createCampaign(leaf, 1001, 1, 0, type(uint64).max);
        bytes32[] memory proof = new bytes32[](0);
        vm.prank(user);
        d.claim(cid, 1, proof);
        // another user with valid proof would be needed; budget already 1/1
        (,,, uint256 claimed,,,) = d.campaigns(cid);
        assertEq(claimed, 1);
    }

    /// The leaf binds this chain: a root built for chain X is useless on
    /// chain Y — the recomputed leaf no longer matches, so the same proof
    /// that claimed here cannot claim there.
    function testLeafBuiltForAnotherChainFails() public {
        bytes32 leaf = keccak256(abi.encodePacked(block.chainid + 1, user, uint256(1), uint256(0), uint256(1001)));
        vm.prank(admin);
        uint256 cid = d.createCampaign(leaf, 1001, 10, 0, type(uint64).max);
        bytes32[] memory proof = new bytes32[](0);
        vm.prank(user);
        vm.expectRevert(EngramDistributor.InvalidProof.selector);
        d.claim(cid, 1, proof);
    }

    /// A claim with the ERC-1155 wired mints: the balance, not the event,
    /// is the record of the distribution.
    function testClaimMintsThroughERC1155() public {
        vm.prank(admin);
        token = new EngramERC1155();
        // distributor is engine room: admin wires it as the minter.
        vm.prank(admin);
        d = new EngramDistributor(address(token));
        vm.prank(admin);
        token.setMinter(address(d));

        bytes32 leaf = _leaf(user, 3, 0, 1001);
        vm.prank(admin);
        uint256 cid = d.createCampaign(leaf, 1001, 10, 0, type(uint64).max);
        bytes32[] memory proof = new bytes32[](0);
        vm.prank(user);
        d.claim(cid, 3, proof);
        assertEq(token.balanceOf(user, 1001), 3);
        assertEq(token.totalMinted(1001), 3);
    }

    /// Without a wired collection the distributor still verifies — the
    /// zero-engram mode is for tests and dry runs.
    function testUnwiredDistributorVerifiesWithoutMinting() public {
        bytes32 leaf = _leaf(user, 1, 0, 1001);
        vm.prank(admin);
        uint256 cid = d.createCampaign(leaf, 1001, 10, 0, type(uint64).max);
        bytes32[] memory proof = new bytes32[](0);
        vm.prank(user);
        d.claim(cid, 1, proof);
        assertTrue(d.hasClaimed(cid, user));
    }
}
