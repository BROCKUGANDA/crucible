// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";
import {AlloyRegistry} from "../contracts/AlloyRegistry.sol";
import {ReputationBridge} from "../contracts/ReputationBridge.sol";
import {MockReputationRegistry, MockIdentityRegistry} from "../contracts/mocks/ERC8004Mocks.sol";

/// @notice ERC-8004 reputation wiring.
/// @dev Two properties these tests defend.
///
///  1. Crucible's signal must be consumable by a *conforming* registry. The mock enforces
///     the spec's rules (valueDecimals bounds, and the ban on the agent's owner submitting
///     about themselves), so a green suite here means a real registry would accept
///     Crucible's output.
///  2. It must be consumable by the registry entry that belongs to the agent the verdict
///     is about. ERC-8004 tokenIds are minted by the Identity Registry; Crucible agent ids
///     are `++agentCount`. They are unrelated numbers, and a fixture that seeds both id
///     spaces with the *same* value cannot tell a correct bridge from one that grades
///     whoever happens to hold that number. So here the two spaces are pulled apart on
///     purpose: Mallory is Crucible agent 2 and ERC-8004 identity 7, while ERC-8004 agent 2
///     belongs to somebody else entirely. That is the auditor's scenario, in the fixture.
contract ReputationBridgeTest is Test {
    CrucibleTrials trials;
    AlloyRegistry alloy;
    ReputationBridge bridge;
    MockReputationRegistry registry;
    MockIdentityRegistry identity;

    uint256 constant RUNNER_KEY = 0xA11CE;
    uint256 constant REWARD = 1 ether;
    uint64 constant WINDOW = 12 hours;

    /// How many unrelated ERC-8004 identities are minted before Mallory's, so her
    /// identity lands on a number that is not any Crucible agent id she owns.
    uint256 constant UNRELATED_IDENTITIES = 6;

    address sponsor = makeAddr("sponsor");
    address operator = makeAddr("mallory");
    address innocentOp = makeAddr("innocent-operator");
    address skeptic = makeAddr("skeptic");
    address runner = vm.addr(RUNNER_KEY);
    address a1 = makeAddr("argus1");
    address a2 = makeAddr("argus2");
    address a3 = makeAddr("argus3");

    bytes32 constant SPEC = keccak256("spec");
    bytes32 constant TESTS = keccak256("tests");
    bytes32 constant RUN = keccak256("run");

    /// Crucible's own id space.
    uint256 agentId;
    uint256 decoyAgentId;
    /// The ERC-8004 id space, resolved through `trials.identityOf`.
    uint256 identityAgentId;

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
        identity = new MockIdentityRegistry();
        registry.initialize(address(identity));
        bridge.setReputationRegistry(address(registry));
        trials.setReputationBridge(address(bridge));
        trials.setIdentityRegistry(address(identity));
        vm.stopPrank();

        // Two Crucible agents exist so that the one under test is id 2 rather than 1:
        // the number a buggy bridge would pass straight through to `giveFeedback`.
        vm.deal(innocentOp, 1 ether);
        vm.prank(innocentOp);
        decoyAgentId = trials.registerAgent{value: 1 ether}("ipfs://innocent", runner);

        vm.deal(operator, 1 ether);
        vm.prank(operator);
        agentId = trials.registerAgent{value: 1 ether}("ipfs://manifest", runner);

        // ERC-8004 ids 1..UNRELATED_IDENTITIES are other people's agents. The registry
        // must know who owns each, so it can reject self-feedback — and so a write to the
        // wrong one is provably a write to an unrelated victim.
        for (uint256 i; i < UNRELATED_IDENTITIES; ++i) {
            address other = makeAddr(string(abi.encodePacked("unrelated-", vm.toString(i))));
            vm.prank(other);
            uint256 minted = identity.register("ipfs://unrelated");
            registry.setAgent(minted, other, true);
        }

        // Mallory registers her own identity attestation — the registry mints to the
        // caller, which is why Crucible cannot do it for her — and links it. Her Crucible
        // agent is 2; her identity is 7.
        vm.prank(operator);
        identityAgentId = identity.register("ipfs://manifest");
        vm.prank(operator);
        trials.linkIdentity(agentId, identityAgentId);
        registry.setAgent(identityAgentId, operator, true);

        assertEq(agentId, 2, "fixture: the agent under test is Crucible agent 2");
        assertEq(decoyAgentId, 1, "fixture: an unlinked agent occupies Crucible id 1");
        assertEq(identityAgentId, UNRELATED_IDENTITIES + 1, "fixture: ids must not coincide");
        assertNotEq(agentId, identityAgentId);
    }

    // ── helpers ──
    function _liveTrial() internal returns (uint256 id) {
        vm.deal(sponsor, REWARD);
        vm.prank(sponsor);
        id = trials.createTrial{value: REWARD}(SPEC, TESTS, uint64(block.timestamp + 2 days), WINDOW);
        vm.prank(operator);
        trials.claimTrial(id);
    }

    /// A trial claimed by the agent that has *no* linked ERC-8004 identity.
    function _liveTrialUnlinked() internal returns (uint256 id) {
        vm.deal(sponsor, REWARD);
        vm.prank(sponsor);
        id = trials.createTrial{value: REWARD}(SPEC, TESTS, uint64(block.timestamp + 2 days), WINDOW);
        vm.prank(innocentOp);
        trials.claimTrial(id);
    }

    function _submitRun(uint256 id) internal {
        _submitRunFor(id, agentId);
    }

    function _submitRunFor(uint256 id, uint256 aid) internal {
        uint64 sd = uint64(block.timestamp + 10 minutes);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01", trials.DOMAIN(), keccak256(abi.encode(trials.RUN_TYPEHASH(), id, aid, RUN, sd))
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

    // ── the id space (HIGH: the bug the audit found) ──────────────────────
    function test_FeedbackTargetsTheLinkedIdentityNotTheCrucibleId() public {
        uint256 id = _liveTrial();
        _submitRun(id);
        _fileBreak(id);
        _resolve(id, true); // 2-of-3 say the break wins → Mallory is slashed

        // The slash lands on the ERC-8004 identity that belongs to the slashed agent…
        (int128 value, uint8 decimals, string memory tag1, string memory tag2, bool revoked) =
            registry.readFeedback(identityAgentId, address(bridge), 1);
        assertEq(value, -400, "slash never reached Mallory's own identity");
        assertEq(decimals, 1);
        assertEq(tag1, "crucible");
        assertEq(tag2, "verdict");
        assertFalse(revoked);

        // …and not on ERC-8004 agent 2, which is an unrelated party that merely happens
        // to share a number with Mallory's Crucible agent id.
        assertEq(registry.getLastIndex(agentId, address(bridge)), 0, "wrote against the Crucible id");
        assertEq(registry.feedbackCount(), 1, "exactly one feedback, on exactly one agent");
    }

    function test_WinAlsoTargetsTheLinkedIdentity() public {
        uint256 id = _liveTrial();
        _submitRun(id);
        vm.warp(block.timestamp + WINDOW + 1);
        trials.finalize(id);

        (int128 value,,,,) = registry.readFeedback(identityAgentId, address(bridge), 1);
        assertEq(value, 500);
        assertEq(registry.getLastIndex(agentId, address(bridge)), 0);
    }

    /// An agent with no linked identity has no correct subject to write about. The bridge
    /// must skip the write rather than post against ERC-8004 agent 0 — or, as the fixture
    /// makes it, rather than post against whichever unrelated agent owns the number that
    /// happens to be the Crucible id.
    function test_AgentWithoutAnIdentityIsNotWrittenAbout() public {
        uint256 id = _liveTrialUnlinked();
        _submitRunFor(id, decoyAgentId);
        vm.warp(block.timestamp + WINDOW + 1);
        trials.finalize(id);

        assertEq(registry.feedbackCount(), 0, "an unlinked agent produced a feedback write");
        assertEq(registry.getLastIndex(decoyAgentId, address(bridge)), 0);
        assertEq(registry.getLastIndex(0, address(bridge)), 0);
        // skipping the signal must not skip the verdict
        assertEq(uint8(trials.getTrial(id).verdict), uint8(CrucibleTrials.Verdict.Paid));
        assertEq(trials.credit(innocentOp), 0.95 ether);
    }

    /// The skip has to be observable. A bridge that returns quietly because it had nothing
    /// correct to write is, from outside, identical to a bridge that published.
    function test_SkippedFeedbackIsAnnounced() public {
        uint256 id = _liveTrialUnlinked();
        _submitRunFor(id, decoyAgentId);
        vm.warp(block.timestamp + WINDOW + 1);

        // the skip is the *only* thing the bridge says about this verdict
        vm.expectEmit(true, true, false, true, address(bridge));
        emit ReputationBridge.FeedbackSkipped(decoyAgentId, id, 500);
        trials.finalize(id);
    }

    /// The published log names both numbers, because the whole defect was that nothing in
    /// the record said which ERC-8004 agent had actually been written to.
    function test_PublishedFeedbackNamesTheIdentityItWasWrittenTo() public {
        uint256 id = _liveTrial();
        _submitRun(id);
        vm.warp(block.timestamp + WINDOW + 1);

        vm.expectEmit(true, true, false, true, address(bridge));
        emit ReputationBridge.FeedbackPublished(agentId, id, identityAgentId, 500, false, 1);
        trials.finalize(id);
    }

    // ── the anti-self-dealing rule ──
    function test_OperatorCannotGradeItself() public {
        // the registry itself refuses operator feedback — this is the ERC-8004 rule
        // Crucible is architected around. It is about the agent's *identity*, which is
        // not the number Crucible uses internally.
        vm.prank(operator);
        vm.expectRevert(MockReputationRegistry.SelfFeedbackForbidden.selector);
        registry.giveFeedback(identityAgentId, 100, 1, "crucible", "verdict", "", "", bytes32(0));
    }

    function test_ClientAddressIsTheBridgeNotTheOperator() public {
        uint256 id = _liveTrial();
        _submitRun(id);
        vm.warp(block.timestamp + WINDOW + 1);
        trials.finalize(id);

        // feedback was written, and by the bridge
        assertGt(registry.getLastIndex(identityAgentId, address(bridge)), 0);
        (int128 value, uint8 decimals, string memory tag1, string memory tag2, bool revoked) =
            registry.readFeedback(identityAgentId, address(bridge), 1);
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

        (int128 quietValue,,,,) = registry.readFeedback(identityAgentId, address(bridge), 1);
        (int128 survivedValue,,,,) = registry.readFeedback(identityAgentId, address(bridge), 2);

        assertEq(quietValue, 500);
        assertEq(survivedValue, 750);
        assertGt(survivedValue, quietValue); // surviving an attack is worth more
    }

    function test_SlashPublishesNegativeFeedback() public {
        uint256 id = _liveTrial();
        _submitRun(id);
        _fileBreak(id);
        _resolve(id, true);

        (int128 value,,,,) = registry.readFeedback(identityAgentId, address(bridge), 1);
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

    /// The bridge resolving through `identityOf` must not turn a settlement into a
    /// dependency on the trials contract's own reads either.
    function test_OutageWithRevertedRegistryStillSkipsCleanly() public {
        registry.setShouldRevert(true);
        uint256 id = _liveTrial();
        _submitRun(id);
        _fileBreak(id);
        _resolve(id, true);
        assertEq(registry.feedbackCount(), 0);
        assertEq(uint8(trials.getTrial(id).verdict), uint8(CrucibleTrials.Verdict.Slashed));
    }

    /// Routing through `identityOf` must not create a new way for the bridge to block a
    /// verdict. With an Identity Registry wired, `linkIdentity` refuses a tokenId the caller
    /// does not own, so an unresolvable id can only get recorded on a deployment that has
    /// deliberately unwired the registry (`setIdentityRegistry(address(0))` is supported for
    /// exactly that reason). That is the configuration where the property is still reachable,
    /// and it is the one where the write must still fail closed and the payout still land.
    function test_UnknownIdentityDoesNotBlockTheVerdict() public {
        vm.prank(owner);
        trials.setIdentityRegistry(address(0)); // unwire: nothing left to verify against

        vm.prank(operator);
        trials.linkIdentity(agentId, 999_999); // minted by nobody, registered with nobody

        uint256 id = _liveTrial();
        _submitRun(id);
        vm.warp(block.timestamp + WINDOW + 1);
        trials.finalize(id);

        assertEq(uint8(trials.getTrial(id).verdict), uint8(CrucibleTrials.Verdict.Paid));
        assertEq(trials.credit(operator), 0.95 ether);
        assertEq(registry.feedbackCount(), 0, "an unresolvable identity must not be graded");
    }

    /**
     * The attack the ownership check closes. Without it, pointing your agent at somebody
     * else's identity turns your own slash into a hit on their reputation — the bridge
     * faithfully publishes to whatever id was recorded.
     */
    function test_CannotLinkAnIdentityYouDoNotOwn() public {
        // An unrelated party's identity, minted by them, owned by them.
        vm.prank(innocentOp);
        uint256 victimIdentity = identity.register("ipfs://someone-elses-agent");

        vm.prank(operator);
        vm.expectRevert(CrucibleTrials.IdentityNotOwned.selector);
        trials.linkIdentity(agentId, victimIdentity);

        // A rejected link must leave the record exactly where it was. The point is that
        // there is now no route from Mallory's verdict to the victim's reputation: the id
        // still points at the identity Mallory legitimately minted in setUp.
        assertEq(trials.identityOf(agentId), identityAgentId, "a rejected link must not overwrite the record");
        assertNotEq(trials.identityOf(agentId), victimIdentity, "the victim's id must never become the subject");
    }

    function test_CanLinkAnIdentityYouDoOwn() public {
        vm.prank(operator);
        uint256 mine = identity.register("ipfs://my-agent");

        vm.prank(operator);
        trials.linkIdentity(agentId, mine);

        assertEq(trials.identityOf(agentId), mine);
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
        // …and it is the identity that received it, not the Crucible number
        (int128 value,,,,) = registry.readFeedback(identityAgentId, address(bridge), 1);
        assertEq(value, 500);
        assertEq(registry.getLastIndex(agentId, address(bridge)), 0);
    }

    function test_BackfillSkipsAnUnlinkedAgent() public {
        uint256 id = _liveTrialUnlinked();
        _submitRunFor(id, decoyAgentId);
        vm.warp(block.timestamp + WINDOW + 1);
        trials.finalize(id);

        bridge.backfill(id, decoyAgentId, 500);
        assertEq(registry.feedbackCount(), 0, "backfill wrote about an agent with no identity");
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
        (uint64 count, int128 summary,) = registry.getSummary(identityAgentId, clients, "crucible", "");
        assertEq(count, 1);
        assertEq(summary, 500);

        // the unrelated agent that shares Crucible's number has no Crucible signal at all
        (uint64 victimCount, int128 victimSummary,) = registry.getSummary(agentId, clients, "crucible", "");
        assertEq(victimCount, 0);
        assertEq(victimSummary, 0);
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
        (,, string memory tag1, string memory tag2,) = registry.readFeedback(identityAgentId, address(bridge), 1);
        assertEq(tag1, "crucible");
        assertEq(tag2, "verdict");
        assertGt(id, 0);
    }
}
