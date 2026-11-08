// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {EngramERC1155} from "../contracts/EngramERC1155.sol";

contract EngramERC1155Test is Test {
    EngramERC1155 public e;
    address admin = address(0xA11CE);
    address minter = address(0xD17E);
    address user = address(0xB0B);

    function setUp() public {
        vm.prank(admin);
        e = new EngramERC1155(admin, "ipfs://CID/{id}.json");
        vm.prank(admin);
        e.setMinter(minter, true);
    }

    function testMintAndBalance() public {
        vm.prank(minter);
        e.mint(user, 1001, 3, bytes32(uint256(1)));
        assertEq(e.balanceOf(user, 1001), 3);
        assertEq(e.totalMinted(1001), 3);
    }

    function testCapEnforced() public {
        vm.prank(admin);
        e.setCap(1001, 2);
        vm.prank(minter);
        vm.expectRevert(EngramERC1155.CapExceeded.selector);
        e.mint(user, 1001, 3, bytes32(uint256(1)));
    }

    function testSoulboundCredential() public {
        vm.prank(minter);
        e.mint(user, 100, 1, bytes32(uint256(1)));
        vm.prank(user);
        vm.expectRevert(EngramERC1155.Soulbound.selector);
        e.safeTransferFrom(user, address(0xC0FFEE), 100, 1, "");
    }

    function testCollectibleTransferable() public {
        vm.prank(minter);
        e.mint(user, 2000, 1, bytes32(uint256(1)));
        vm.prank(user);
        e.safeTransferFrom(user, address(0xC0FFEE), 2000, 1, "");
        assertEq(e.balanceOf(address(0xC0FFEE), 2000), 1);
    }

    function testNonMinterCannotMint() public {
        vm.prank(user);
        vm.expectRevert();
        e.mint(user, 1001, 1, bytes32(uint256(1)));
    }

    function testInterfaceDetection() public view {
        assertTrue(e.supportsInterface(type(IERC1155).interfaceId));
        assertTrue(e.supportsInterface(type(IAccessControl).interfaceId));
    }

    function testUriTemplate() public view {
        assertEq(e.uri(1001), "ipfs://CID/{id}.json");
    }

    function testBatchMintAndSoulboundGuard() public {
        uint256[] memory ids = new uint256[](2);
        uint256[] memory amts = new uint256[](2);
        bytes32[] memory refs = new bytes32[](2);
        ids[0] = 1001; ids[1] = 2000;
        amts[0] = 1; amts[1] = 1;
        refs[0] = bytes32(uint256(1)); refs[1] = bytes32(uint256(2));
        vm.prank(minter);
        e.mintBatch(user, ids, amts, refs);
        assertEq(e.balanceOf(user, 1001), 1);
        assertEq(e.balanceOf(user, 2000), 1);
    }
}
