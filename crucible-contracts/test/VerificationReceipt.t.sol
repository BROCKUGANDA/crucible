// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VerificationReceipt} from "../contracts/VerificationReceipt.sol";

/// The receipt is the one credential in this system that a third party can read without
/// trusting the API. Two properties make that worth anything: only the settlement path can
/// mint it, once per trial, and it cannot move.
contract VerificationReceiptTest is Test {
    VerificationReceipt receipt;
    address minter = makeAddr("trials");
    address agent = makeAddr("agent");
    bytes32 constant VERDICT = keccak256("verdict");
    bytes32 constant SPEC = keccak256("spec");

    function setUp() public {
        receipt = new VerificationReceipt();
        receipt.setMinter(minter);
    }

    function _mint(uint256 trialId) internal returns (uint256 tokenId) {
        vm.prank(minter);
        tokenId = receipt.mintReceipt(agent, trialId, VERDICT, SPEC, 1);
    }

    // ── minting ──
    function test_Mint_RecordsTrialOwnerAndCounter() public {
        uint256 tokenId = _mint(7);
        assertEq(tokenId, 1);
        assertEq(receipt.receiptIdOfTrial(7), 1);
        assertEq(receipt.ownerOf(1), agent);
        assertEq(receipt.balanceOf(agent), 1);
        assertEq(receipt.tokenCounter(), 1);
    }

    function test_Mint_EmitsMintEvent() public {
        vm.prank(minter);
        vm.expectEmit(true, true, false, true);
        emit VerificationReceipt.ReceiptMinted(1, 7, VERDICT, 1);
        receipt.mintReceipt(agent, 7, VERDICT, SPEC, 1);
    }

    function test_Mint_OnlyMinter() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(VerificationReceipt.NotMinter.selector);
        receipt.mintReceipt(agent, 7, VERDICT, SPEC, 1);
    }

    function test_Mint_RejectsZeroRecipient() public {
        vm.prank(minter);
        vm.expectRevert(VerificationReceipt.ZeroAddress.selector);
        receipt.mintReceipt(address(0), 7, VERDICT, SPEC, 1);
    }

    /// A retried settlement batch must not be able to issue a second proof for one trial.
    function test_Mint_OneReceiptPerTrial() public {
        _mint(7);
        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(VerificationReceipt.AlreadyMinted.selector, 7));
        receipt.mintReceipt(agent, 7, VERDICT, SPEC, 1);
        assertEq(receipt.tokenCounter(), 1);
    }

    // ── soulbound ──
    /// The transfer and approval selectors do not exist on this contract. This is the whole
    /// point: a proof of proven work that can be sold is a proof marketplace, and Alloy's
    /// non-transferability law (contract-spec.md §12) says the same thing about reputation.
    function test_Soulbound_NoTransferOrApprovalSelectors() public {
        _mint(7);

        (bool okTransfer,) = address(receipt).call(abi.encodeWithSelector(bytes4(0x23b872dd), agent, minter, uint256(1)));
        assertFalse(okTransfer, "transferFrom must not exist");
        (bool okSafe,) = address(receipt).call(abi.encodeWithSelector(bytes4(0x42842e0e), agent, minter, uint256(1)));
        assertFalse(okSafe, "safeTransferFrom must not exist");
        (bool okApprove,) = address(receipt).call(abi.encodeWithSelector(bytes4(0x095ea7b3), minter, uint256(1)));
        assertFalse(okApprove, "approve must not exist");
        (bool okForAll,) = address(receipt).call(abi.encodeWithSelector(bytes4(0xa22cb465), minter, true));
        assertFalse(okForAll, "setApprovalForAll must not exist");

        // Still exactly one holder after every attempted move.
        assertEq(receipt.balanceOf(agent), 1);
        assertEq(receipt.balanceOf(minter), 0);
    }

    /// No receive path: the escrow has none either, so a passive ETH transfer cannot happen.
    /// The test contract is funded first — without ETH the call fails for the wrong reason,
    /// which is exactly how a green gate stops being a measurement.
    function test_CannotHoldEth() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(receipt).call{value: 1 ether}("");
        assertFalse(ok, "the receipt contract must not accept ETH");
        assertEq(address(receipt).balance, 0);
    }

    // ── metadata ──
    /// The metadata must name the trial the receipt attests to, not the mint counter. Those
    /// two numbers diverge the moment a batch skips an already-settled trial.
    function test_TokenURI_CarriesTheTrialIdNotTheTokenId() public {
        uint256 tokenId = _mint(77);
        assertEq(tokenId, 1);

        string memory json = _jsonOf(receipt.tokenURI(tokenId));
        assertEq(vm.parseJsonUint(json, "$.attributes[0].value"), 77);
        assertEq(vm.parseJsonUint(json, "$.attributes[3].value"), 1); // graderVersion
        assertTrue(bytes(vm.parseJsonString(json, "$.attributes[1].value")).length == 66); // verdictHash hex

        // The description repeats it, because that is the line a reader actually reads.
        assertEq(vm.parseJsonString(json, "$.description"), 'Non-transferable proof that trial 77 settled in Crucible Warden v1');
    }

    function test_TokenURI_UnknownTokenReverts() public {
        vm.expectRevert(VerificationReceipt.NotMinted.selector);
        receipt.tokenURI(9);
    }

    // ── minter wiring ──
    function test_Minter_DeployerIsMinterUntilSet() public {
        VerificationReceipt fresh = new VerificationReceipt();
        assertTrue(fresh.isMinter(address(this)));
        assertFalse(fresh.isMinter(minter));
    }

    function test_SetMinter_OwnerOnlyAndNoZero() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(VerificationReceipt.NotOwner.selector);
        receipt.setMinter(stranger);

        vm.expectRevert(VerificationReceipt.ZeroAddress.selector);
        receipt.setMinter(address(0));

        address other = makeAddr("other");
        vm.expectEmit(true, false, false, false);
        emit VerificationReceipt.MinterSet(other);
        receipt.setMinter(other);
        assertTrue(receipt.isMinter(other));
        assertFalse(receipt.isMinter(minter));
    }

    /// After the minter moves, the old minter can no longer mint — the wiring in Deploy.s.sol
    /// is therefore the only thing that has to be right.
    function test_OldMinterCannotMintAfterRotation() public {
        receipt.setMinter(makeAddr("replacement"));
        vm.prank(minter);
        vm.expectRevert(VerificationReceipt.NotMinter.selector);
        receipt.mintReceipt(agent, 7, VERDICT, SPEC, 1);
    }

    // ── helper ──
    /// tokenURI is a data URI; the JSON begins after the fixed `data:application/json,` prefix.
    function _jsonOf(string memory uri) internal pure returns (string memory) {
        bytes memory b = bytes(uri);
        bytes memory prefix = bytes("data:application/json,");
        require(b.length > prefix.length, "tokenURI is not a JSON data URI");
        bytes memory json = new bytes(b.length - prefix.length);
        for (uint256 i; i < json.length; ++i) {
            json[i] = b[prefix.length + i];
        }
        return string(json);
    }
}
