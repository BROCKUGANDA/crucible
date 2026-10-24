// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Base} from "./Base.t.sol";
import {Vm} from "forge-std/Vm.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";
import {
    MockIdentityRegistry,
    RevertingIdentityRegistry,
    NullIdentityRegistry
} from "../contracts/mocks/ERC8004Mocks.sol";

/// ADR-0012, end to end through the escrow.
///
/// `AlloyRegistry.t.sol` proves the book turns over when it is *told* a holder changed. These prove
/// the two things that matter on the wire: that the escrow sees a handover it was not part of, and
/// that the registry it asks about can never hold up a verdict. The second is the one that would
/// regress quietly, because every way it can break still looks like a working epoch transition on a
/// healthy registry.
contract IdentityEpochsTest is Base {
    MockIdentityRegistry identity;
    address buyer = makeAddr("buyer");

    /// @dev Written out rather than derived, so changing the event's signature has to be a
    /// deliberate edit here too. `abi-drift.test.ts` compares this same digest against the ABI's
    /// declared topic0, so the two cannot silently disagree.
    bytes32 private constant EPOCH_STARTED =
        keccak256("EpochStarted(uint256,uint32,address,address,uint32,uint32,uint32,uint64)");

    function setUp() public override {
        Base.setUp(); // the escrow, the seats and the alloy registry come from the shared harness
        identity = new MockIdentityRegistry();
        vm.prank(trials.owner());
        trials.setIdentityRegistry(address(identity));
    }

    /// Register and link the way an operator does it: the link is proved against the registry, so
    /// the mock has to mint the identity to the operator first.
    function _registerAndLink() internal returns (uint256 aid, uint256 idId) {
        aid = _register(1 ether);
        vm.prank(operator);
        idId = identity.register("ipfs://identity");
        vm.prank(operator);
        trials.linkIdentity(aid, idId);
    }

    function _settlePaid(uint256 aid) internal returns (uint256 id) {
        vm.deal(sponsor, REWARD);
        vm.prank(sponsor);
        id = trials.createTrial{value: REWARD}(REWARD, SPEC, TESTS, uint64(block.timestamp + 2 days), WINDOW);
        vm.prank(operator);
        trials.claimTrial(id);
        assertEq(trials.getTrial(id).agentId, aid, "the trial must belong to the linked agent");
        _submitRun(id);
        vm.warp(block.timestamp + WINDOW + 1);
        trials.finalize(id);
        assertEq(uint8(trials.getTrial(id).verdict), uint8(CrucibleTrials.Verdict.Paid), "settlement did not pay");
    }

    /// A break that lands: the committee votes, the threshold is reached, and the slash settles in
    /// the same call.
    function _settleSlashed(uint256 aid) internal returns (uint256 id) {
        vm.deal(sponsor, REWARD);
        vm.prank(sponsor);
        id = trials.createTrial{value: REWARD}(REWARD, SPEC, TESTS, uint64(block.timestamp + 2 days), WINDOW);
        vm.prank(operator);
        trials.claimTrial(id);
        assertEq(trials.getTrial(id).agentId, aid, "the slashed trial must belong to the linked agent");
        _submitRun(id);
        _fileBreak(id);
        _resolve(id, true);
        assertEq(uint8(trials.getTrial(id).verdict), uint8(CrucibleTrials.Verdict.Slashed), "the break did not land");
    }

    // ── the handover is observed ──

    function test_HandoverAtSettlement_StartsEpochTwo() public {
        (uint256 aid, uint256 idId) = _registerAndLink();

        _settlePaid(aid);
        (uint32 epochOne, uint64 startedOne,,) = alloy.epochOf(aid);
        assertEq(epochOne, 1, "the first settlement must open epoch 1");
        assertEq(startedOne, uint64(block.timestamp));
        assertEq(alloy.holderOf(aid), operator);
        assertEq(alloy.ownerOf(aid), operator);

        // The identity is sold. Neither Crucible contract is in that transaction and neither is told
        // about it afterwards: this is the whole gap ADR-0012 closes.
        vm.prank(operator);
        identity.transferIdentity(idId, buyer);
        assertEq(identity.ownerOf(idId), buyer);

        vm.warp(block.timestamp + 1 hours);
        _settlePaid(aid);

        (uint32 epochTwo, uint64 startedTwo, uint32 lifetimeWins,) = alloy.epochOf(aid);
        assertEq(epochTwo, 2, "the escrow did not notice the identity changing hands");
        assertGt(startedTwo, startedOne, "the epoch must carry the time it turned over at");
        assertEq(lifetimeWins, 2, "both wins belong to the lifetime book");
        assertEq(alloy.holderOf(aid), buyer, "the new window is not attributed to the buyer");
        assertEq(alloy.ownerOf(aid), operator, "the credential moved: the soulbound claim would be gone");
        assertEq(alloy.tierOf(aid), 1, "one win in the buyer's window is Iron");
    }

    /// @dev The transition has to be indexable after the fact: the state it describes is gone, so
    /// the log is the only record of the window that closed.
    function test_HandoverEmitsAnIndexableEpochStarted() public {
        (uint256 aid, uint256 idId) = _registerAndLink();
        _settlePaid(aid);

        vm.prank(operator);
        identity.transferIdentity(idId, buyer);

        vm.recordLogs();
        vm.warp(block.timestamp + 1 hours);
        _settlePaid(aid);

        // Written out rather than derived, so a signature change in the event is a deliberate edit
        // here too. `abi-drift.test.ts` compares the same digest against the ABI's topic0.
        bool found;
        uint32 epochInLog;
        address newHolder;
        uint32 priorWins;
        uint32 priorSurvived;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(alloy) || logs[i].topics[0] != EPOCH_STARTED) continue;
            assertEq(uint256(logs[i].topics[1]), aid, "agentId must stay the indexed first topic");
            assertEq(address(uint160(uint256(logs[i].topics[2]))), operator, "the seller must be findable by topic");
            (epochInLog, newHolder, priorWins, priorSurvived,,) =
                abi.decode(logs[i].data, (uint32, address, uint32, uint32, uint32, uint64));
            found = true;
        }
        assertTrue(found, "the handover settled without an EpochStarted log to index");
        assertEq(epochInLog, 2);
        assertEq(newHolder, buyer);
        assertEq(priorWins, 1, "the log must carry the window it closed");
        assertEq(priorSurvived, 0);
    }

    // ── and the identity registry can never hold up a verdict ──

    function test_UnwiredRegistry_KeepsOneEpoch() public {
        vm.prank(trials.owner());
        trials.setIdentityRegistry(address(0));
        uint256 aid = _register(1 ether); // registered, and linking is permitted but unverifiable
        vm.prank(operator);
        trials.linkIdentity(aid, 7);

        _settlePaid(aid);
        _settlePaid(aid);

        (uint32 epoch,,,) = alloy.epochOf(aid);
        assertEq(epoch, 1, "an unwired deployment must not turn epochs");
        assertEq(alloy.holderOf(aid), operator);
    }

    function test_UnlinkedAgent_KeepsOneEpoch() public {
        uint256 aid = _register(1 ether); // registered, never linked to an identity
        _settlePaid(aid);
        _settlePaid(aid);
        (uint32 epoch,,,) = alloy.epochOf(aid);
        assertEq(epoch, 1, "an agent with no identity has nothing to hand over");
    }

    function test_RevertingRegistry_StillSettlesAndKeepsTheEpoch() public {
        (uint256 aid,) = _registerAndLink();
        _settlePaid(aid);

        vm.prank(trials.owner());
        trials.setIdentityRegistry(address(new RevertingIdentityRegistry()));

        vm.warp(block.timestamp + 1 hours);
        _settlePaid(aid); // asserts the verdict paid, which is the point of this test

        (uint32 epoch,,,) = alloy.epochOf(aid);
        assertEq(epoch, 1, "a registry that reverted was read as a handover");
    }

    function test_RegistryWithNoCode_FailsOpen() public {
        (uint256 aid,) = _registerAndLink();
        _settlePaid(aid);

        vm.prank(trials.owner());
        trials.setIdentityRegistry(makeAddr("miswired-address-with-no-code"));

        vm.warp(block.timestamp + 1 hours);
        _settlePaid(aid);

        (uint32 epoch,,,) = alloy.epochOf(aid);
        assertEq(epoch, 1, "an empty return was read as a handover");
    }

    function test_ZeroOwnerAnswer_DoesNotHandOverToNobody() public {
        (uint256 aid,) = _registerAndLink();
        _settlePaid(aid);

        vm.prank(trials.owner());
        trials.setIdentityRegistry(address(new NullIdentityRegistry()));

        vm.warp(block.timestamp + 1 hours);
        _settlePaid(aid);

        (uint32 epoch,,,) = alloy.epochOf(aid);
        assertEq(epoch, 1, "a registry answering zero must not start an epoch owned by address(0)");
        assertEq(alloy.holderOf(aid), operator);
    }

    /// @dev The slash the buyer did not earn must not follow them; the one they did earn must land in
    /// their own window.
    function test_SlashEarnedAfterHandoverStaysInTheBuyersWindow() public {
        (uint256 aid, uint256 idId) = _registerAndLink();
        _settlePaid(aid);
        vm.prank(operator);
        identity.transferIdentity(idId, buyer);
        _settlePaid(aid); // epoch 2 opens here

        _settleSlashed(aid);

        (uint32 epoch,, uint32 lifetimeWins, uint32 lifetimeSlashes) = alloy.epochOf(aid);
        (uint32 windowWins,, uint32 windowSlashes,,,,,,) = alloy.records(aid);
        assertEq(epoch, 2);
        assertEq(lifetimeWins, 2);
        assertEq(lifetimeSlashes, 1);
        assertEq(windowSlashes, 1, "the slash did not land in the epoch that earned it");
        assertEq(windowWins, 0, "the buyer's window must decay, not the seller's");
        assertEq(alloy.tierOf(aid), 0, "a slash in an empty window leaves the buyer at Unforged");
    }
}
