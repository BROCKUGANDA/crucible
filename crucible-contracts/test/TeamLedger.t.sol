// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TeamLedger} from "../contracts/TeamLedger.sol";

/// Attribution, splits and conservation for multi-agent trials.
///
/// The three properties this file exists to make unfalsifiable:
///   1. a split cannot be asserted without the signature of every member it short-changes;
///   2. ETH never leaves the ledger except through `withdraw`, and never without a book entry;
///   3. the ledger's own conservation equation survives every path, including the ones that
///      truncate to zero for some members.
contract TeamLedgerTest is Test {
    TeamLedger internal ledger;

    uint256 internal constant LEAD_K = 0x1111;
    uint256 internal constant MID_K = 0x2222;
    uint256 internal constant TAIL_K = 0x3333;

    address internal lead = vm.addr(LEAD_K);
    address internal mid = vm.addr(MID_K);
    address internal tail = vm.addr(TAIL_K);

    bytes32 internal teamKey = keccak256("team-one");
    uint256 internal deadline = type(uint256).max;

    bytes32 internal constant TEAM_TYPEHASH = keccak256("TeamMember(bytes32 teamKey,address member,uint256 shareBps,uint256 deadline)");
    bytes32 internal constant STAGE_TYPEHASH = keccak256("Stage(bytes32 teamKey,bytes32 stageHash,uint256 seq,address member,uint256 deadline)");

    function setUp() public {
        ledger = new TeamLedger();
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", ledger.DOMAIN_SEPARATOR(), structHash));
    }

    function _teamSig(uint256 pk, bytes32 key, address member, uint256 share, uint256 dl) internal returns (bytes memory) {
        return _sig(pk, _digest(keccak256(abi.encode(TEAM_TYPEHASH, key, member, share, dl))));
    }

    function _stageSig(uint256 pk, bytes32 key, bytes32 stageHash, uint256 seq, address member, uint256 dl) internal returns (bytes memory) {
        return _sig(pk, _digest(keccak256(abi.encode(STAGE_TYPEHASH, key, stageHash, seq, member, dl))));
    }

    /// The repo's own signing idiom (`test/Arena.t.sol:143`): destructure, then pack r, s, v.
    function _sig(uint256 pk, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// The canonical team: 50 / 30 / 20, lead first.
    function _form() internal {
        address[] memory m = new address[](3);
        m[0] = lead;
        m[1] = mid;
        m[2] = tail;
        uint256[] memory s = new uint256[](3);
        s[0] = 5000;
        s[1] = 3000;
        s[2] = 2000;
        bytes[] memory sigs = new bytes[](3);
        sigs[0] = _teamSig(LEAD_K, teamKey, lead, 5000, deadline);
        sigs[1] = _teamSig(MID_K, teamKey, mid, 3000, deadline);
        sigs[2] = _teamSig(TAIL_K, teamKey, tail, 2000, deadline);
        ledger.createTeam(teamKey, m, s, deadline, sigs);
    }

    // ── formation: the attribution guarantee ─────────────────────────────────────────────────

    function test_formRecordsEveryShare() public {
        _form();
        assertEq(ledger.shareBpsOf(teamKey, lead), 5000);
        assertEq(ledger.shareBpsOf(teamKey, mid), 3000);
        assertEq(ledger.shareBpsOf(teamKey, tail), 2000);
        assertEq(ledger.members(teamKey).length, 3);
        assertTrue(ledger.isMember(teamKey, tail));
        assertEq(ledger.team(teamKey).lead, lead);
    }

    function test_cannotFormWithoutEveryMemberSignature() public {
        address[] memory m = new address[](3);
        (m[0], m[1], m[2]) = (lead, mid, tail);
        uint256[] memory s = new uint256[](3);
        (s[0], s[1], s[2]) = (5000, 3000, 2000);
        bytes[] memory sigs = new bytes[](3);
        sigs[0] = _teamSig(LEAD_K, teamKey, lead, 5000, deadline);
        sigs[1] = _teamSig(MID_K, teamKey, mid, 3000, deadline);
        // The third member never signed. A lead that could finish a 50/30/20 split with two
        // signatures would be able to take a third of someone's payout with their silence.
        sigs[2] = _teamSig(TAIL_K, teamKey, tail, 1000, deadline);

        vm.expectRevert(TeamLedger.BadSignature.selector);
        ledger.createTeam(teamKey, m, s, deadline, sigs);
    }

    function test_cannotStealAShareBySigningForSomeoneElse() public {
        address[] memory m = new address[](2);
        (m[0], m[1]) = (lead, mid);
        uint256[] memory s = new uint256[](2);
        (s[0], s[1]) = (5000, 5000);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _teamSig(LEAD_K, teamKey, lead, 5000, deadline);
        // mid's slot, signed by the lead's key.
        sigs[1] = _teamSig(LEAD_K, teamKey, mid, 5000, deadline);

        vm.expectRevert(TeamLedger.BadSignature.selector);
        ledger.createTeam(teamKey, m, s, deadline, sigs);
    }

    function test_rejectsMalleableSignature() public {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(LEAD_K, _digest(keccak256(abi.encode(TEAM_TYPEHASH, teamKey, lead, 5000, deadline))));
        bytes memory flip = abi.encodePacked(r, bytes32(uint256(s) ^ (1 << 255)), v);
        address[] memory m = new address[](1);
        m[0] = lead;
        uint256[] memory sh = new uint256[](1);
        sh[0] = 10000;
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = flip;
        // Either the high-s form is rejected outright or it recovers somebody else; it must never
        // recover the member whose agreement it did not carry.
        vm.expectRevert();
        ledger.createTeam(teamKey, m, sh, deadline, sigs);
    }

    function test_sharesMustSumToExactlyBps() public {
        address[] memory m = new address[](2);
        (m[0], m[1]) = (lead, mid);
        uint256[] memory s = new uint256[](2);
        (s[0], s[1]) = (5000, 4999); // 1 bps short: 0.01% of the payout would vanish
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _teamSig(LEAD_K, teamKey, lead, 5000, deadline);
        sigs[1] = _teamSig(MID_K, teamKey, mid, 4999, deadline);

        vm.expectRevert(TeamLedger.ShareMismatch.selector);
        ledger.createTeam(teamKey, m, s, deadline, sigs);
    }

    function test_rejectsZeroShare() public {
        address[] memory m = new address[](2);
        (m[0], m[1]) = (lead, mid);
        uint256[] memory s = new uint256[](2);
        (s[0], s[1]) = (10000, 0);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _teamSig(LEAD_K, teamKey, lead, 10000, deadline);
        sigs[1] = _teamSig(MID_K, teamKey, mid, 0, deadline);

        vm.expectRevert(TeamLedger.ShareMismatch.selector);
        ledger.createTeam(teamKey, m, s, deadline, sigs);
    }

    function test_rejectsDuplicateMember() public {
        address[] memory m = new address[](2);
        (m[0], m[1]) = (lead, lead);
        uint256[] memory s = new uint256[](2);
        (s[0], s[1]) = (5000, 5000);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _teamSig(LEAD_K, teamKey, lead, 5000, deadline);
        sigs[1] = _teamSig(LEAD_K, teamKey, lead, 5000, deadline);

        vm.expectRevert(TeamLedger.DuplicateMember.selector);
        ledger.createTeam(teamKey, m, s, deadline, sigs);
    }

    function test_rejectsZeroAddressMember() public {
        address[] memory m = new address[](2);
        (m[0], m[1]) = (lead, address(0));
        uint256[] memory s = new uint256[](2);
        (s[0], s[1]) = (5000, 5000);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _teamSig(LEAD_K, teamKey, lead, 5000, deadline);
        sigs[1] = hex"00";

        vm.expectRevert(TeamLedger.ZeroAddress.selector);
        ledger.createTeam(teamKey, m, s, deadline, sigs);
    }

    function test_rejectsEmptyTeam() public {
        address[] memory m = new address[](0);
        uint256[] memory s = new uint256[](0);
        bytes[] memory sigs = new bytes[](0);
        vm.expectRevert(TeamLedger.EmptyTeam.selector);
        ledger.createTeam(teamKey, m, s, deadline, sigs);
    }

    function test_rejectsOversizedTeam() public {
        uint256 n = ledger.MAX_MEMBERS() + 1;
        address[] memory m = new address[](n);
        uint256[] memory s = new uint256[](n);
        bytes[] memory sigs = new bytes[](n);
        vm.expectRevert(TeamLedger.TooManyMembers.selector);
        ledger.createTeam(teamKey, m, s, deadline, sigs);
    }

    function test_rejectsSignatureCountMismatch() public {
        address[] memory m = new address[](2);
        (m[0], m[1]) = (lead, mid);
        uint256[] memory s = new uint256[](2);
        (s[0], s[1]) = (5000, 5000);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _teamSig(LEAD_K, teamKey, lead, 5000, deadline);

        vm.expectRevert(TeamLedger.BadSignature.selector);
        ledger.createTeam(teamKey, m, s, deadline, sigs);
    }

    function test_rejectsExpiredDeadline() public {
        uint256 dl = block.timestamp + 10;
        address[] memory m = new address[](1);
        m[0] = lead;
        uint256[] memory s = new uint256[](1);
        s[0] = 10000;
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _teamSig(LEAD_K, teamKey, lead, 10000, dl);

        vm.warp(dl + 1);
        vm.expectRevert(TeamLedger.DeadlinePassed.selector);
        ledger.createTeam(teamKey, m, s, dl, sigs);
    }

    function test_cannotReFormUnderAUsedKey() public {
        _form();
        address[] memory m = new address[](1);
        m[0] = lead;
        uint256[] memory s = new uint256[](1);
        s[0] = 10000;
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _teamSig(LEAD_K, teamKey, lead, 10000, deadline);

        vm.expectRevert(TeamLedger.TeamExists.selector);
        ledger.createTeam(teamKey, m, s, deadline, sigs);
    }

    // ── stage attestation ────────────────────────────────────────────────────────────────────

    function test_memberAttestsItsStage() public {
        _form();
        bytes32 stage = keccak256("stage-1-output");
        bytes memory sig = _stageSig(MID_K, teamKey, stage, 0, mid, deadline);
        vm.prank(mid);
        ledger.attestStage(teamKey, stage, deadline, sig);
        assertTrue(ledger.stageAttested(teamKey, stage));
        assertEq(ledger.team(teamKey).stageCount, 1);
    }

    function test_outsiderCannotAttest() public {
        _form();
        bytes32 stage = keccak256("stage-1-output");
        uint256 strangerKey = 0x4444;
        address stranger = vm.addr(strangerKey);
        // The stranger signs their own digest, so recovery succeeds and yields msg.sender — the only
        // thing left to fail on is membership. A test that let recovery fail first would pass
        // against a contract with no membership check at all.
        bytes memory sig = _stageSig(strangerKey, teamKey, stage, 0, stranger, deadline);
        vm.prank(stranger);
        vm.expectRevert(TeamLedger.NotMember.selector);
        ledger.attestStage(teamKey, stage, deadline, sig);
    }

    function test_cannotAttestOnATeamThatDoesNotExist() public {
        bytes32 other = keccak256("no-such-team");
        bytes32 stage = keccak256("s");
        bytes memory sig = _stageSig(MID_K, other, stage, 0, mid, deadline);
        vm.prank(mid);
        vm.expectRevert(TeamLedger.NoTeam.selector);
        ledger.attestStage(other, stage, deadline, sig);
    }

    // ── money: the split, and where the remainder goes ───────────────────────────────────────

    function test_distributeSplitsExactly() public {
        _form();
        vm.deal(address(this), 1 ether);
        ledger.fund{value: 1 ether}(teamKey);
        ledger.distribute(teamKey);

        assertEq(ledger.credit(lead), 0.5 ether);
        assertEq(ledger.credit(mid), 0.3 ether);
        assertEq(ledger.credit(tail), 0.2 ether);
        assertEq(ledger.heldTotal(), 0);
        assertEq(ledger.totalCredit(), 1 ether);
        assertTrue(ledger.conservationHolds());
    }

    function test_remainderGoesToTheLeadAndNothingIsLost() public {
        _form();
        // 7 wei across 50/30/20 truncates to 3/2/1 — one wei short. It must land somewhere visible.
        vm.deal(address(this), 7);
        ledger.fund{value: 7}(teamKey);
        ledger.distribute(teamKey);

        assertEq(ledger.credit(lead), 4); // 3 + the 1 wei remainder
        assertEq(ledger.credit(mid), 2);
        assertEq(ledger.credit(tail), 1);
        assertEq(ledger.credit(lead) + ledger.credit(mid) + ledger.credit(tail), 7);
        assertTrue(ledger.conservationHolds());
    }

    function test_oneWeiSplitPaysOnlyTheLead() public {
        _form();
        vm.deal(address(this), 1);
        ledger.fund{value: 1}(teamKey);
        ledger.distribute(teamKey);

        assertEq(ledger.credit(lead), 1);
        assertEq(ledger.credit(mid), 0);
        assertEq(ledger.credit(tail), 0);
        assertTrue(ledger.conservationHolds());
    }

    function test_withdrawIsPullAndClears() public {
        _form();
        vm.deal(address(this), 1 ether);
        ledger.fund{value: 1 ether}(teamKey);
        ledger.distribute(teamKey);

        uint256 before = mid.balance;
        vm.prank(mid);
        ledger.withdraw();
        assertEq(mid.balance, before + 0.3 ether);
        assertEq(ledger.credit(mid), 0);
        assertEq(ledger.totalCredit(), 0.7 ether);
        assertTrue(ledger.conservationHolds());

        vm.prank(mid);
        vm.expectRevert(TeamLedger.NoCredit.selector);
        ledger.withdraw();
    }

    function test_distributeIsIdempotentByFlagNotByBalance() public {
        _form();
        vm.deal(address(this), 1 ether);
        ledger.fund{value: 1 ether}(teamKey);
        ledger.distribute(teamKey);

        // A second call must fail even though `held` is now zero — the guard is the flag. Without
        // it, a re-funded team could be split twice against the same membership.
        vm.expectRevert(TeamLedger.Distributed.selector);
        ledger.distribute(teamKey);
    }

    function test_cannotFundAfterDistribution() public {
        _form();
        vm.deal(address(this), 2 ether);
        ledger.fund{value: 1 ether}(teamKey);
        ledger.distribute(teamKey);

        vm.expectRevert(TeamLedger.Distributed.selector);
        ledger.fund{value: 1}(teamKey);
    }

    function test_distributeWithNothingFundedReverts() public {
        _form();
        vm.expectRevert(TeamLedger.NothingToSplit.selector);
        ledger.distribute(teamKey);
    }

    function test_zeroFundReverts() public {
        _form();
        vm.expectRevert(TeamLedger.NothingToSplit.selector);
        ledger.fund{value: 0}(teamKey);
    }

    function test_cannotFundAnUnknownTeam() public {
        vm.expectRevert(TeamLedger.NoTeam.selector);
        ledger.fund{value: 1}(keccak256("nobody"));
    }

    // ── conservation, and the shape that makes it hold ───────────────────────────────────────

    function test_hasNoReceiveAndTakesNoPassiveEth() public {
        // Funded first: without a balance the low-level call fails for want of ETH and the assertion
        // would pass against a contract that does have a receive().
        vm.deal(address(this), 1);
        (bool ok,) = address(ledger).call{value: 1}("");
        assertFalse(ok, "the ledger accepted a passive transfer; its conservation equation is now a guess");
        assertEq(address(ledger).balance, 0);
    }

    function test_conservationSurvivesEveryPath() public {
        _form();
        assertTrue(ledger.conservationHolds());

        vm.deal(address(this), 3 ether);
        ledger.fund{value: 2 ether}(teamKey);
        assertTrue(ledger.conservationHolds());

        ledger.distribute(teamKey);
        assertTrue(ledger.conservationHolds());

        vm.prank(tail);
        ledger.withdraw();
        assertTrue(ledger.conservationHolds());

        (uint256 bal, uint256 held, uint256 credits) = ledger.conservationDetail();
        assertEq(bal, held + credits);
        assertEq(bal, address(ledger).balance);
    }

    function test_domainSeparatorBindsTheContractAndChain() public {
        TeamLedger other = new TeamLedger();
        assertTrue(ledger.DOMAIN_SEPARATOR() != other.DOMAIN_SEPARATOR());

        bytes32 mine = ledger.DOMAIN_SEPARATOR();
        vm.chainId(31338);
        TeamLedger forked = new TeamLedger();
        assertTrue(forked.DOMAIN_SEPARATOR() != mine, "the domain ignored chainid: a signature is replayable across forks");
    }

    function test_sigFromAnotherLedgerIsRejected() public {
        TeamLedger other = new TeamLedger();
        address[] memory m = new address[](1);
        m[0] = lead;
        uint256[] memory s = new uint256[](1);
        s[0] = 10000;
        bytes memory sig = _teamSigAt(other, LEAD_K, teamKey, lead, 10000, deadline);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = sig;

        // Signed for a different verifying contract, presented to this one.
        vm.expectRevert(TeamLedger.BadSignature.selector);
        ledger.createTeam(teamKey, m, s, deadline, sigs);
    }

    function _teamSigAt(TeamLedger at, uint256 pk, bytes32 key, address member, uint256 share, uint256 dl) internal returns (bytes memory) {
        bytes32 dom = at.DOMAIN_SEPARATOR();
        return _sig(pk, keccak256(abi.encodePacked("\x19\x01", dom, keccak256(abi.encode(TEAM_TYPEHASH, key, member, share, dl)))));
    }
}
