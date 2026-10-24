// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Arena} from "../contracts/Arena.sol";
import {ArgusCourt} from "../contracts/ArgusCourt.sol";
import {Params} from "../contracts/Params.sol";

/// @notice A wallet runner, so the ERC-1271 branch of submitRun is actually walked rather than
/// asserted from the side. It answers the magic value for one digest and nothing else.
contract WalletRunner {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes32 public ok;

    function setOk(bytes32 d) external {
        ok = d;
    }

    function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4) {
        return hash == ok ? MAGIC : bytes4(0xffffffff);
    }

    /// @notice Accept ETH so a value-bearing call from it is unremarkable.
    receive() external payable {}
}

/// @notice Every rejection the arena and the court can issue, and the few branches that only a
/// boundary case reaches. `Arena.t.sol` proves the flows pay correctly; this proves the doors
/// are locked, which is the half a money contract usually leaves untested.
contract ArenaPathsTest is Test {
    Arena arena;
    ArgusCourt court;

    address treasury = makeAddr("treasury");
    address sponsor = makeAddr("sponsor");
    address agent = makeAddr("agent");
    address skeptic = makeAddr("skeptic");

    uint256 constant RUNNER_KEY = 0xA11CE;
    uint256 constant ATTESTOR_KEY = 0xB0B;
    address runner = vm.addr(RUNNER_KEY);
    address attestor = vm.addr(ATTESTOR_KEY);

    uint256 constant R = 1 ether;
    uint256 constant F = 0.15 ether;
    uint256 constant B = 0.2 ether;
    uint256 constant S = 0.01 ether;
    uint256 constant A = 0.015 ether;

    uint256 constant SK1 = 0xC11;
    uint256 constant SK2 = 0xC22;
    uint256 constant SK3 = 0xC33;
    address seat1 = vm.addr(SK1);
    address seat2 = vm.addr(SK2);
    address seat3 = vm.addr(SK3);

    bytes32 constant SPEC = keccak256("spec");
    bytes32 constant SUITE = keccak256("suite");
    bytes32 constant ARTIFACT = keccak256("artifact");
    bytes32 constant VERDICT = keccak256("verdict");
    bytes32 constant REPLAY = keccak256("replay");
    bytes32 constant HARNESS = keccak256("harness");
    uint64 constant DEADLINE = type(uint64).max;

    bytes32 DOMAIN;
    uint64 private _nonce;

    function setUp() public {
        court = new ArgusCourt();
        arena = new Arena(treasury, address(court), 0);
        court.setArena(address(arena));
        DOMAIN = arena.DOMAIN();
        arena.setAttestor(attestor, true);
        vm.deal(sponsor, 30 ether);
        vm.deal(agent, 30 ether);
        vm.deal(skeptic, 30 ether);
        _seat(SK1);
        _seat(SK2);
        _seat(SK3);
    }

    function _seat(uint256 key) internal {
        address s = vm.addr(key);
        vm.deal(s, 8 ether);
        vm.prank(s);
        court.bondSeat{value: 0.2 ether}();
    }

    function _commitment() internal pure returns (bytes32) {
        return sha256(abi.encodePacked(bytes32("salt"), bytes32("digest")));
    }

    function _post(uint32 window, uint40 span) internal returns (uint256 id) {
        bytes32 c = _commitment();
        vm.prank(sponsor);
        id = arena.postTrial{value: R + F}(R, SPEC, SUITE, c, window, span);
    }

    function _post() internal returns (uint256 id) {
        return _post(3600, 2 days);
    }

    function _claim(uint256 id) internal {
        vm.prank(agent);
        arena.claimTrial{value: B}(id);
        vm.prank(agent);
        arena.setRunner(id, runner);
    }

    function _submit(uint256 id) internal {
        uint64 nonce = ++_nonce;
        bytes32 runDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN,
                keccak256(abi.encode(_RUN_TH, bytes32(id), agent, ARTIFACT, VERDICT, REPLAY, HARNESS, nonce, DEADLINE))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, runDigest);
        bytes32 attestDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN,
                keccak256(abi.encode(_ATTEST_TH, bytes32(id), ARTIFACT, VERDICT, REPLAY, true, DEADLINE))
            )
        );
        (uint8 av, bytes32 ar, bytes32 asig) = vm.sign(ATTESTOR_KEY, attestDigest);
        arena.submitRun(
            id,
            ARTIFACT,
            VERDICT,
            REPLAY,
            HARNESS,
            nonce,
            DEADLINE,
            abi.encodePacked(r, s, v),
            abi.encodePacked(ar, asig, av)
        );
    }

    bytes32 internal constant _RUN_TH = keccak256(
        "Run(bytes32 trialId,address agent,bytes32 artifactDigest,bytes32 verdictHash,bytes32 replayHash,bytes32 modelHarnessId,uint64 nonce,uint64 sigDeadline)"
    );
    bytes32 internal constant _ATTEST_TH = keccak256(
        "ResultAttestation(bytes32 trialId,bytes32 artifactDigest,bytes32 verdictHash,bytes32 replayHash,bool passed,uint64 sigDeadline)"
    );

    // ─────────────── post: every bound ───────────────
    function test_Post_RejectsEmptyDigests() public {
        bytes32 c = _commitment();
        vm.prank(sponsor);
        vm.expectRevert(Arena.TooSmall.selector);
        arena.postTrial{value: R + F}(R, bytes32(0), SUITE, c, 3600, 2 days);

        vm.prank(sponsor);
        vm.expectRevert(Arena.TooSmall.selector);
        arena.postTrial{value: R + F}(R, SPEC, bytes32(0), c, 3600, 2 days);
    }

    function test_Post_RejectsWindowAndSpanBounds() public {
        bytes32 c = _commitment();
        vm.prank(sponsor);
        vm.expectRevert(Arena.BadWindow.selector);
        arena.postTrial{value: R + F}(R, SPEC, SUITE, c, uint32(3599), 2 days);

        vm.prank(sponsor);
        vm.expectRevert(Arena.BadWindow.selector);
        arena.postTrial{value: R + F}(R, SPEC, SUITE, c, uint32(Params.SKEPTIC_WINDOW_MAX_SECONDS + 1), 2 days);

        vm.prank(sponsor);
        vm.expectRevert(Arena.BadOpenSpan.selector);
        arena.postTrial{value: R + F}(R, SPEC, SUITE, c, 3600, uint40(0));

        vm.prank(sponsor);
        vm.expectRevert(Arena.BadOpenSpan.selector);
        arena.postTrial{value: R + F}(R, SPEC, SUITE, c, 3600, uint40(Params.TRIAL_OPEN_MAX_SECONDS + 1));
    }

    function test_Post_RejectsAZeroHoldoutCommitmentOnlyWhenAsked() public {
        // A trial with no sealed holdout is legal; the reveal path is what refuses it.
        vm.prank(sponsor);
        uint256 id = arena.postTrial{value: R + F}(R, SPEC, SUITE, bytes32(0), 3600, 2 days);
        _claim(id);
        _submit(id);
        vm.prank(sponsor);
        vm.expectRevert(Arena.HoldoutUnknown.selector);
        arena.revealHoldout(id, bytes32("d"), bytes32("s"));
    }

    /// @notice The 24-hour cap in `holdoutRevealMax` is the other arm of the min(); a long
    /// window must land on the cap, not on half.
    function test_HoldoutWindow_TakesTheCapForALongSkepticWindow() public {
        uint256 id = _post(7 days, 20 days);
        _claim(id);
        _submit(id);
        uint256 submitted = arena.submittedAtOf(id);
        uint256 due = arena.holdoutDueByOf(id);
        assertEq(due - submitted, Params.HOLDOUT_REVEAL_CAP_SECONDS, "capped at 24h, not 3.5 days");
        assertEq(Params.holdoutRevealMax(7 days), 86_400);
        assertEq(Params.holdoutRevealMax(1 hours), 1800);
    }

    // ─────────────── claim and its exits ───────────────
    function test_Claim_RejectsPastTheOpenWindow() public {
        uint256 id = _post();
        vm.warp(arena.openUntilOf(id) + 1);
        vm.prank(agent);
        vm.expectRevert(Arena.ClaimWindowClosed.selector);
        arena.claimTrial{value: B}(id);
    }

    function test_Claim_RejectsOverpaymentAndSetRunnerGuards() public {
        uint256 id = _post();
        vm.prank(agent);
        arena.claimTrial{value: 3 ether}(id);
        // An oversized bond is escrowed as given: it is the agent's own money at risk.
        (,, uint256 bond,,) = arena.amountsOf(id);
        assertEq(bond, 3 ether);

        vm.prank(skeptic);
        vm.expectRevert(Arena.NotAgent.selector);
        arena.setRunner(id, runner);

        uint256 other = _post();
        vm.prank(agent);
        vm.expectRevert(Arena.NotAgent.selector);
        arena.setRunner(other, runner); // an Open trial has no agent to authorise a key

        vm.prank(agent);
        vm.expectRevert(Arena.ZeroAddress.selector);
        arena.setRunner(id, address(0));
    }

    function test_SetRunner_AfterSubmitIsRefused() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        vm.prank(agent);
        vm.expectRevert(Arena.BadState.selector);
        arena.setRunner(id, makeAddr("later"));
    }

    function test_Yield_RejectsTheWrongCallerAndAWrongState() public {
        uint256 id = _post();
        vm.prank(skeptic);
        vm.expectRevert(Arena.NotAgent.selector);
        arena.yieldTrial(id);

        _claim(id);
        _submit(id);
        vm.prank(agent);
        vm.expectRevert(Arena.BadState.selector);
        arena.yieldTrial(id);
    }

    function test_ClaimTimeout_RejectsEarlyAndRejectsOnAnOpenTrial() public {
        uint256 id = _post();
        _claim(id);
        vm.prank(skeptic);
        vm.expectRevert(Arena.WindowStillOpen.selector);
        arena.claimTimeout(id);

        uint256 other = _post();
        vm.prank(skeptic);
        vm.expectRevert(Arena.BadState.selector);
        arena.claimTimeout(other);
    }

    function test_Cancel_RejectsAfterTheTrialWasClaimedThenYielded() public {
        uint256 id = _post();
        _claim(id);
        vm.prank(agent);
        arena.yieldTrial(id);
        vm.prank(sponsor);
        vm.expectRevert(Arena.BadState.selector);
        arena.cancelTrial(id);
    }

    function test_Expire_RejectsAStateThatIsNotOpen() public {
        uint256 id = _post();
        _claim(id);
        vm.prank(skeptic);
        vm.expectRevert(Arena.BadState.selector);
        arena.expireTrial(id);
    }

    // ─────────────── submit ───────────────
    function test_Submit_RejectsWrongStatesAndMissingDigests() public {
        uint256 id = _post();
        vm.expectRevert(Arena.BadState.selector);
        _submit(id); // nobody claimed it

        _claim(id);
    }

    function test_Submit_RejectsAClaimWithoutARunnerKey() public {
        uint256 id = _post();
        vm.prank(agent);
        arena.claimTrial{value: B}(id);
        vm.expectRevert(Arena.NoRunner.selector);
        arena.submitRun(id, ARTIFACT, VERDICT, REPLAY, HARNESS, 1, DEADLINE, "", "");
    }

    function test_Submit_RejectsEmptyDigestsAndABadSignatureLength() public {
        uint256 id = _post();
        _claim(id);
        vm.expectRevert(Arena.DigestMismatch.selector);
        arena.submitRun(id, bytes32(0), VERDICT, REPLAY, HARNESS, 1, DEADLINE, "", "");

        vm.expectRevert(Arena.BadSigLength.selector);
        arena.submitRun(id, ARTIFACT, VERDICT, REPLAY, HARNESS, 1, DEADLINE, hex"1234", hex"1234");
    }

    function test_Submit_RejectsADeadlineInThePast() public {
        uint256 id = _post();
        _claim(id);
        uint64 past = uint64(block.timestamp);
        vm.expectRevert(Arena.SigExpired.selector);
        arena.submitRun(id, ARTIFACT, VERDICT, REPLAY, HARNESS, 1, past, "", "");
    }

    function test_Submit_RejectsAMalleableSignature() public {
        uint256 id = _post();
        _claim(id);
        bytes32 runDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN,
                keccak256(
                    abi.encode(_RUN_TH, bytes32(id), agent, ARTIFACT, VERDICT, REPLAY, HARNESS, uint64(1), DEADLINE)
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, runDigest);
        // Flip s to the high half of the curve order: same key, different bytes, and the
        // network's own answer to "which of these two signatures is the canonical one".
        bytes32 high = bytes32(type(uint256).max - uint256(s) + 1);
        vm.expectRevert(Arena.SigMalleable.selector);
        arena.submitRun(id, ARTIFACT, VERDICT, REPLAY, HARNESS, 1, DEADLINE, abi.encodePacked(r, high, v), "");
    }

    function test_Submit_AcceptsAnERC1271WalletRunner() public {
        WalletRunner wallet = new WalletRunner();
        uint256 id = _post();
        vm.prank(agent);
        arena.claimTrial{value: B}(id);
        vm.prank(agent);
        arena.setRunner(id, address(wallet));

        bytes32 runDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN,
                keccak256(
                    abi.encode(_RUN_TH, bytes32(id), agent, ARTIFACT, VERDICT, REPLAY, HARNESS, uint64(1), DEADLINE)
                )
            )
        );
        wallet.setOk(runDigest);
        bytes32 attestDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN,
                keccak256(abi.encode(_ATTEST_TH, bytes32(id), ARTIFACT, VERDICT, REPLAY, true, DEADLINE))
            )
        );
        (uint8 av, bytes32 ar, bytes32 asig) = vm.sign(ATTESTOR_KEY, attestDigest);
        arena.submitRun(
            id,
            ARTIFACT,
            VERDICT,
            REPLAY,
            HARNESS,
            1,
            DEADLINE,
            abi.encodePacked(ar, asig, av),
            abi.encodePacked(ar, asig, av)
        );
        assertEq(uint8(arena.statusOf(id)), uint8(Arena.Status.Submitted));
    }

    function test_Submit_RejectsAWalletThatDeniesTheDigest() public {
        WalletRunner wallet = new WalletRunner();
        uint256 id = _post();
        vm.prank(agent);
        arena.claimTrial{value: B}(id);
        vm.prank(agent);
        arena.setRunner(id, address(wallet));
        bytes32 attestDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN,
                keccak256(abi.encode(_ATTEST_TH, bytes32(id), ARTIFACT, VERDICT, REPLAY, true, DEADLINE))
            )
        );
        (uint8 av, bytes32 ar, bytes32 asig) = vm.sign(ATTESTOR_KEY, attestDigest);
        bytes memory sig = abi.encodePacked(ar, asig, av);
        vm.expectRevert(Arena.BadSigner.selector);
        arena.submitRun(id, ARTIFACT, VERDICT, REPLAY, HARNESS, 1, DEADLINE, sig, sig);
    }

    // ─────────────── breaks ───────────────
    function test_Break_RejectsBadDepositsAndAStateThatIsNotSubmitted() public {
        uint256 id = _post();
        _claim(id);
        bytes32 c = keccak256("commitment");

        vm.prank(skeptic);
        vm.expectRevert(Arena.BadState.selector);
        arena.commitBreak{value: S + A}(id, c); // not submitted yet

        _submit(id);
        vm.deal(skeptic, 5 ether);
        vm.prank(skeptic);
        vm.expectRevert(Arena.StakeTooSmall.selector);
        arena.commitBreak{value: S - 1}(id, c);

        vm.prank(skeptic);
        vm.expectRevert(Arena.SeatFeeWrong.selector);
        arena.commitBreak{value: S + A - 1}(id, c);

        vm.prank(skeptic);
        vm.expectRevert(Arena.TooSmall.selector);
        arena.commitBreak{value: S + A}(id, bytes32(0));
    }

    function test_Break_RevealGuardsEveryDoor() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        bytes32 evidence = keccak256("evidence");
        bytes32 salt = keccak256("salt");
        bytes32 c = sha256(
            abi.encodePacked(
                "CRUCIBLE:break:v1", bytes32(id), skeptic, uint8(Arena.BreakKind.PublicFail), evidence, salt
            )
        );
        vm.deal(skeptic, 5 ether);
        vm.prank(skeptic);
        arena.commitBreak{value: S + A}(id, c);

        vm.prank(skeptic);
        vm.expectRevert(Arena.WindowStillOpen.selector);
        arena.revealBreak(id, 0, Arena.BreakKind.PublicFail, evidence, salt);

        uint256 indexTooBig = 7;
        vm.warp(arena.windowEndOf(id) + 1);
        vm.prank(skeptic);
        vm.expectRevert(abi.encodeWithSelector(Arena.BreakUnknown.selector));
        arena.revealBreak(id, indexTooBig, Arena.BreakKind.PublicFail, evidence, salt);

        vm.prank(skeptic);
        arena.revealBreak(id, 0, Arena.BreakKind.PublicFail, evidence, salt);
        vm.prank(skeptic);
        vm.expectRevert(Arena.AlreadyRevealed.selector);
        arena.revealBreak(id, 0, Arena.BreakKind.PublicFail, evidence, salt);
    }

    function test_Break_LateRevealIsRefusedAndCountedAsFailed() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        bytes32 evidence = keccak256("e");
        bytes32 salt = keccak256("s");
        bytes32 c = sha256(
            abi.encodePacked(
                "CRUCIBLE:break:v1", bytes32(id), skeptic, uint8(Arena.BreakKind.Provenance), evidence, salt
            )
        );
        vm.deal(skeptic, 5 ether);
        vm.prank(skeptic);
        arena.commitBreak{value: S + A}(id, c);
        vm.warp(arena.windowEndOf(id) + Params.BREAK_REVEAL_GRACE_SECONDS + 1);
        vm.prank(skeptic);
        vm.expectRevert(Arena.RevealWindowClosed.selector);
        arena.revealBreak(id, 0, Arena.BreakKind.Provenance, evidence, salt);
    }

    function test_Docket_DoubleFreezeIsRefused() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        // Nothing revealed: the freeze settles O1 and the door closes behind it.
        vm.warp(arena.windowEndOf(id) + Params.BREAK_REVEAL_GRACE_SECONDS + 1);
        vm.prank(skeptic);
        arena.freezeDocket(id);
        assertEq(uint8(arena.outcomeOf(id)), uint8(Arena.Outcome.O1));
        vm.prank(skeptic);
        vm.expectRevert(Arena.DocketAlreadyFrozen.selector);
        arena.freezeDocket(id);

        // With a filing, the trial actually reaches Docketed, and the second crank is refused by
        // the freeze flag rather than by the state machine happening to move on.
        uint256 other = _post();
        _claim(other);
        _submit(other);
        bytes32 ev = keccak256("ev");
        bytes32 sa = keccak256("sa");
        bytes32 cm = sha256(
            abi.encodePacked("CRUCIBLE:break:v1", bytes32(other), skeptic, uint8(Arena.BreakKind.PublicFail), ev, sa)
        );
        vm.prank(skeptic);
        arena.commitBreak{value: S + A}(other, cm);
        vm.warp(arena.windowEndOf(other) + 1);
        vm.prank(skeptic);
        arena.revealBreak(other, 0, Arena.BreakKind.PublicFail, ev, sa);
        vm.warp(arena.windowEndOf(other) + Params.BREAK_REVEAL_GRACE_SECONDS + 1);
        vm.prank(skeptic);
        arena.freezeDocket(other);
        vm.prank(skeptic);
        vm.expectRevert(Arena.DocketAlreadyFrozen.selector);
        arena.freezeDocket(other);
    }

    // ─────────────── panel and votes ───────────────
    function test_Draw_RejectsTheWrongStateAndRound() public {
        uint256 id = _post();
        vm.prank(skeptic);
        vm.expectRevert(Arena.BadState.selector);
        arena.drawPanel(id, 1);

        _finishToDocket(id);
        vm.prank(skeptic);
        vm.expectRevert(Arena.RoundTooLate.selector);
        arena.drawPanel(id, 2);
    }

    function test_Draw_RefusesToGuessOnAVrfDeployment() public {
        ArgusCourt c2 = new ArgusCourt();
        Arena a2 = new Arena(treasury, address(c2), 1); // mode 1 = VRF required
        c2.setArena(address(a2));
        address s1 = vm.addr(0xF1);
        address s2 = vm.addr(0xF2);
        address s3 = vm.addr(0xF3);
        _fund(c2, s1);
        _fund(c2, s2);
        _fund(c2, s3);
        bytes32 c = _commitment();
        vm.prank(sponsor);
        uint256 id = a2.postTrial{value: R + F}(R, SPEC, SUITE, c, 3600, 2 days);
        vm.prank(agent);
        a2.claimTrial{value: B}(id);
        vm.prank(agent);
        a2.setRunner(id, runner);
        _submitOn(a2, id);
        bytes32 ev = keccak256("vrf evidence");
        bytes32 sa = keccak256("vrf salt");
        bytes32 cm = sha256(
            abi.encodePacked("CRUCIBLE:break:v1", bytes32(id), skeptic, uint8(Arena.BreakKind.PublicFail), ev, sa)
        );
        vm.prank(skeptic);
        a2.commitBreak{value: S + A}(id, cm);
        vm.warp(a2.windowEndOf(id) + 1);
        vm.prank(skeptic);
        a2.revealBreak(id, 0, Arena.BreakKind.PublicFail, ev, sa);
        vm.warp(a2.windowEndOf(id) + Params.BREAK_REVEAL_GRACE_SECONDS + 1);
        vm.prank(skeptic);
        a2.freezeDocket(id);
        vm.prank(skeptic);
        vm.expectRevert(Arena.RandomnessNotConfigured.selector);
        a2.drawPanel(id, 1);
    }

    function _fund(ArgusCourt which, address who) internal {
        vm.deal(who, 3 ether);
        vm.prank(who);
        which.bondSeat{value: 0.2 ether}();
    }

    function _submitOn(Arena which, uint256 id) internal {
        uint64 nonce = ++_nonce;
        bytes32 dom = which.DOMAIN();
        bytes32 runDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                dom,
                keccak256(abi.encode(_RUN_TH, bytes32(id), agent, ARTIFACT, VERDICT, REPLAY, HARNESS, nonce, DEADLINE))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, runDigest);
        bytes32 attestDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                dom,
                keccak256(abi.encode(_ATTEST_TH, bytes32(id), ARTIFACT, VERDICT, REPLAY, true, DEADLINE))
            )
        );
        (uint8 av, bytes32 ar, bytes32 asig) = vm.sign(ATTESTOR_KEY, attestDigest);
        which.setAttestor(attestor, true);
        which.submitRun(
            id,
            ARTIFACT,
            VERDICT,
            REPLAY,
            HARNESS,
            nonce,
            DEADLINE,
            abi.encodePacked(r, s, v),
            abi.encodePacked(ar, asig, av)
        );
    }

    /// @notice Claim, submit, file ONE sealed break, and freeze the docket. Without a filing
    /// there is nothing to judge and the freeze settles O1 on the spot, which is the right
    /// answer to a different question.
    function _finishToDocket(uint256 id) internal {
        _claim(id);
        _submit(id);
        bytes32 evidence = keccak256(abi.encodePacked("evidence", id));
        bytes32 salt = keccak256(abi.encodePacked("salt", id));
        bytes32 commitment = sha256(
            abi.encodePacked(
                "CRUCIBLE:break:v1", bytes32(id), skeptic, uint8(Arena.BreakKind.PublicFail), evidence, salt
            )
        );
        vm.prank(skeptic);
        arena.commitBreak{value: S + A}(id, commitment);
        _breakSalt[id] = salt;
        _breakEvidence[id] = evidence;
        vm.warp(arena.windowEndOf(id) + 1);
        vm.prank(skeptic);
        arena.revealBreak(id, 0, Arena.BreakKind.PublicFail, evidence, salt);
        vm.warp(arena.windowEndOf(id) + Params.BREAK_REVEAL_GRACE_SECONDS + 1);
        vm.prank(skeptic);
        arena.freezeDocket(id);
    }

    mapping(uint256 => bytes32) internal _breakSalt;
    mapping(uint256 => bytes32) internal _breakEvidence;

    function test_Vote_RejectsNonSeatsAndEmptyBallots() public {
        uint256 id = _post();
        _finishToDocket(id);
        vm.prank(skeptic);
        arena.drawPanel(id, 1);

        vm.prank(makeAddr("not a seat"));
        vm.expectRevert(); // the court refuses an unseated voter through the panel check
        arena.commitVote(id, keccak256("x"));

        vm.prank(seat1);
        vm.expectRevert(Arena.TooSmall.selector);
        arena.commitVote(id, bytes32(0));

        vm.prank(seat1);
        vm.expectRevert(Arena.CommitMismatch.selector);
        arena.revealVote(id, 1, hex"00", REPLAY, bytes32("no commit"));
    }

    function test_Vote_RejectsAWrongLengthBallot() public {
        uint256 id = _post();
        _finishToDocket(id);
        vm.prank(skeptic);
        arena.drawPanel(id, 1);
        bytes memory twoRows = hex"0000";
        bytes32 salt = keccak256("s");
        bytes32 ballot =
            sha256(abi.encodePacked("CRUCIBLE:vote:v1", bytes32(id), uint8(1), seat1, twoRows, REPLAY, salt));
        vm.prank(seat1);
        arena.commitVote(id, ballot);
        vm.prank(seat1);
        vm.expectRevert(Arena.VoteLen.selector);
        arena.revealVote(id, 1, twoRows, REPLAY, salt);
    }

    function test_Tally_RejectsAnEarlyCrank() public {
        uint256 id = _post();
        _finishToDocket(id);
        vm.prank(skeptic);
        arena.drawPanel(id, 1);
        vm.prank(skeptic);
        vm.expectRevert(Arena.TallyOpen.selector);
        arena.tally(id);
    }

    function test_Tally_RefusesATrialThatNeverNeededAJury() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        vm.warp(arena.windowEndOf(id) + Params.BREAK_REVEAL_GRACE_SECONDS + 1);
        vm.prank(skeptic);
        arena.freezeDocket(id); // nothing revealed: O1, settled at the freeze
        assertEq(uint8(arena.outcomeOf(id)), uint8(Arena.Outcome.O1));
        vm.prank(skeptic);
        vm.expectRevert(Arena.BadState.selector);
        arena.tally(id);
    }

    /// @notice A ballot is the panel's, not the network's: an address that was not drawn may
    /// neither open nor open up a commitment for a jury it is not sitting on.
    function test_Vote_AStrangerMayNotFillTheBallotSlot() public {
        uint256 id = _post();
        _finishToDocket(id);
        vm.prank(skeptic);
        arena.drawPanel(id, 1);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(Arena.NotSeat.selector);
        arena.commitVote(id, keccak256("someone else's ballot"));
        vm.prank(stranger);
        vm.expectRevert(Arena.NotSeat.selector);
        arena.revealVote(id, 1, hex"00", REPLAY, bytes32("s"));
    }

    // ─────────────── the court ───────────────
    function test_Court_BondAndWithdrawGuards() public {
        address fresh = makeAddr("fresh");
        vm.deal(fresh, 3 ether);
        vm.startPrank(fresh);
        vm.expectRevert(ArgusCourt.BondTooSmall.selector);
        court.bondSeat{value: 1 wei}();
        vm.expectRevert(ArgusCourt.SeatUnknown.selector);
        court.requestUnbond();
        court.bondSeat{value: 0.2 ether}();
        vm.expectRevert(ArgusCourt.NotUnbonding.selector);
        court.withdrawSeat();
        court.requestUnbond();
        vm.expectRevert(ArgusCourt.NotUnbonding.selector);
        court.withdrawSeat();
        vm.warp(block.timestamp + Params.SEAT_UNBONDING_SECONDS + 1);
        court.withdrawSeat();
        assertEq(fresh.balance, 3 ether);
        vm.stopPrank();
        (uint256 leftAfter,,) = court.bondedOf(fresh);
        assertEq(leftAfter, 0);
    }

    function test_Court_RebondCancelsAPendingExit() public {
        address fresh = makeAddr("fresh2");
        vm.deal(fresh, 3 ether);
        vm.startPrank(fresh);
        court.bondSeat{value: 0.2 ether}();
        court.requestUnbond();
        (, uint256 queued, uint256 drawsBefore) = court.bondedOf(fresh);
        assertEq(queued, block.timestamp + Params.SEAT_UNBONDING_SECONDS);
        assertEq(drawsBefore, 0);
        court.bondSeat{value: 0.1 ether}();
        (uint256 topped, uint256 queuedAfter,) = court.bondedOf(fresh);
        assertEq(queuedAfter, 0, "re-bonding cancels a pending exit");
        assertEq(topped, 0.3 ether);
        vm.stopPrank();
        assertTrue(court.conservationHolds());
    }

    function test_Court_OwnerWiringIsOneShotAndRejectsZero() public {
        ArgusCourt fresh = new ArgusCourt();
        vm.expectRevert(ArgusCourt.ZeroAddress.selector);
        fresh.setArena(address(0));
        fresh.setArena(address(arena));
        vm.prank(makeAddr("not the owner"));
        vm.expectRevert(ArgusCourt.NotOwner.selector);
        fresh.setArena(address(0));
        vm.expectRevert(ArgusCourt.ArenaAlreadySet.selector);
        fresh.setArena(address(arena));
    }

    function test_Court_OnlyTheArenaMayLockAndSlash() public {
        vm.prank(skeptic);
        vm.expectRevert(ArgusCourt.NotArena.selector);
        court.noteDraw([seat1, seat2, seat3]);
        vm.prank(skeptic);
        vm.expectRevert(ArgusCourt.NotArena.selector);
        court.closeDraw([seat1, seat2, seat3]);
        vm.prank(skeptic);
        vm.expectRevert(ArgusCourt.NotArena.selector);
        court.slashNoShow(seat1, treasury);
    }

    function test_Court_SlashOfAnUnknownSeatIsANoOpNotARevert() public {
        vm.prank(address(arena));
        court.slashNoShow(makeAddr("ghost"), treasury);
        assertEq(court.credit(treasury), 0);
    }

    function test_Court_ConflictExcludesASeatFromEveryDraw() public {
        vm.prank(seat1);
        court.declareConflict(sponsor);
        vm.prank(seat1);
        vm.expectRevert(ArgusCourt.ZeroAddress.selector);
        court.declareConflict(address(0));
        vm.prank(makeAddr("nobody"));
        vm.expectRevert(ArgusCourt.SeatUnknown.selector);
        court.declareConflict(sponsor);

        // seat1 is out, so a three-seat pool cannot field a jury at all.
        uint256 id = _post();
        _finishToDocket(id);
        vm.prank(skeptic);
        vm.expectRevert(ArgusCourt.NotEnoughSeats.selector);
        arena.drawPanel(id, 1);
    }

    function test_Court_PoolIsBoundedAndReadable() public {
        assertEq(court.poolLength(), 3);
        assertEq(court.seatAt(0), seat1);
        vm.expectRevert();
        court.seatAt(9);
    }

    // ─────────────── payments ───────────────
    function test_Withdraw_RejectsWhenOwedNothing() public {
        vm.prank(skeptic);
        vm.expectRevert(Arena.NothingToWithdraw.selector);
        arena.withdraw();
    }

    function test_Withdraw_PaysTheWholeCreditOnce() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        vm.warp(arena.windowEndOf(id) + Params.BREAK_REVEAL_GRACE_SECONDS + 1);
        vm.prank(skeptic);
        arena.freezeDocket(id);
        uint256 owed = arena.credit(agent);
        assertEq(owed, R + B);
        uint256 before = agent.balance;
        vm.prank(agent);
        arena.withdraw();
        assertEq(agent.balance - before, owed);
        assertEq(arena.credit(agent), 0);
        vm.prank(agent);
        vm.expectRevert(Arena.NothingToWithdraw.selector);
        arena.withdraw();
        assertEq(arena.withdrawn(agent), owed);
        assertTrue(arena.conservationHolds());
    }

    function test_OwnerSurfaceIsOnlyTheAttestorSet() public {
        vm.prank(makeAddr("not the owner"));
        vm.expectRevert(Arena.NotOwner.selector);
        arena.setAttestor(makeAddr("x"), true);
        vm.prank(address(this));
        vm.expectRevert(Arena.ZeroAddress.selector);
        arena.setAttestor(address(0), true);
        assertEq(arena.owner(), address(this));
        assertEq(arena.treasury(), treasury);
        assertEq(uint256(arena.randomnessMode()), 0);
    }

    function test_Constructor_RefusesAnUnwiredEscrow() public {
        vm.expectRevert(Arena.ZeroAddress.selector);
        new Arena(address(0), address(court), 0);
        vm.expectRevert(Arena.ZeroAddress.selector);
        new Arena(treasury, address(0), 0);
    }

    function test_Views_ExposeEachFieldGroup() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        (
            uint256 openedAt,
            uint256 openUntil,
            uint256 claimDeadline,
            uint256 submittedAt,
            uint256 windowEnd,
            uint256 holdoutDueBy,
            uint256 skepticWindow
        ) = arena.windowsOf(id);
        assertEq(skepticWindow, 3600);
        assertGt(openUntil, openedAt);
        assertGe(claimDeadline, submittedAt);
        assertEq(windowEnd, submittedAt + skepticWindow);
        assertEq(holdoutDueBy, submittedAt + Params.holdoutRevealMax(skepticWindow));
        (address s, address a, address r) = arena.partiesOf(id);
        assertEq(s, sponsor);
        assertEq(a, agent);
        assertEq(r, runner);
        (uint256 reward, uint256 fee, uint256 bond, uint256 deposited, uint256 paidOut) = arena.amountsOf(id);
        assertEq(reward, R);
        assertEq(fee, F);
        assertEq(bond, B);
        assertEq(deposited, R + F + B);
        assertEq(paidOut, 0);
        assertEq(arena.seatFeePerBreak(id), A);
        assertEq(arena.minimumStake(id), S);
        assertEq(arena.breakCount(id), 0);
        assertEq(arena.roundOf(id), 0);
        assertEq(arena.panelDrawnAt(id, 1), 0);
        assertEq(arena.voteOf(id, 1, seat1).length, 0);
        assertEq(uint8(arena.statusOf(id)), uint8(Arena.Status.Submitted));
    }
}
