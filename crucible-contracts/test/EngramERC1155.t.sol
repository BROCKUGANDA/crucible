// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {EngramERC1155} from "../contracts/EngramERC1155.sol";

contract EngramERC1155Test is Test {
    EngramERC1155 public e;
    address admin = address(0xA11CE);
    address minter;
    address user = address(0xB0B);

    function setUp() public {
        vm.prank(admin);
        e = new EngramERC1155();
        minter = admin;
    }

    function testMintAndBalance() public {
        vm.prank(minter);
        e.mint(user, 1001, 3, bytes32(uint256(1)));
        assertEq(e.balanceOf(user, 1001), 3);
        assertEq(e.totalMinted(1001), 3);
    }

    function testCapEnforced() public {
        vm.prank(minter);
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
        e.safeTransferFrom(user, address(0xC0FFEE), 100, 1);
    }

    function testCollectibleTransferable() public {
        vm.prank(minter);
        e.mint(user, 2000, 1, bytes32(uint256(1)));
        vm.prank(user);
        e.safeTransferFrom(user, address(0xC0FFEE), 2000, 1);
        assertEq(e.balanceOf(address(0xC0FFEE), 2000), 1);
    }

    function testNonMinterCannotMint() public {
        vm.prank(user);
        vm.expectRevert(EngramERC1155.NotMinter.selector);
        e.mint(user, 1001, 1, bytes32(uint256(1)));
    }
}
