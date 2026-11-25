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
    address userB = address(0xC0DE);

    function _leaf(address who, uint256 amount, uint256 cid, uint256 tokenId) public view returns (bytes32) {
        return keccak256(abi.encodePacked(block.chainid, who, amount, cid, tokenId));
    }

    /// Two-leaf root using the same sorted-pair hashing as the distributor.
    function _pairRoot(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
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
        bytes32 leafA = _leaf(user, 1, 0, 1001);
        bytes32 leafB = _leaf(userB, 1, 0, 1001);
        bytes32 root = _pairRoot(leafA, leafB);
        vm.prank(admin);
        uint256 cid = d.createCampaign(root, 1001, 1, 0, type(uint64).max);

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafB;
        vm.prank(user);
        d.claim(cid, 1, proofA);

        // A second valid claimant must be refused once the budget is spent.
        bytes32[] memory proofB = new bytes32[](1);
        proofB[0] = leafA;
        vm.prank(userB);
        vm.expectRevert(EngramDistributor.BudgetExhausted.selector);
        d.claim(cid, 1, proofB);

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
        token = new EngramERC1155(admin, "ipfs://CID/{id}.json");
        // distributor is engine room: admin wires it as the minter role.
        vm.prank(admin);
        d = new EngramDistributor(address(token));
        vm.prank(admin);
        token.setMinter(address(d), true);

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

    function testClaimBeforeWindowReverts() public {
        bytes32 leaf = _leaf(user, 1, 0, 1001);
        vm.prank(admin);
        uint256 cid = d.createCampaign(leaf, 1001, 10, 100, 200);
        bytes32[] memory proof = new bytes32[](0);
        vm.warp(99);
        vm.prank(user);
        vm.expectRevert(EngramDistributor.OutsideWindow.selector);
        d.claim(cid, 1, proof);
    }

    function testClaimAfterWindowReverts() public {
        bytes32 leaf = _leaf(user, 1, 0, 1001);
        vm.prank(admin);
        uint256 cid = d.createCampaign(leaf, 1001, 10, 100, 200);
        bytes32[] memory proof = new bytes32[](0);
        vm.warp(201);
        vm.prank(user);
        vm.expectRevert(EngramDistributor.OutsideWindow.selector);
        d.claim(cid, 1, proof);
    }

    function testPausedCampaignBlocksClaimUntilUnpaused() public {
        bytes32 leaf = _leaf(user, 1, 0, 1001);
        vm.prank(admin);
        uint256 cid = d.createCampaign(leaf, 1001, 10, 0, type(uint64).max);
        bytes32[] memory proof = new bytes32[](0);

        vm.prank(admin);
        d.pauseCampaign(cid, true);
        vm.prank(user);
        vm.expectRevert(EngramDistributor.CampaignPausedErr.selector);
        d.claim(cid, 1, proof);

        vm.prank(admin);
        d.pauseCampaign(cid, false);
        vm.prank(user);
        d.claim(cid, 1, proof);
        assertTrue(d.hasClaimed(cid, user));
    }

    function testOnlyAdminCreatesOrPausesCampaigns() public {
        bytes32 leaf = _leaf(user, 1, 0, 1001);
        vm.prank(user);
        vm.expectRevert(EngramDistributor.NotAdmin.selector);
        d.createCampaign(leaf, 1001, 10, 0, type(uint64).max);

        vm.prank(admin);
        uint256 cid = d.createCampaign(leaf, 1001, 10, 0, type(uint64).max);
        vm.prank(user);
        vm.expectRevert(EngramDistributor.NotAdmin.selector);
        d.pauseCampaign(cid, true);
    }

    function testCreateRejectsInvertedWindow() public {
        vm.prank(admin);
        vm.expectRevert(bytes("bad window"));
        d.createCampaign(bytes32(0), 1001, 10, 200, 100);
    }

    function testUnknownCampaignReverts() public {
        bytes32[] memory proof = new bytes32[](0);
        vm.prank(user);
        vm.expectRevert(EngramDistributor.CampaignNotFound.selector);
        d.claim(7, 1, proof);
    }

    /// The token id is part of the leaf: a proof issued for token 1002 must not
    /// claim token 1001 in a campaign that names 1001.
    function testLeafForAnotherTokenFails() public {
        bytes32 leaf = _leaf(user, 1, 0, 1002);
        vm.prank(admin);
        uint256 cid = d.createCampaign(leaf, 1001, 10, 0, type(uint64).max);
        bytes32[] memory proof = new bytes32[](0);
        vm.prank(user);
        vm.expectRevert(EngramDistributor.InvalidProof.selector);
        d.claim(cid, 1, proof);
    }

    /// A revoked minter cannot mint through the distributor, so the claim
    /// reverts and is not recorded.
    function testRevokedMinterBlocksClaim() public {
        vm.prank(admin);
        token = new EngramERC1155(admin, "ipfs://CID/{id}.json");
        vm.prank(admin);
        d = new EngramDistributor(address(token));
        vm.prank(admin);
        token.setMinter(address(d), true);
        vm.prank(admin);
        token.setMinter(address(d), false);

        bytes32 leaf = _leaf(user, 1, 0, 1001);
        vm.prank(admin);
        uint256 cid = d.createCampaign(leaf, 1001, 10, 0, type(uint64).max);
        bytes32[] memory proof = new bytes32[](0);
        vm.prank(user);
        vm.expectRevert();
        d.claim(cid, 1, proof);
        assertFalse(d.hasClaimed(cid, user));
        assertEq(token.balanceOf(user, 1001), 0);
    }
}
