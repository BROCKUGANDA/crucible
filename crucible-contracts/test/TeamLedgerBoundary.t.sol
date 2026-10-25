// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TeamLedger} from "../contracts/TeamLedger.sol";

/// The boundary, not the mechanism.
///
/// `TeamLedger.t.sol` proves the ledger computes a split correctly. This file asks the questions that
/// only arise where it meets the rest of the system: what happens to money that arrives and never
/// leaves, what happens when two teams share one balance, whether a signature collected for one team
/// can be spent by another, and — the one that makes the rest worth reading — whether the ledger's
/// conservation equation is a claim that can be falsified or a tautology that restates itself.
contract TeamLedgerBoundaryTest is Test {
    TeamLedger internal ledger;

    uint256 internal constant LEAD_K = 0x1111;
    uint256 internal constant MID_K = 0x2222;
    uint256 internal constant OTHER_LEAD_K = 0x5555;

    address internal lead = vm.addr(LEAD_K);
    address internal mid = vm.addr(MID_K);
    address internal otherLead = vm.addr(OTHER_LEAD_K);

    bytes32 internal teamA = keccak256("team-a");
    bytes32 internal teamB = keccak256("team-b");
    uint256 internal deadline = type(uint256).max;

    bytes32 internal constant TEAM_TYPEHASH = keccak256("TeamMember(bytes32 teamKey,address member,uint256 shareBps,uint256 deadline)");
    bytes32 internal constant STAGE_TYPEHASH = keccak256("Stage(bytes32 teamKey,bytes32 stageHash,uint256 seq,address member,uint256 deadline)");

    function setUp() public {
        ledger = new TeamLedger();
    }

    function _sig(uint256 pk, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _teamSig(uint256 pk, bytes32 key, address member, uint256 share) internal returns (bytes memory) {
        return _sig(pk, keccak256(abi.encodePacked("\x19\x01", ledger.DOMAIN_SEPARATOR(), keccak256(abi.encode(TEAM_TYPEHASH, key, member, share, deadline)))));
    }

    function _formTwo() internal {
        address[] memory m = new address[](2);
        (m[0], m[1]) = (lead, mid);
        uint256[] memory s = new uint256[](2);
        (s[0], s[1]) = (6000, 4000);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _teamSig(LEAD_K, teamA, lead, 6000);
        sigs[1] = _teamSig(MID_K, teamA, mid, 4000);
        ledger.createTeam(teamA, m, s, deadline, sigs);
    }

    function _formOther() internal {
        address[] memory m = new address[](1);
        m[0] = otherLead;
        uint256[] memory s = new uint256[](1);
        s[0] = 10000;
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _teamSig(OTHER_LEAD_K, teamB, otherLead, 10000);
        ledger.createTeam(teamB, m, s, deadline, sigs);
    }

    // ── the invariant is falsifiable, which is what makes it a claim ─────────────────────────

    /// @dev A conservation check that only ever adds up its own books cannot fail, and a check that
    ///      cannot fail is not a guard. This injects ETH the way a passive transfer would have and
    ///      requires the equation to notice.
    function test_conservationNoticesEthItDidNotAccountFor() public {
        _formTwo();
        vm.deal(address(this), 1 ether);
        ledger.fund{value: 1 ether}(teamA);
        assertTrue(ledger.conservationHolds());

        // vm.deal SETS a balance rather than adding to it — measured, not assumed. Adding to the
        // balance the ledger already earned is the injection this test needs.
        uint256 before = address(ledger).balance;
        vm.deal(address(ledger), before + 1 ether);
        (uint256 bal, uint256 held, uint256 credits) = ledger.conservationDetail();
        assertFalse(ledger.conservationHolds(), "the ledger accepted unaccounted ETH and still said it balanced");
        assertEq(bal, held + credits + 1 ether, "the injection is not the size the assertion claims");
    }

    function test_conservationSurvivesDistribution() public {
        _formTwo();
        vm.deal(address(this), 1 ether);
        ledger.fund{value: 1 ether}(teamA);
        ledger.distribute(teamA);
        assertTrue(ledger.conservationHolds());

        vm.prank(mid);
        ledger.withdraw();
        assertTrue(ledger.conservationHolds());
        (uint256 bal,, uint256 credits) = ledger.conservationDetail();
        assertEq(bal, credits + ledger.heldTotal());
    }

    // ── money that arrives and never leaves ──────────────────────────────────────────────────

    function test_fundedButUndistributedEthIsWithdrawableByNobody() public {
        _formTwo();
        vm.deal(address(this), 1 ether);
        ledger.fund{value: 1 ether}(teamA);

        vm.prank(lead);
        vm.expectRevert(TeamLedger.NoCredit.selector);
        ledger.withdraw();

        vm.prank(mid);
        vm.expectRevert(TeamLedger.NoCredit.selector);
        ledger.withdraw();

        // It is not lost: it is held, named by team, and the equation still balances.
        assertEq(ledger.team(teamA).held, 1 ether);
        assertTrue(ledger.conservationHolds());
    }

    function test_aSecondFundingBeforeDistributionAccumulatesForTheSameSplit() public {
        _formTwo();
        vm.deal(address(this), 3 ether);
        ledger.fund{value: 1 ether}(teamA);
        ledger.fund{value: 2 ether}(teamA);
        assertEq(ledger.team(teamA).held, 3 ether);

        ledger.distribute(teamA);
        assertEq(ledger.credit(lead), 1.8 ether);
        assertEq(ledger.credit(mid), 1.2 ether);
        assertTrue(ledger.conservationHolds());
    }

    // ── two teams, one balance ───────────────────────────────────────────────────────────────

    function test_teamsAreIsolatedInOneSharedBalance() public {
        _formTwo();
        _formOther();
        vm.deal(address(this), 3 ether);
        ledger.fund{value: 2 ether}(teamA);
        ledger.fund{value: 1 ether}(teamB);
        assertEq(ledger.heldTotal(), 3 ether);

        // Distributing one team must not touch the other's held ETH or its members' credits.
        ledger.distribute(teamA);
        assertEq(ledger.team(teamA).held, 0);
        assertEq(ledger.team(teamB).held, 1 ether);
        assertEq(ledger.heldTotal(), 1 ether);
        assertEq(ledger.credit(otherLead), 0);
        assertTrue(ledger.conservationHolds());

        ledger.distribute(teamB);
        assertEq(ledger.credit(otherLead), 1 ether);
        assertEq(ledger.heldTotal(), 0);
        assertTrue(ledger.conservationHolds());
    }

    function test_distributingOneTeamCannotDrainAnother() public {
        _formTwo();
        _formOther();
        vm.deal(address(this), 2 ether);
        ledger.fund{value: 1 ether}(teamA);
        ledger.fund{value: 1 ether}(teamB);

        ledger.distribute(teamA);
        vm.prank(lead);
        ledger.withdraw();
        // The lead walked away with its own 0.6 ETH only; team B's ETH is still held.
        assertEq(lead.balance, 0.6 ether);
        assertEq(ledger.team(teamB).held, 1 ether);
        assertTrue(ledger.conservationHolds());
    }

    // ── cross-team replay: the digest names the team ──────────────────────────────────────────

    function test_aStageSignatureForOneTeamIsRejectedByAnother() public {
        _formTwo();
        _formOther();
        bytes32 stage = keccak256("shared-output");

        // mid signs an attestation for team A...
        bytes memory sig = _sig(MID_K, keccak256(abi.encodePacked("\x19\x01", ledger.DOMAIN_SEPARATOR(), keccak256(abi.encode(STAGE_TYPEHASH, teamA, stage, uint256(0), mid, deadline)))));

        // ...and someone presents it as team B's. teamKey is inside the digest, so this recovers a
        // different address than msg.sender and fails closed rather than crediting an attestation
        // to a team that never made it.
        // Measured, and better than the assertion I wrote first: teamKey is inside the digest, so
        // the replay recovers a different address and dies at BadSignature before membership is ever
        // consulted. Cross-team attestation is refused by the signature, not by a lookup.
        vm.prank(mid);
        vm.expectRevert(TeamLedger.BadSignature.selector);
        ledger.attestStage(teamB, stage, deadline, sig);
    }

    function test_stageSequenceIsPerTeamNotGlobal() public {
        _formTwo();
        _formOther();
        bytes32 stageA = keccak256("a-stage");
        bytes32 stageB = keccak256("b-stage");

        bytes memory sigA = _sig(MID_K, keccak256(abi.encodePacked("\x19\x01", ledger.DOMAIN_SEPARATOR(), keccak256(abi.encode(STAGE_TYPEHASH, teamA, stageA, uint256(0), mid, deadline)))));
        vm.prank(mid);
        ledger.attestStage(teamA, stageA, deadline, sigA);
        assertEq(ledger.team(teamA).stageCount, 1);
        assertEq(ledger.team(teamB).stageCount, 0);

        // Team B's first attestation must still be valid at seq 0 — a global counter would make one
        // team's activity silently invalidate another's signatures.
        bytes memory sigB = _sig(OTHER_LEAD_K, keccak256(abi.encodePacked("\x19\x01", ledger.DOMAIN_SEPARATOR(), keccak256(abi.encode(STAGE_TYPEHASH, teamB, stageB, uint256(0), otherLead, deadline)))));
        vm.prank(otherLead);
        ledger.attestStage(teamB, stageB, deadline, sigB);
        assertEq(ledger.team(teamB).stageCount, 1);
    }

    // ── the caller's side of the hand-off ────────────────────────────────────────────────────

    /// @dev The ledger never holds escrow money and the escrow never knows the ledger exists. The
    ///      only edge between them is an operator that took a pull-ledger payout and then chose to
    ///      fund a split. This is that step, and it is the step a demo script tends to skip.
    function test_operatorPayoutBecomesTeamFundingAndNeitherBookLies() public {
        _formTwo();
        address operator = lead;
        vm.deal(operator, 1 ether);

        // Operator withdraws from the escrow (simulated here as a balance the operator controls —
        // the escrow's own withdraw path is covered by CrucibleTrials.t.sol and ADR-0003).
        assertEq(operator.balance, 1 ether);

        vm.prank(operator);
        ledger.fund{value: 1 ether}(teamA);
        assertEq(operator.balance, 0);
        assertEq(ledger.team(teamA).held, 1 ether);
        assertTrue(ledger.conservationHolds());

        vm.startPrank(operator);
        ledger.distribute(teamA);
        ledger.withdraw();
        vm.stopPrank();

        assertEq(operator.balance, 0.6 ether);
        assertEq(ledger.credit(mid), 0.4 ether);
        assertTrue(ledger.conservationHolds());
    }

    function test_aMemberThatTriesToWithdrawTwiceGetsNothingTheSecondTime() public {
        _formTwo();
        vm.deal(address(this), 1 ether);
        ledger.fund{value: 1 ether}(teamA);
        ledger.distribute(teamA);

        vm.startPrank(mid);
        ledger.withdraw();
        vm.expectRevert(TeamLedger.NoCredit.selector);
        ledger.withdraw();
        vm.stopPrank();
        assertEq(mid.balance, 0.4 ether);
        assertTrue(ledger.conservationHolds());
    }
}
