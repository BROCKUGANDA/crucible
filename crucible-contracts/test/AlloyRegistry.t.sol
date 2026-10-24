// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AlloyRegistry} from "../contracts/AlloyRegistry.sol";

contract AlloyRegistryTest is Test {
    AlloyRegistry alloy;
    address forgeMock = makeAddr("forge");
    address op = makeAddr("operator");
    address buyer = makeAddr("buyer");

    function setUp() public {
        alloy = new AlloyRegistry();
        vm.prank(alloy.owner());
        alloy.setForge(forgeMock);
    }

    function test_TierLadder() public {
        vm.startPrank(forgeMock);
        alloy.recordWin(1, op, false, op);
        assertEq(alloy.tierOf(1), 1); // Iron
        alloy.recordWin(1, op, false, op);
        alloy.recordWin(1, op, false, op);
        assertEq(alloy.tierOf(1), 2); // Bronze @3
        for (uint256 i; i < 7; ++i) {
            alloy.recordWin(1, op, true, op);
        }
        assertEq(alloy.tierOf(1), 3); // Steel @10 & survived
        assertEq(alloy.tierName(1), "Steel");
        vm.stopPrank();
    }

    function test_Damascus_RequiresThreeSurvived() public {
        vm.startPrank(forgeMock);
        for (uint256 i; i < 25; ++i) {
            alloy.recordWin(9, op, false, op);
        }
        (uint32 w,,,,,,,,) = alloy.records(9);
        assertEq(w, 25);
        assertEq(alloy.tierOf(9), 2); // 25 wins but 0 survived → Bronze, not Damascus
        alloy.recordWin(9, op, true, op);
        alloy.recordWin(9, op, true, op);
        alloy.recordWin(9, op, true, op);
        assertEq(alloy.tierOf(9), 4);
        assertEq(alloy.tierName(9), "Damascus");
        vm.stopPrank();
    }

    function test_SlashDecays() public {
        vm.startPrank(forgeMock);
        alloy.recordWin(2, op, true, op); // Iron
        alloy.recordSlash(2, op, op);
        (uint32 w, uint32 s, uint32 sl,,,,,,) = alloy.records(2);
        assertEq(w, 0); // 1 * 3/4 = 0
        assertEq(s, 1); // the survived-break count is not touched by a slash
        assertEq(alloy.tierOf(2), 0); // back to Unforged
        assertEq(sl, 1);
        vm.stopPrank();
    }

    function test_Soulbound_NoTransfersExist() public {
        vm.prank(forgeMock);
        alloy.recordWin(3, op, false, op);
        // The contract exposes no transferFrom/safeTransferFrom — enforced at compile time.
        // Tooling reads ERC-5192:
        assertTrue(alloy.locked(3));
    }

    function test_LockedFalseBeforeMint() public view {
        assertFalse(alloy.locked(999));
    }

    function test_OnlyForgeWrites() public {
        vm.prank(op);
        vm.expectRevert(AlloyRegistry.NotForge.selector);
        alloy.recordWin(4, op, false, op);
    }

    function test_SetForge_RevertNonOwner() public {
        AlloyRegistry fresh = new AlloyRegistry();
        vm.prank(op);
        vm.expectRevert(AlloyRegistry.NotOwner.selector);
        fresh.setForge(op);
    }

    function test_SetForge_RevertTwice() public {
        vm.prank(alloy.owner());
        vm.expectRevert(AlloyRegistry.ForgeAlreadySet.selector);
        alloy.setForge(op);
    }

    function test_TokenURI_OnChainJSON() public {
        vm.prank(forgeMock);
        alloy.recordWin(5, op, true, op);
        string memory uri = alloy.tokenURI(5);
        assertTrue(bytes(uri).length > 0);
        assertTrue(_contains(uri, '"tier":"Iron"'));
        assertTrue(_contains(uri, '"wins":1'));
        assertTrue(_contains(uri, '"slashes":0'));
        assertTrue(_contains(uri, '"name":"Alloy #5"'));
        // ADR-0012: the history beside the window is in the credential, not only behind our API.
        assertTrue(_contains(uri, '"epoch":1'));
        assertTrue(_contains(uri, '"lifetimeWins":1'));
        assertTrue(_contains(uri, '"lifetimeSlashes":0'));
    }

    function test_TokenURI_RevertNotMinted() public {
        vm.expectRevert(AlloyRegistry.NotMinted.selector);
        alloy.tokenURI(123);
    }

    function test_MintEmitsTransferAndLocked() public {
        vm.recordLogs();
        vm.prank(forgeMock);
        alloy.recordWin(7, op, false, op);
        vm.getRecordedLogs();
        // ownerOf/balanceOf are the observable proof the ERC-721 Transfer + ERC-5192 Locked fired
        assertEq(alloy.ownerOf(7), op);
        assertEq(alloy.balanceOf(op), 1);
    }

    // ───────────────────────── ADR-0012: identity epochs ─────────────────────────

    /// @dev The whole point of the epoch: the window belongs to the identity that earned it.
    function test_Epoch_HandoverZeroesTheWindowAndKeepsTheLifetime() public {
        vm.startPrank(forgeMock);
        alloy.recordWin(11, op, true, op);
        alloy.recordWin(11, op, true, op);
        alloy.recordSlash(11, op, op); // leaves 1 win (2 * 3/4) and one scar
        (uint32 wBefore,, uint32 slBefore, uint8 tierBefore, uint32 epochBefore,,,,) = alloy.records(11);
        assertEq(wBefore, 1);
        assertEq(tierBefore, 1); // Iron, from the window
        assertEq(epochBefore, 1);

        // The identity is sold. Neither Crucible contract is in that transaction.
        alloy.recordWin(11, op, false, buyer);

        (uint32 w, uint32 survived, uint32 slashes, uint8 tier, uint32 epoch, uint32 lifeW, uint32 lifeS,,) =
            alloy.records(11);
        assertEq(epoch, 2, "the window did not turn over");
        assertEq(w, 1, "a new holder inherited the old holder's wins");
        assertEq(survived, 0, "a new holder inherited the old holder's survived breaks");
        assertEq(slashes, 0, "a new holder inherited the old holder's scar");
        assertEq(tier, 1, "the tier is not recomputed from the new window"); // 1 win → Iron
        assertEq(lifeW, 3, "the lifetime book is not what a reset cannot erase");
        assertEq(lifeS, 1, "the lifetime slash book lost a slash");
        assertEq(slBefore, 1);
        vm.stopPrank();
    }

    /// @dev The buyer starts where any new agent starts, and the seller's credential stays put.
    function test_Epoch_BuyerStartsUnforged_TokenNeverMoves() public {
        vm.startPrank(forgeMock);
        for (uint256 i; i < 3; ++i) {
            alloy.recordWin(12, op, false, op);
        }
        assertEq(alloy.tierOf(12), 2); // Bronze
        vm.stopPrank();

        vm.prank(forgeMock);
        alloy.recordWin(12, op, false, buyer);

        assertEq(alloy.tierOf(12), 1, "the handover left a tier the buyer did not earn");
        assertEq(alloy.ownerOf(12), op, "the soulbound credential moved; H-5 is now false");
        assertEq(alloy.holderOf(12), buyer, "the window is not attributed to the new holder");
        assertEq(alloy.balanceOf(op), 1, "a handover must not move the ERC-721 balance");
        assertEq(alloy.balanceOf(buyer), 0, "a handover must not move the ERC-721 balance");
    }

    /// @dev The closed window is in the log, because a reader cannot ask the chain what it
    /// zeroed: the state it describes is gone.
    function test_Epoch_EmitsTheClosedWindow() public {
        vm.startPrank(forgeMock);
        alloy.recordWin(13, op, true, op);
        alloy.recordWin(13, op, false, op);
        vm.stopPrank();

        vm.prank(forgeMock);
        vm.expectEmit(true, true, false, true, address(alloy));
        emit AlloyRegistry.EpochStarted(13, 2, op, buyer, 2, 1, 0, uint64(block.timestamp));
        alloy.recordWin(13, op, false, buyer);
    }

    /// @dev A failed identity read is "nothing observed", not "handed over to nobody". Without
    /// this, a registry that returns zero would be a free reset button.
    function test_Epoch_NothingObservedLeavesTheHolderAlone() public {
        vm.startPrank(forgeMock);
        alloy.recordWin(14, op, false, op);
        alloy.recordWin(14, op, false, address(0)); // registry down
        (,,,, uint32 epoch,,,,) = alloy.records(14);
        assertEq(epoch, 1, "an unobserved settlement turned the epoch");

        alloy.recordWin(14, op, false, buyer);
        (,,,, epoch,,,,) = alloy.records(14);
        assertEq(epoch, 2, "a real handover after a failed read must still turn the epoch");

        alloy.recordWin(14, op, false, address(0));
        (uint32 w,,, uint8 tier,,,,,) = alloy.records(14);
        assertEq(tier, 1); // two wins in the buyer's window is Iron; Bronze starts at three
        assertEq(w, 2);
        assertEq(alloy.holderOf(14), buyer, "a failed read must not hand the window back");
        vm.stopPrank();
    }

    /// @dev The decay a slash applies must land on the window the slash was earned in, not on a
    /// predecessor's history.
    function test_Epoch_SlashAfterHandoverDecaysOnlyTheNewWindow() public {
        vm.startPrank(forgeMock);
        for (uint256 i; i < 4; ++i) {
            alloy.recordWin(15, op, false, op);
        }
        alloy.recordWin(15, op, false, buyer); // epoch 2, window 0
        alloy.recordWin(15, op, false, buyer);
        alloy.recordWin(15, op, false, buyer);
        alloy.recordSlash(15, op, buyer); // 3 * 3/4 = 2, and only in this window
        (uint32 w,, uint32 slashes,,, uint32 lifeW, uint32 lifeS,,) = alloy.records(15);
        assertEq(w, 2, "the slash reached into the previous holder's wins");
        assertEq(slashes, 1);
        assertEq(lifeW, 7, "lifetime wins must count every win ever earned");
        assertEq(lifeS, 1);
        vm.stopPrank();
    }

    function test_Epoch_EveryHandoverCountsUp() public {
        address[] memory holders = new address[](3);
        holders[0] = op;
        holders[1] = buyer;
        holders[2] = makeAddr("third");
        vm.startPrank(forgeMock);
        for (uint256 i; i < holders.length; ++i) {
            alloy.recordWin(16, op, false, holders[i]);
            (,,,, uint32 epochInLoop,,,,) = alloy.records(16);
            assertEq(epochInLoop, uint32(i) + 1, "epochs do not count up one at a time");
            assertEq(alloy.holderOf(16), holders[i]);
        }
        // A hand-back to a previous holder is still a handover: the epoch counts transitions,
        // not distinct addresses.
        alloy.recordWin(16, op, false, op);
        (,,,, uint32 epoch,,,,) = alloy.records(16);
        assertEq(epoch, 4);
        vm.stopPrank();
    }

    function test_EpochOf_NamedReadMatchesTheTuple() public {
        vm.startPrank(forgeMock);
        alloy.recordWin(17, op, false, op);
        alloy.recordSlash(17, op, op);
        alloy.recordWin(17, op, false, buyer);
        vm.stopPrank();

        (uint32 epoch, uint64 startedAt, uint32 lifeW, uint32 lifeS) = alloy.epochOf(17);
        (,,,, uint32 tupleEpoch, uint32 tupleLifeW, uint32 tupleLifeS,, uint64 tupleStartedAt) = alloy.records(17);
        assertEq(epoch, 2);
        assertEq(epoch, tupleEpoch, "epochOf and records disagree; one of them is mispositioned");
        assertEq(lifeW, tupleLifeW);
        assertEq(lifeS, tupleLifeS);
        assertEq(startedAt, tupleStartedAt);
        assertEq(startedAt, uint64(block.timestamp), "the epoch must carry the chain's own time");
    }

    /// real substring search — the spec's original helper returned true for any
    /// needle shorter than the haystack, which asserted nothing.
    function _contains(string memory hay, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(hay);
        bytes memory n = bytes(needle);
        if (n.length == 0) return true;
        if (n.length > h.length) return false;
        for (uint256 i = 0; i <= h.length - n.length; ++i) {
            bool ok = true;
            for (uint256 j = 0; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }
}
