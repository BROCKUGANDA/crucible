// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";
import {AlloyRegistry} from "../contracts/AlloyRegistry.sol";
import {ReputationBridge} from "../contracts/ReputationBridge.sol";
import {MockReputationRegistry} from "../contracts/mocks/ERC8004Mocks.sol";

/// @notice ERC-8004 reputation wiring.
/// @dev The point these tests defend: Crucible's reputation signal must be usable by
/// a *conforming* registry. The mock enforces the spec's rules (valueDecimals bounds,
/// and the ban on the agent's owner submitting about themselves), so a green suite
/// here means a real registry would accept Crucible's output.
contract ReputationBridgeTest is Test {
    CrucibleTrials trials;
    AlloyRegistry alloy;
    ReputationBridge bridge;
    MockReputationRegistry registry;

    uint256 constant RUNNER_KEY = 0xA11CE;
    uint256 constant REWARD = 1 ether;
    uint64 constant WINDOW = 12 hours;

    address sponsor = makeAddr("sponsor");
    address operator = makeAddr("operator");
    address skeptic = makeAddr("skeptic");
    address runner = vm.addr(RUNNER_KEY);
    address a1 = makeAddr("argus1");
    address a2 = makeAddr("argus2");
    address a3 = makeAddr("argus3");

    bytes32 constant SPEC = keccak256("spec");
    bytes32 constant TESTS = keccak256("tests");
    bytes32 constant RUN = keccak256("run");

    uint256 agentId;
    address owner = makeAddr("deployer");

    function setUp() public {
        vm.startPrank(owner);
        alloy = new AlloyRegistry();
        address[] memory seats = new address[](3);
        seats[0] = a1;
        seats[1] = a2;
        seats[2] = a3;
        trials = new CrucibleTrials(makeAddr("treasury"), address(alloy), seats);
        alloy.setForge(address(trials));
        bridge = new ReputationBridge(address(trials));
        registry = new MockReputationRegistry();
        registry.initialize(address(0x1234));
        bridge.setReputationRegistry(address(registry));
        trials.setReputationBridge(address(bridge));
        vm.stopPrank();

        // the registry must know who owns the agent, so it can reject self-feedback
        vm.deal(operator, 1 ether);
        vm.prank(operator);
        agentId = trials.registerAgent{value: 1 ether}("ipfs://manifest", runner);
        registry.setAgent(agentId, operator, true);
    }

    // ── helpers ──
    function _liveTrial() internal returns (uint256 id) {
        vm.deal(sponsor, REWARD);
        vm.prank(sponsor);
        id = trials.createTrial{value: REWARD}(SPEC, TESTS, uint64(block.timestamp + 2 days), WINDOW);
        vm.prank(operator);
        trials.claimTrial(id);
    }

    function _submitRun(uint256 id) internal {
        uint64 sd = uint64(block.timestamp + 10 minutes);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01", trials.DOMAIN(), keccak256(abi.encode(trials.RUN_TYPEHASH(), id, agentId, RUN, sd))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, digest);
        vm.prank(makeAddr("relayer"));
        trials.submitRun(id, RUN, abi.encodePacked(r, s, v), sd);
    }

    function _fileBreak(uint256 id) internal {
        vm.deal(skeptic, 1 ether);
        vm.prank(skeptic);
        trials.fileBreak{value: 0.01 ether}(id, keccak256("proof"));
    }

    function _resolve(uint256 id, bool breakWins) internal {
        bytes32 salt = keccak256("salt");
        vm.prank(a1);
        trials.commitVote(id, keccak256(abi.encodePacked(id, breakWins, salt)));
        vm.prank(a2);
        trials.commitVote(id, keccak256(abi.encodePacked(id, breakWins, salt)));
        vm.prank(a1);
        trials.revealVote(id, breakWins, salt);
        vm.prank(a2);
        trials.revealVote(id, breakWins, salt);
    }

    // ── the anti-self-dealing rule ──
    function test_OperatorCannotGradeItself() public {
        // the registry itself refuses operator feedback — this is the ERC-8004 rule
        // Crucible is architected around
        vm.prank(operator);
        vm.expectRevert(MockReputationRegistry.SelfFeedbackForbidden.selector);
        registry.giveFeedback(agentId, 100, 1, "crucible", "verdict", "", "", bytes32(0));
    }

    function test_ClientAddressIsTheBridgeNotTheOperator() public {
        uint256 id = _liveTrial();
        _submitRun(id);
        vm.warp(block.timestamp + WINDOW + 1);
        trials.finalize(id);

        // feedback was written, and by the bridge
        assertGt(registry.getLastIndex(agentId, address(bridge)), 0);
        (int128 value, uint8 decimals, string memory tag1, string memory tag2, bool revoked) =
            registry.readFeedback(agentId, address(bridge), 1);
        assertEq(value, 500); // quiet win
        assertEq(decimals, bridge.VALUE_DECIMALS());
        assertEq(decimals, 1);
        assertEq(tag1, "crucible");
        assertEq(tag2, "verdict");
        assertFalse(revoked);
    }

    // ── value encoding ──
    function test_QuietWinScoresLowerThanSurvivedBreak() public {
        uint256 quiet = _liveTrial();
        _submitRun(quiet);
        vm.warp(block.timestamp + WINDOW + 1);
        trials.finalize(quiet);

        uint256 survived = _liveTrial();
        _submitRun(survived);
        _fileBreak(survived);
        _resolve(survived, false);

        (int128 quietValue,,,,) = registry.readFeedback(agentId, address(bridge), 1);
        (int128 survivedValue,,,,) = registry.readFeedback(agentId, address(bridge), 2);

        assertEq(quietValue, 500);
        assertEq(survivedValue, 750);
        assertGt(survivedValue, quietValue); // surviving an attack is worth more
    }

    function test_SlashPublishesNegativeFeedback() public {
        uint256 id = _liveTrial();
        _submitRun(id);
        _fileBreak(id);
        _resolve(id, true);

        (int128 value,,,,) = registry.readFeedback(agentId, address(bridge), 1);
        assertEq(value, -400);
    }

    // ── availability ──
    function test_RegistryOutageDoesNotBlockTheVerdict() public {
        registry.setShouldRevert(true);
        uint256 id = _liveTrial();
        _submitRun(id);
        vm.warp(block.timestamp + WINDOW + 1);

        // the payout still lands: a third-party registry must never block settlement
        trials.finalize(id);
        assertEq(trials.credit(operator), 0.95 ether);
        assertEq(uint8(trials.getTrial(id).verdict), uint8(CrucibleTrials.Verdict.Paid));
    }

    function test_RegistryOutageDoesNotBlockASlash() public {
        uint256 id = _liveTrial();
        _submitRun(id);
        _fileBreak(id);
        registry.setShouldRevert(true);
        _resolve(id, true);
        assertEq(uint8(trials.getTrial(id).verdict), uint8(CrucibleTrials.Verdict.Slashed));
        assertEq(trials.credit(sponsor), REWARD);
    }

    function test_UnwiredBridgeSettlesNormally() public {
        vm.prank(owner);
        trials.setReputationBridge(address(0));
        uint256 id = _liveTrial();
        _submitRun(id);
        vm.warp(block.timestamp + WINDOW + 1);
        trials.finalize(id);
        assertEq(trials.credit(operator), 0.95 ether);
        assertEq(registry.feedbackCount(), 0);
    }

    // ── authorization ──
    function test_OnlyTrialsMayPublish() public {
        vm.expectRevert(ReputationBridge.UnauthorizedReporter.selector);
        bridge.reportWin(1, agentId, false);
    }

    function test_OperatorCannotPublish() public {
        vm.prank(operator);
        vm.expectRevert(ReputationBridge.UnauthorizedReporter.selector);
        bridge.reportSlash(1, agentId);
    }

    function test_OnlyOwnerMaySetRegistry() public {
        vm.prank(operator);
        vm.expectRevert(ReputationBridge.NotRegistryOwner.selector);
        bridge.setReputationRegistry(address(registry));
    }

    function test_OnlyOwnerMayWireTheBridgeIntoTrials() public {
        vm.prank(operator);
        vm.expectRevert(CrucibleTrials.NotOwner.selector);
        trials.setReputationBridge(address(bridge));
    }

    // ── backfill ──
    function test_BackfillRecordsMissingFeedback() public {
        registry.setShouldRevert(true);
        uint256 id = _liveTrial();
        _submitRun(id);
        vm.warp(block.timestamp + WINDOW + 1);
        trials.finalize(id);
        assertEq(registry.feedbackCount(), 0);

        registry.setShouldRevert(false);
        bridge.backfill(id, agentId, 500);
        assertEq(registry.feedbackCount(), 1);
    }

    function test_BackfillRejectsOutOfRangeValue() public {
        vm.expectRevert(ReputationBridge.ValueOutOfRange.selector);
        bridge.backfill(1, agentId, 5000);
    }

    function test_BackfillRejectsZeroValue() public {
        vm.expectRevert(ReputationBridge.ValueOutOfRange.selector);
        bridge.backfill(1, agentId, 0);
    }

    function test_BackfillRevertsWithNoRegistry() public {
        vm.prank(owner);
        bridge.setReputationRegistry(address(0));
        vm.expectRevert(ReputationBridge.NoReputationRegistry.selector);
        bridge.backfill(1, agentId, 500);
    }

    // ── consumability ──
    function test_SummaryAggregatesCrucibleFeedbackByTag() public {
        uint256 id = _liveTrial();
        _submitRun(id);
        vm.warp(block.timestamp + WINDOW + 1);
        trials.finalize(id);

        address[] memory clients = new address[](1);
        clients[0] = address(bridge);
        (uint64 count, int128 summary,) = registry.getSummary(agentId, clients, "crucible", "");
        assertEq(count, 1);
        assertEq(summary, 500);
    }

    function test_ConstructionRejectsZeroTrials() public {
        vm.expectRevert(ReputationBridge.NotTrials.selector);
        new ReputationBridge(address(0));
    }

    function test_FeedbackURIReferencesTheTrial() public {
        uint256 id = _liveTrial();
        _submitRun(id);
        vm.warp(block.timestamp + WINDOW + 1);
        trials.finalize(id);
        // the URI is crucible://trials/<id>, so an aggregator can deep-link the verdict
        (,, string memory tag1, string memory tag2,) = registry.readFeedback(agentId, address(bridge), 1);
        assertEq(tag1, "crucible");
        assertEq(tag2, "verdict");
        assertGt(id, 0);
    }
}
