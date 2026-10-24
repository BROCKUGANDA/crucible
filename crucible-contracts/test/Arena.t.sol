// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Arena} from "../contracts/Arena.sol";
import {ArgusCourt} from "../contracts/ArgusCourt.sol";
import {Params} from "../contracts/Params.sol";
import {ArenaReads} from "./ArenaReads.sol";

/// @notice The arena's flow table, gate by gate (734–746). Money is asserted to the wei, and
/// the ghost-ledger identity is re-checked after every step, because "it settled" and "it
/// settled without inventing or losing ETH" are two different claims.
contract ArenaTest is Test {
    // The per-field getters live in the test library now: see test/ArenaReads.sol for why.
    using ArenaReads for Arena;
    Arena arena;
    ArgusCourt court;

    address treasury = makeAddr("treasury");
    address sponsor = makeAddr("sponsor");
    address agent = makeAddr("agent");
    address skeptic = makeAddr("skeptic");
    address cranker = makeAddr("cranker");

    uint256 constant RUNNER_KEY = 0xA11CE;
    uint256 constant ATTESTOR_KEY = 0xB0B;
    address runner = vm.addr(RUNNER_KEY);
    address attestor = vm.addr(ATTESTOR_KEY);

    // The parameters this suite computes by hand, in the order the money appears.
    uint256 constant R = 1 ether; // reward
    uint256 constant F = 0.15 ether; // F = R × 1500 ÷ 10000, paid by the sponsor on top
    uint256 constant B = 0.2 ether; // bond floor = R × 2000 ÷ 10000
    uint256 constant S = 0.01 ether; // skeptic stake floor = R × 100 ÷ 10000
    uint256 constant A = 0.015 ether; // seat pool = R × 50 bps × 3 seats
    uint256 constant SHARE = 0.005 ether; // one seat's share of A
    uint256 constant PRIZE = 0.06 ether; // B × 3000 ÷ 10000
    uint256 constant SEAT_BOND = 0.2 ether; // SHARE × MAX_DOCKET(8) × 5, the per-trial draw floor

    uint256 constant SEAT_KEY_1 = 0xC11;
    uint256 constant SEAT_KEY_2 = 0xC22;
    uint256 constant SEAT_KEY_3 = 0xC33;
    address seat1 = vm.addr(SEAT_KEY_1);
    address seat2 = vm.addr(SEAT_KEY_2);
    address seat3 = vm.addr(SEAT_KEY_3);

    bytes32 constant SPEC = keccak256("spec");
    bytes32 constant SUITE = keccak256("suite");
    bytes32 constant ARTIFACT = keccak256("artifact");
    bytes32 constant VERDICT = keccak256("verdict");
    bytes32 constant REPLAY = keccak256("replay");
    bytes32 constant HARNESS = keccak256("model x harness");

    /// @dev Cached in setUp. `arena.DOMAIN()` is a CALL, and a call made while building an
    /// argument list is the call a pending `vm.prank` or `vm.expectRevert` applies to.
    bytes32 DOMAIN_CACHE;
    bytes32 RUN_TH;
    bytes32 ATTEST_TH;

    uint32 constant WINDOW = 3600; // the minimum skeptic window
    uint40 constant OPEN_SPAN = 2 days;
    uint64 constant SIG_DEADLINE = type(uint64).max;

    function setUp() public {
        court = new ArgusCourt();
        arena = new Arena(treasury, address(court), 0);
        DOMAIN_CACHE = arena.DOMAIN();
        // Recomputed here, not read from the contract: if a type string changes on one side of
        // the signature only, the equality assert below is what catches it.
        RUN_TH = keccak256(
            "Run(bytes32 trialId,address agent,bytes32 artifactDigest,bytes32 verdictHash,bytes32 replayHash,bytes32 modelHarnessId,uint64 nonce,uint64 sigDeadline)"
        );
        ATTEST_TH = keccak256(
            "ResultAttestation(bytes32 trialId,bytes32 artifactDigest,bytes32 verdictHash,bytes32 replayHash,bool passed,uint64 sigDeadline)"
        );
        assertEq(arena.RUN_TYPEHASH(), RUN_TH, "the test and the contract disagree about the Run type");
        assertEq(arena.ATTEST_TYPEHASH(), ATTEST_TH, "the test and the contract disagree about the attestation type");
        court.setArena(address(arena));

        vm.deal(sponsor, 20 ether);
        vm.deal(agent, 20 ether);
        vm.deal(skeptic, 20 ether);
        vm.deal(cranker, 1 ether);
        arena.setAttestor(attestor, true);

        _bondSeat(seat1);
        _bondSeat(seat2);
        _bondSeat(seat3);
    }

    // ───────────────────────── helpers ────────────────────────
    function _bondSeat(address seat) internal {
        vm.deal(seat, 5 ether);
        vm.prank(seat);
        court.bondSeat{value: SEAT_BOND}();
    }

    function _post() internal returns (uint256 id) {
        // The commitment is a sha256 CALL, and `vm.prank` applies to the next call the test
        // contract makes — which would be the hash, not the post. Every hash argument here is
        // therefore hoisted into a local, or the trial is posted by the test contract itself.
        bytes32 commitment = _holdoutCommitment();
        vm.prank(sponsor);
        id = arena.postTrial{value: R + F}(R, SPEC, SUITE, commitment, WINDOW, OPEN_SPAN);
    }

    function _holdoutSalt() internal pure returns (bytes32) {
        return keccak256("holdout-salt");
    }

    function _holdoutDigest() internal pure returns (bytes32) {
        return keccak256("holdout-tests");
    }

    function _holdoutCommitment() internal pure returns (bytes32) {
        return sha256(abi.encodePacked(_holdoutSalt(), _holdoutDigest()));
    }

    function _claim(uint256 id) internal {
        vm.prank(agent);
        arena.claimTrial{value: B}(id);
        vm.prank(agent);
        arena.setRunner(id, runner);
    }

    uint64 private _nonce;

    function _submit(uint256 id) internal {
        _nonce += 1;
        _submitWithNonce(id, _nonce);
    }

    function _submitWithNonce(uint256 id, uint64 nonce) internal {
        bytes32 runDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_CACHE,
                keccak256(
                    abi.encode(RUN_TH, bytes32(id), agent, ARTIFACT, VERDICT, REPLAY, HARNESS, nonce, SIG_DEADLINE)
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, runDigest);
        bytes memory runnerSig = abi.encodePacked(r, s, v);

        bytes32 attestDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_CACHE,
                keccak256(abi.encode(ATTEST_TH, bytes32(id), ARTIFACT, VERDICT, REPLAY, true, SIG_DEADLINE))
            )
        );
        (uint8 av, bytes32 ar, bytes32 asig) = vm.sign(ATTESTOR_KEY, attestDigest);
        bytes memory attestorSig = abi.encodePacked(ar, asig, av);

        arena.submitRun(id, ARTIFACT, VERDICT, REPLAY, HARNESS, nonce, SIG_DEADLINE, runnerSig, attestorSig);
    }

    /// @notice File and reveal a break, ending past the window + grace so the docket can form.
    function _breakRevealed(uint256 id, address filer, Arena.BreakKind kind, uint256 stake)
        internal
        returns (uint256 index)
    {
        bytes32 evidence = keccak256(abi.encodePacked("evidence", filer, uint8(kind)));
        bytes32 salt = keccak256(abi.encodePacked("salt", filer));
        bytes32 commitment =
            sha256(abi.encodePacked("CRUCIBLE:break:v1", bytes32(id), filer, uint8(kind), evidence, salt));

        vm.deal(filer, 5 ether);
        vm.prank(filer);
        arena.commitBreak{value: stake + A}(id, commitment);
        index = arena.breakCount(id) - 1;

        // Sealed until the window closes: revealing earlier is the rule, not a nicety.
        uint256 end = arena.windowEndOf(id);
        if (block.timestamp < end + 1) vm.warp(end + 1);
        vm.prank(filer);
        arena.revealBreak(id, index, kind, evidence, salt);
    }

    function _windowClosed(uint256 id) internal {
        uint256 windowEnd = arena.windowEndOf(id);
        vm.warp(windowEnd + Params.BREAK_REVEAL_GRACE_SECONDS + 1);
    }

    function _vote(uint256 id, uint8 round, address seat, bytes memory votes) internal {
        bytes32 salt = keccak256(abi.encodePacked("vote-salt", seat));
        bytes32 commitment = sha256(abi.encodePacked("CRUCIBLE:vote:v1", bytes32(id), round, seat, votes, REPLAY, salt));
        vm.prank(seat);
        arena.commitVote(id, commitment);
        vm.prank(seat);
        arena.revealVote(id, round, votes, REPLAY, salt);
    }

    function _panelVoted(uint256 id, bytes memory votesA, bytes memory votesB, bytes memory votesC) internal {
        arena.drawPanel(id, 1);
        uint8 round = arena.roundOf(id);
        _vote(id, round, seat1, votesA);
        _vote(id, round, seat2, votesB);
        _vote(id, round, seat3, votesC);
        _pastVoteWindows(id);
    }

    function _pastVoteWindows(uint256 id) internal {
        uint8 round = arena.roundOf(id);
        uint256 drawnAt = arena.panelDrawnAt(id, round);
        vm.warp(drawnAt + Params.VOTE_COMMIT_WINDOW_SECONDS + Params.VOTE_REVEAL_WINDOW_SECONDS + 1);
    }

    function _assertConservation(string memory where) internal {
        (bool balanceOk, bool booksOk) = arena.conservationDetail();
        assertTrue(balanceOk, string(abi.encodePacked(where, ": pending exceeds balance")));
        assertTrue(booksOk, string(abi.encodePacked(where, ": balance + withdrawn != deposited")));
        assertTrue(arena.conservationHolds(), string(abi.encodePacked(where, ": identity")));
    }

    function _credited(address who) internal view returns (uint256) {
        return arena.credit(who);
    }

    // ───────────────────────── gate 734 — post, cancel, expire ─────────────────────────
    function test_734_Post_EscrowsRewardPlusFee() public {
        uint256 id = _post();
        (uint256 reward, uint256 fee, uint256 bond, uint256 deposited, uint256 paidOut) = arena.amountsOf(id);
        assertEq(reward, R);
        assertEq(fee, F, "the arena fee is 15% of R, and it is the sponsor's to pay");
        assertEq(bond, 0);
        assertEq(deposited, R + F);
        assertEq(paidOut, 0);
        assertEq(address(arena).balance, R + F);
        Arena.Status postedStatus = arena.statusOf(id);
        assertEq(uint8(postedStatus), uint8(Arena.Status.Open));
        _assertConservation("posted");
    }

    function test_734_Cancel_OnlyBeforeAnyClaim() public {
        uint256 id = _post();
        vm.prank(cranker);
        vm.expectRevert(Arena.NotSponsor.selector);
        arena.cancelTrial(id);

        vm.prank(sponsor);
        arena.cancelTrial(id);
        Arena.Outcome outcome = arena.outcomeOf(id);
        bool docketFrozen = arena.docketFrozenOf(id);
        assertEq(uint8(outcome), uint8(Arena.Outcome.O7));
        assertEq(_credited(sponsor), R + F, "a cancelled trial refunds the fee as well as the reward");
        assertEq(docketFrozen, false);
        _assertConservation("cancelled");
    }

    function test_734_Cancel_RevertsOnceSomeoneHasHeldTheClaim() public {
        uint256 id = _post();
        _claim(id);
        vm.prank(agent);
        arena.yieldTrial(id); // back to Open, but it has been claimed

        vm.prank(sponsor);
        vm.expectRevert(Arena.BadState.selector);
        arena.cancelTrial(id);
    }

    function test_734_Expire_IsPermissionlessAfterTheOpenWindow() public {
        uint256 id = _post();
        vm.prank(cranker);
        vm.expectRevert(Arena.WindowStillOpen.selector);
        arena.expireTrial(id);

        uint256 openUntil = arena.openUntilOf(id);
        vm.warp(openUntil + 1);
        vm.prank(cranker);
        arena.expireTrial(id);
        assertEq(_credited(sponsor), R + F);
        Arena.Outcome outcome = arena.outcomeOf(id);
        assertEq(uint8(outcome), uint8(Arena.Outcome.O6));
        _assertConservation("expired");
    }

    // ───────────────────────── gate 735 — the money entry rules ─────────────────────────
    function test_735_Post_RejectsBelowTheEthFloor() public {
        bytes32 commitment = _holdoutCommitment();
        // one wei under the 0.01 ETH floor, with the fee recomputed at that reward
        uint256 under = 0.01 ether - 1;
        uint256 feeUnder = (under * Params.ARENA_FEE_BPS) / 10000;
        vm.prank(sponsor);
        vm.expectRevert(Arena.RewardTooSmall.selector);
        arena.postTrial{value: under + feeUnder}(under, SPEC, SUITE, commitment, WINDOW, OPEN_SPAN);

        // exactly at the floor it is accepted
        vm.prank(sponsor);
        arena.postTrial{value: 0.0115 ether}(0.01 ether, SPEC, SUITE, commitment, WINDOW, OPEN_SPAN);
    }

    function test_735_Post_RejectsAWrongSum() public {
        bytes32 commitment = _holdoutCommitment();
        vm.prank(sponsor);
        vm.expectRevert(Arena.RewardMismatch.selector);
        arena.postTrial{value: R}(R, SPEC, SUITE, commitment, WINDOW, OPEN_SPAN);

        vm.prank(sponsor);
        vm.expectRevert(Arena.RewardMismatch.selector);
        arena.postTrial{value: R + F + 1}(R, SPEC, SUITE, commitment, WINDOW, OPEN_SPAN);
    }

    function test_735_Post_RejectsWindowAndSpanOutsideBounds() public {
        bytes32 commitment = _holdoutCommitment();
        vm.prank(sponsor);
        vm.expectRevert(Arena.BadWindow.selector);
        arena.postTrial{value: R + F}(R, SPEC, SUITE, commitment, 60, OPEN_SPAN);

        vm.prank(sponsor);
        vm.expectRevert(Arena.BadOpenSpan.selector);
        arena.postTrial{value: R + F}(R, SPEC, SUITE, commitment, WINDOW, uint40(Params.TRIAL_OPEN_MAX_SECONDS + 1));
    }

    /// @notice The escrow cannot be paid by accident. Every inbound path is a function with a
    /// price attached, so a stray transfer has nowhere to go and nothing to corrupt.
    function test_735_EscrowCannotReceiveStrayEth() public {
        (bool ok,) = address(arena).call{value: 1 ether}("");
        assertFalse(ok, "the arena must not accept ETH outside a priced call");
    }

    // ───────────────────────── gate 736 — claim, yield, timeout ─────────────────────────
    function test_736_Claim_EscrowsTheBondAndStartsTheDeadline() public {
        uint256 id = _post();
        vm.prank(agent);
        arena.claimTrial{value: B}(id);
        (,, uint256 bond,,) = arena.amountsOf(id);
        assertEq(bond, B);
        assertEq(arena.activeClaimsOf(agent), 1);
        Arena.Status status = arena.statusOf(id);
        assertEq(uint8(status), uint8(Arena.Status.Claimed));
        _assertConservation("claimed");
    }

    function test_736_Claim_RejectsABondUnderTheFloor() public {
        uint256 id = _post();
        vm.prank(agent);
        vm.expectRevert(Arena.StakeTooSmall.selector);
        arena.claimTrial{value: B - 1}(id);
    }

    function test_736_Claim_RejectsTheSponsorAndADoubleClaim() public {
        uint256 id = _post();
        vm.deal(sponsor, 20 ether);
        vm.prank(sponsor);
        vm.expectRevert(Arena.SelfClaim.selector);
        arena.claimTrial{value: B}(id);

        _claim(id);
        vm.prank(cranker);
        vm.expectRevert(Arena.AlreadyClaimed.selector);
        arena.claimTrial{value: B}(id);
    }

    function test_736_Claim_RejectsTheFourthConcurrentClaim() public {
        bytes32 commitment = _holdoutCommitment();
        uint256[3] memory ids;
        for (uint256 i; i < 3; ++i) {
            vm.prank(sponsor);
            ids[i] = arena.postTrial{value: R + F}(R, SPEC, SUITE, commitment, WINDOW, OPEN_SPAN);
            vm.prank(agent);
            arena.claimTrial{value: B}(ids[i]);
        }
        assertEq(arena.activeClaimsOf(agent), Params.MAX_ACTIVE_CLAIMS);

        vm.prank(sponsor);
        uint256 fourth = arena.postTrial{value: R + F}(R, SPEC, SUITE, commitment, WINDOW, OPEN_SPAN);
        vm.prank(agent);
        vm.expectRevert(Arena.TooManyActiveClaims.selector);
        arena.claimTrial{value: B}(fourth);
    }

    function test_736_Yield_ReturnsTheBondAndReopensTheTrial() public {
        uint256 id = _post();
        _claim(id);
        vm.prank(agent);
        arena.yieldTrial(id);

        assertEq(_credited(agent), B, "walking away costs Standing, not the bond");
        assertEq(arena.activeClaimsOf(agent), 0);
        Arena.Status status = arena.statusOf(id);
        assertEq(uint8(status), uint8(Arena.Status.Open));
        _assertConservation("yielded");
    }

    function test_736_YieldCooldown_BlocksTheSameAgentFromReclaiming() public {
        uint256 id = _post();
        _claim(id);
        vm.prank(agent);
        arena.yieldTrial(id);

        vm.prank(agent);
        vm.expectRevert(Arena.YieldCooldown.selector);
        arena.claimTrial{value: B}(id);

        // Someone else may take it immediately — the cooldown is on the squatter, not the trial.
        address other = makeAddr("other");
        vm.deal(other, 5 ether);
        vm.prank(other);
        arena.claimTrial{value: B}(id);
        assertEq(arena.activeClaimsOf(other), 1);
    }

    function test_736_ClaimTimeout_SplitsTheBondTenWaysAndReopens() public {
        bytes32 commitment = _holdoutCommitment();
        vm.prank(sponsor);
        uint256 id = arena.postTrial{value: R + F}(R, SPEC, SUITE, commitment, WINDOW, 20 days);
        _claim(id);
        uint256 claimDeadline = arena.claimDeadlineOf(id);
        vm.warp(claimDeadline + 1);
        vm.prank(cranker);
        arena.claimTimeout(id);

        assertEq(_credited(sponsor), 0.02 ether, "the sponsor takes CLAIM_TIMEOUT_FORFEIT_BPS of the bond");
        assertEq(_credited(agent), 0.18 ether, "the agent keeps the rest");
        assertEq(arena.activeClaimsOf(agent), 0);
        _assertConservation("claim timeout");
    }

    function test_736_ClaimTimeout_RefundsTheRewardWhenTheTrialIsDoneToo() public {
        uint256 id = _post();
        _claim(id);
        // Push past both the claim deadline and the trial's own open window.
        uint256 claimDeadline = arena.claimDeadlineOf(id);
        uint256 openUntil = arena.openUntilOf(id);
        vm.warp(claimDeadline + 1 > openUntil + 1 ? claimDeadline + 1 : openUntil + 1);
        vm.prank(cranker);
        arena.claimTimeout(id);
        assertEq(_credited(sponsor), 0.02 ether + R + F);
        Arena.Outcome outcome = arena.outcomeOf(id);
        assertEq(uint8(outcome), uint8(Arena.Outcome.O6));
    }

    // ───────────────────────── gates 737 + 738 — the signed pass ─────────────────────────
    function test_737_Submit_NeedsBothTheRunnerAndAnAttestor() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        (,,,, bytes32 runHash,,,) = arena.digestsOf(id);
        assertEq(runHash, ARTIFACT);
        Arena.Status status = arena.statusOf(id);
        assertEq(uint8(status), uint8(Arena.Status.Submitted));
    }

    function test_737_Submit_RejectsAnUnwiredAttestor() public {
        uint256 id = _post();
        _claim(id);
        bytes32 runDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_CACHE,
                keccak256(
                    abi.encode(RUN_TH, bytes32(id), agent, ARTIFACT, VERDICT, REPLAY, HARNESS, uint64(1), SIG_DEADLINE)
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, runDigest);
        bytes memory runnerSig = abi.encodePacked(r, s, v);

        bytes32 attestDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_CACHE,
                keccak256(abi.encode(ATTEST_TH, bytes32(id), ARTIFACT, VERDICT, REPLAY, true, SIG_DEADLINE))
            )
        );
        (uint8 av, bytes32 ar, bytes32 asig) = vm.sign(0xDEAD, attestDigest); // not an attestor
        vm.expectRevert(Arena.BadSigner.selector);
        arena.submitRun(
            id, ARTIFACT, VERDICT, REPLAY, HARNESS, 1, SIG_DEADLINE, runnerSig, abi.encodePacked(ar, asig, av)
        );
    }

    function test_737_Submit_RejectsAKeyThatIsNotTheClaimsRunner() public {
        uint256 id = _post();
        vm.prank(agent);
        arena.claimTrial{value: B}(id);
        address someoneElse = makeAddr("someone else's key");
        vm.prank(agent);
        arena.setRunner(id, someoneElse);
        vm.expectRevert(Arena.BadSigner.selector);
        _submitWithNonce(id, 1);
    }

    function test_737_Submit_RejectsAStaleDeadlineAndEmptyDigests() public {
        uint256 id = _post();
        _claim(id);
        bytes32 runDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_CACHE,
                keccak256(
                    abi.encode(
                        RUN_TH,
                        bytes32(id),
                        agent,
                        ARTIFACT,
                        VERDICT,
                        REPLAY,
                        HARNESS,
                        uint64(1),
                        uint64(block.timestamp)
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, runDigest);
        bytes32 attestDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_CACHE,
                keccak256(abi.encode(ATTEST_TH, bytes32(id), ARTIFACT, VERDICT, REPLAY, true, uint64(block.timestamp)))
            )
        );
        (uint8 av, bytes32 ar, bytes32 asig) = vm.sign(ATTESTOR_KEY, attestDigest);
        vm.expectRevert(Arena.SigExpired.selector);
        arena.submitRun(
            id,
            ARTIFACT,
            VERDICT,
            REPLAY,
            HARNESS,
            1,
            uint64(block.timestamp),
            abi.encodePacked(r, s, v),
            abi.encodePacked(ar, asig, av)
        );
    }

    function test_738_Submit_NonceMustMoveForward() public {
        uint256 id = _post();
        _claim(id);
        _submitWithNonce(id, 5);

        // A second submission of the same trial is a state error; the same nonce on another
        // trial is a replay error. Both must be refused.
        uint256 second = _post();
        vm.prank(agent);
        arena.claimTrial{value: B}(second);
        vm.prank(agent);
        arena.setRunner(second, runner);
        vm.expectRevert(Arena.NonceReplayed.selector);
        _submitWithNonce(second, 5);
        _submitWithNonce(second, 6);
    }

    function test_738_Submit_DomainBindsTheChainAndThisContract() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("CRUCIBLE"),
                keccak256("2"),
                block.chainid,
                address(arena)
            )
        );
        assertEq(DOMAIN_CACHE, expected, "a signature must not survive a redeploy or a fork");
    }

    function test_738_Submit_ASignatureForAnotherTrialIsRejected() public {
        uint256 id = _post();
        _claim(id);
        uint256 other = _post();
        vm.prank(agent);
        arena.claimTrial{value: B}(other);
        vm.prank(agent);
        arena.setRunner(other, runner);

        // Sign for `other`, then present it against `id`'s digest: the trial id is inside the
        // typed struct, so the recovered signer no longer matches.
        bytes32 runDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_CACHE,
                keccak256(
                    abi.encode(
                        RUN_TH, bytes32(other), agent, ARTIFACT, VERDICT, REPLAY, HARNESS, uint64(1), SIG_DEADLINE
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, runDigest);
        bytes32 attestDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_CACHE,
                keccak256(abi.encode(ATTEST_TH, bytes32(id), ARTIFACT, VERDICT, REPLAY, true, SIG_DEADLINE))
            )
        );
        (uint8 av, bytes32 ar, bytes32 asig) = vm.sign(ATTESTOR_KEY, attestDigest);
        vm.expectRevert(Arena.BadSigner.selector);
        arena.submitRun(
            id,
            ARTIFACT,
            VERDICT,
            REPLAY,
            HARNESS,
            1,
            SIG_DEADLINE,
            abi.encodePacked(r, s, v),
            abi.encodePacked(ar, asig, av)
        );
    }

    // ───────────────────────── gate 739 — O1, permissionless ─────────────────────────
    function test_739_O1_SettlesWithoutAnybodySponsorOrAgentActing() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        _windowClosed(id);

        vm.prank(cranker); // a stranger cranks the whole settlement
        arena.freezeDocket(id);

        Arena.Outcome outcome = arena.outcomeOf(id);
        assertEq(uint8(outcome), uint8(Arena.Outcome.O1));
        assertEq(_credited(agent), R + B, "the agent takes the reward and its bond back");
        assertEq(_credited(treasury), F, "the fee is the only thing the arena keeps on a clean pass");
        assertEq(arena.activeClaimsOf(agent), 0);
        _assertConservation("O1");
    }

    // ───────────────────────── gate 740 — the sealed holdout ─────────────────────────
    function test_740_Holdout_RevealsOnlyAgainstItsCommitment() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);

        bytes32 hDigest = _holdoutDigest();
        bytes32 hSalt = _holdoutSalt();
        vm.prank(skeptic);
        vm.expectRevert(Arena.NotSponsor.selector);
        arena.revealHoldout(id, hDigest, hSalt);

        bytes32 wrong = keccak256("the wrong tests");
        bytes32 salt = _holdoutSalt();
        vm.prank(sponsor);
        vm.expectRevert(Arena.HoldoutCommitmentMismatch.selector);
        arena.revealHoldout(id, wrong, salt);

        bytes32 digest = _holdoutDigest();
        vm.prank(sponsor);
        arena.revealHoldout(id, digest, salt);
        bool holdoutRevealed = arena.holdoutRevealedOf(id);
        assertTrue(holdoutRevealed);
        (,,, bytes32 storedDigest,,,,) = arena.digestsOf(id);
        assertEq(storedDigest, digest);
    }

    function test_740_Holdout_MissedByTheDeadlineIsFlaggedNotSilent() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        uint256 submittedAt = arena.submittedAtOf(id);
        uint256 holdoutDueBy = arena.holdoutDueByOf(id);
        assertEq(
            holdoutDueBy - submittedAt, Params.holdoutRevealMax(WINDOW), "reveal cap is half the window, capped at 24h"
        );

        _windowClosed(id);
        vm.prank(cranker);
        arena.freezeDocket(id);
        bool revealed = arena.holdoutRevealedOf(id);
        bool missed = arena.holdoutMissedOf(id);
        assertEq(revealed, false);
        assertTrue(missed, "an unrevealed holdout must be visible, and the trial still settles on public tests");
    }

    // ───────────────────────── gate 741 — break commit-reveal ─────────────────────────
    function test_741_Break_CannotBeRevealedWhileCommittingIsStillPossible() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);

        bytes32 evidence = keccak256("evidence");
        bytes32 salt = keccak256("salt");
        bytes32 commitment = sha256(
            abi.encodePacked(
                "CRUCIBLE:break:v1", bytes32(id), skeptic, uint8(Arena.BreakKind.PublicFail), evidence, salt
            )
        );
        vm.deal(skeptic, 5 ether);
        vm.prank(skeptic);
        arena.commitBreak{value: S + A}(id, commitment);

        vm.prank(skeptic);
        vm.expectRevert(Arena.WindowStillOpen.selector);
        arena.revealBreak(id, 0, Arena.BreakKind.PublicFail, evidence, salt);

        uint256 windowEnd = arena.windowEndOf(id);
        vm.warp(windowEnd + 1);
        vm.prank(skeptic);
        arena.revealBreak(id, 0, Arena.BreakKind.PublicFail, evidence, salt);
        bool revealed = arena.breakRevealedAt(id, 0);
        assertTrue(revealed);
    }

    function test_741_Break_RevealAfterTheGraceIsLateAndTheCommitFails() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        bytes32 evidence = keccak256("evidence");
        bytes32 salt = keccak256("salt");
        bytes32 commitment = sha256(
            abi.encodePacked(
                "CRUCIBLE:break:v1", bytes32(id), skeptic, uint8(Arena.BreakKind.PublicFail), evidence, salt
            )
        );
        vm.deal(skeptic, 5 ether);
        vm.prank(skeptic);
        arena.commitBreak{value: S + A}(id, commitment);

        uint256 windowEnd = arena.windowEndOf(id);
        vm.warp(windowEnd + Params.BREAK_REVEAL_GRACE_SECONDS + 1);
        vm.prank(skeptic);
        vm.expectRevert(Arena.RevealWindowClosed.selector);
        arena.revealBreak(id, 0, Arena.BreakKind.PublicFail, evidence, salt);

        // An unrevealed commit counts as a failed break: the stake forfeits, the seat fee is
        // returned because no panel ever sat on it (§6.3.4).
        vm.prank(cranker);
        arena.freezeDocket(id);
        assertEq(_credited(treasury), F + S, "the blind commit's stake is the treasury's");
        assertEq(_credited(skeptic), A, "but nobody pays a fee for work no jury did");
    }

    function test_741_Break_AWrongSaltIsNotAReveal() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        bytes32 commitment = sha256(
            abi.encodePacked(
                "CRUCIBLE:break:v1",
                bytes32(id),
                skeptic,
                uint8(Arena.BreakKind.SpecViolation),
                keccak256("e"),
                keccak256("right salt")
            )
        );
        vm.deal(skeptic, 5 ether);
        vm.prank(skeptic);
        arena.commitBreak{value: S + A}(id, commitment);
        uint256 windowEnd = arena.windowEndOf(id);
        vm.warp(windowEnd + 1);
        vm.prank(skeptic);
        vm.expectRevert(Arena.CommitMismatch.selector);
        arena.revealBreak(id, 0, Arena.BreakKind.SpecViolation, keccak256("e"), keccak256("guessed salt"));
    }

    function test_741_Break_TheAgentMayNotFileAgainstItself() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        vm.prank(agent);
        vm.expectRevert(Arena.SelfBreak.selector);
        arena.commitBreak{value: S + A}(id, keccak256("commitment"));
    }

    // ───────────────────────── gate 742 — the ranked docket ─────────────────────────
    function test_742_Docket_KeepsTheHighestStakesAndRefundsTheRest() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);

        // MAX_DOCKET + 1 filings, so exactly one has to fall off, and the ranking is what
        // decides it. The smallest stake of the set is the one that must be refunded.
        address big = makeAddr("big");
        address small = makeAddr("small");
        for (uint256 i; i < Params.MAX_DOCKET - 1; ++i) {
            _commitOnly(id, makeAddr(string(abi.encodePacked("mid", i))), S * 2);
        }
        _commitOnly(id, big, S * 4);
        _commitOnly(id, small, S);
        _revealAll(id);
        assertEq(arena.breakCount(id), Params.MAX_DOCKET + 1);
        uint256 last = arena.breakCount(id) - 1;
        assertEq(arena.breakSkepticAt(id, last), small, "the smallest stake is the last filing here");
        assertTrue(arena.breakRevealedAt(id, last));
        assertEq(arena.breakOnDocketAt(id, last), false, "nothing is cut until the docket freezes");

        _windowClosed(id);
        vm.prank(cranker);
        arena.freezeDocket(id);

        assertEq(arena.breakOnDocketAt(id, last), false, "the smallest stake falls off the docket");
        assertTrue(arena.breakOnDocketAt(id, Params.MAX_DOCKET - 1), "the biggest stake is judged");
        assertEq(arena.docketSize(id), Params.MAX_DOCKET, "exactly MAX_DOCKET breaks are judged");
        assertEq(_credited(small), S + A, "the filed-out skeptic is refunded in full, not partially");
        assertEq(_credited(big), 0, "a break that IS on the docket waits for the jury: nothing back yet");
    }

    function test_742_Docket_TiesGoToTheEarlierCommit() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        address first = makeAddr("first");
        address second = makeAddr("second");

        _commitOnly(id, first, S);
        vm.warp(block.timestamp + 1);
        _commitOnly(id, second, S);
        _revealAll(id);
        _windowClosed(id);
        vm.prank(cranker);
        arena.freezeDocket(id);

        bool onDocketFirst = arena.breakOnDocketAt(id, 0);
        bool onDocketSecond = arena.breakOnDocketAt(id, 1);
        assertTrue(onDocketFirst);
        assertTrue(onDocketSecond); // both fit under MAX_DOCKET; the order is what is asserted below
        assertEq(arena.docketSize(id), 2);
    }

    function test_742_Docket_FilesAreUnlimitedJudgingIsNot() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        uint256 filed;
        for (uint256 i; i < arena.MAX_FILING(); ++i) {
            _commitOnly(id, makeAddr(string(abi.encodePacked("skeptic", i))), S);
            filed++;
        }
        assertEq(arena.breakCount(id), filed);
        // The bound is on filings, not on the docket: past MAX_FILING the door is shut, and the
        // stranger who cranks the docket pays for a bounded list, not an unbounded one.
        bytes32 extra = keccak256("one filing too many");
        vm.deal(skeptic, 5 ether);
        vm.prank(skeptic);
        vm.expectRevert(Arena.TooManyBreaks.selector);
        arena.commitBreak{value: S + A}(id, extra);
        _revealAll(id);
        _windowClosed(id);
        vm.prank(cranker);
        arena.freezeDocket(id);
        assertEq(arena.docketSize(id), Params.MAX_DOCKET, "at most MAX_DOCKET breaks are ever judged");
    }

    function _commitOnly(uint256 id, address filer, uint256 stake) internal {
        bytes32 evidence = keccak256(abi.encodePacked("evidence", filer));
        bytes32 salt = keccak256(abi.encodePacked("salt", filer));
        bytes32 commitment = sha256(
            abi.encodePacked("CRUCIBLE:break:v1", bytes32(id), filer, uint8(Arena.BreakKind.PublicFail), evidence, salt)
        );
        vm.deal(filer, 5 ether);
        vm.prank(filer);
        arena.commitBreak{value: stake + A}(id, commitment);
        _saltOf[filer] = salt;
        _evidenceOf[filer] = evidence;
    }

    mapping(address => bytes32) internal _saltOf;
    mapping(address => bytes32) internal _evidenceOf;

    function _commitAndReveal(uint256 id, address filer, uint256 stake) internal {
        _commitOnly(id, filer, stake);
        uint256 index = arena.breakCount(id) - 1;
        uint256 windowEnd = arena.windowEndOf(id);
        if (block.timestamp < windowEnd) vm.warp(windowEnd + 1);
        vm.prank(filer);
        arena.revealBreak(id, index, Arena.BreakKind.PublicFail, _evidenceOf[filer], _saltOf[filer]);
    }

    function _revealAll(uint256 id) internal {
        uint256 windowEnd = arena.windowEndOf(id);
        vm.warp(windowEnd + 1);
        uint256 n = arena.breakCount(id);
        for (uint256 i; i < n; ++i) {
            address filer = arena.breakSkepticAt(id, i);
            vm.prank(filer);
            arena.revealBreak(id, i, Arena.BreakKind.PublicFail, _evidenceOf[filer], _saltOf[filer]);
        }
    }

    // ───────────────────────── gate 743 — the outcome table ─────────────────────────
    function test_743_O2_EveryBreakFailed_PaysTheAgentAndRoutesFailedStakesToTheTreasury() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        _breakRevealed(id, skeptic, Arena.BreakKind.PublicFail, S);
        _windowClosed(id);
        vm.prank(cranker);
        arena.freezeDocket(id);

        bytes memory reject = hex"01"; // one docket entry, Rejected
        _panelVoted(id, reject, reject, reject);
        vm.prank(cranker);
        arena.tally(id);

        Arena.Outcome outcome = arena.outcomeOf(id);
        assertEq(uint8(outcome), uint8(Arena.Outcome.O2));
        assertEq(_credited(agent), R + B);
        assertEq(_credited(skeptic), 0, "a failed break loses its stake (bible 6.3, D-2)");
        assertEq(
            _credited(treasury), F + S, "the fee and the forfeited stake; nobody dissented, so nothing is unearned"
        );
        assertEq(_credited(seat1) + _credited(seat2) + _credited(seat3), A, "a unanimous jury is paid in full");
        _assertConservation("O2");
    }

    function test_743_O3_ABreakLanded_SponsorWholeSkepticPrizedBondSplits() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        _breakRevealed(id, skeptic, Arena.BreakKind.SpecViolation, S);
        _windowClosed(id);
        vm.prank(cranker);
        arena.freezeDocket(id);

        bytes memory uphold = hex"00";
        bytes memory reject = hex"01";
        _panelVoted(id, uphold, uphold, reject);
        vm.prank(cranker);
        arena.tally(id);

        Arena.Outcome outcome = arena.outcomeOf(id);
        assertEq(uint8(outcome), uint8(Arena.Outcome.O3));
        assertEq(_credited(sponsor), R + F, "a claim that broke returns everything the sponsor put in");
        assertEq(_credited(agent), 0, "the agent forfeits the bond and is paid nothing");
        assertEq(_credited(skeptic), S + A + PRIZE, "first landed break: stake, seat fee, and 30% of the bond");
        assertEq(_credited(seat1) + _credited(seat2), 2 * SHARE, "the seats that upheld are paid from the bond");
        assertEq(_credited(treasury), (B - PRIZE - A) + SHARE, "every remainder of the bond, plus the dissenting share");
        assertEq(
            _credited(sponsor) + _credited(skeptic) + _credited(treasury) + _credited(seat1) + _credited(seat2)
                + _credited(seat3),
            R + F + B + S + A
        );
        _assertConservation("O3");
    }

    function test_743_O3_ThePrizeFollowsTheEarliestCommitNotTheBiggestStake() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        address early = makeAddr("early");
        address late = makeAddr("late");
        _commitOnly(id, early, S); // committed first, smaller stake
        _commitOnly(id, late, S * 4);
        _revealAll(id);
        _windowClosed(id);
        vm.prank(cranker);
        arena.freezeDocket(id);

        bytes memory upholdBoth = hex"0000";
        _panelVoted(id, upholdBoth, upholdBoth, upholdBoth);
        vm.prank(cranker);
        arena.tally(id);

        assertEq(_credited(late), (S * 4) + A, "the bigger stake is judged, but it is not first");
        assertEq(_credited(early), S + A + PRIZE, "the discoverer takes the prize");
        _assertConservation("O3 prize order");
    }

    function test_743_O8_NoQuorumRefundsEverybody() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        _breakRevealed(id, skeptic, Arena.BreakKind.Provenance, S);
        _windowClosed(id);
        vm.prank(cranker);
        arena.freezeDocket(id);

        // 1 uphold, 1 reject, 1 abstain: no quorum, twice.
        bytes memory uphold = hex"00";
        bytes memory reject = hex"01";
        bytes memory abstain = hex"02";
        _panelVoted(id, uphold, reject, abstain);
        vm.prank(cranker);
        arena.tally(id); // round 1 unresolved -> round 2 armed

        Arena.Status status = arena.statusOf(id);
        uint8 round = arena.roundOf(id);
        assertEq(uint8(status), uint8(Arena.Status.Docketed), "round 2 draws fresh seats");
        assertEq(round, 2);

        _panelVotedSecondRound(id, uphold, reject, abstain);
        vm.prank(cranker);
        arena.tally(id);

        Arena.Outcome outcome = arena.outcomeOf(id);
        assertEq(uint8(outcome), uint8(Arena.Outcome.O8));
        assertEq(_credited(sponsor), R + F);
        assertEq(_credited(agent), B);
        assertEq(_credited(skeptic), S + A, "a verdict nobody reached cannot cost a skeptic its stake");
        _assertConservation("O8");
    }

    function _statusAndRound(uint256 id) internal view returns (Arena.Status, uint8) {
        Arena.Status status = arena.statusOf(id);
        uint8 round = arena.roundOf(id);
        return (status, round);
    }

    function _panelVotedSecondRound(uint256 id, bytes memory a, bytes memory b, bytes memory c) internal {
        address s4 = vm.addr(0xD44);
        address s5 = vm.addr(0xD55);
        address s6 = vm.addr(0xD66);
        _bondSeat(s4);
        _bondSeat(s5);
        _bondSeat(s6);
        arena.drawPanel(id, 2);
        _vote(id, 2, s4, a);
        _vote(id, 2, s5, b);
        _vote(id, 2, s6, c);
        _pastVoteWindows(id);
    }

    // ───────────────────────── gate 744 — the ghost ledger ─────────────────────────
    function test_744_Ledger_EveryStepKeepsDepositedEqualToPaidPlusHeld() public {
        uint256 id = _post();
        _assertConservation("after post");
        (,, uint256 bondAtClaim,,) = arena.amountsOf(id);
        assertEq(bondAtClaim, 0);

        _claim(id);
        _assertConservation("after claim");
        (uint256 reward, uint256 fee,, uint256 deposited, uint256 paidOut) = arena.amountsOf(id);
        assertEq(deposited, R + F + B);
        assertEq(paidOut, 0);
        assertEq(reward + fee, R + F);

        _submit(id);
        _assertConservation("after submit");

        vm.deal(skeptic, 5 ether);
        bytes32 evidence = keccak256("e");
        bytes32 salt = keccak256("s");
        bytes32 ledgerCommitment = sha256(
            abi.encodePacked(
                "CRUCIBLE:break:v1", bytes32(id), skeptic, uint8(Arena.BreakKind.HoldoutFail), evidence, salt
            )
        );
        vm.prank(skeptic);
        arena.commitBreak{value: S + A}(id, ledgerCommitment);
        _assertConservation("after commit");

        uint256 windowEnd = arena.windowEndOf(id);
        vm.warp(windowEnd + 1);
        vm.prank(skeptic);
        arena.revealBreak(id, 0, Arena.BreakKind.HoldoutFail, evidence, salt);
        _assertConservation("after reveal");

        _windowClosed(id);
        vm.prank(cranker);
        arena.freezeDocket(id);
        _assertConservation("after freeze");

        bytes memory uphold = hex"00";
        _panelVoted(id, uphold, uphold, uphold);
        vm.prank(cranker);
        arena.tally(id);
        _assertConservation("after tally");

        (,,,, uint256 paidFinal) = arena.amountsOf(id);
        assertEq(paidFinal, R + F + B + S + A, "what left the ledger equals what entered it");
        assertEq(arena.totalDeposited(), R + F + B + S + A);
    }

    // ───────────────────────── gate 745 — seats, draw, votes, slashing ─────────────────────────
    function test_745_Draw_SkipsTheSponsorTheAgentAndDeclaredConflicts() public {
        // A three-seat pool with one exclusion has no jury left, which is the correct answer and
        // not a testable draw. Bench seats make the exclusion the thing under test.
        _bondSeat(vm.addr(0xE11));
        _bondSeat(vm.addr(0xE22));
        uint256 id = _post();
        _claim(id);
        _submit(id);
        _breakRevealed(id, skeptic, Arena.BreakKind.PublicFail, S);
        _windowClosed(id);
        vm.prank(cranker);
        arena.freezeDocket(id);

        // seat1 is the sponsor's organisation; it must not be pickable at all.
        vm.prank(seat1);
        court.declareConflict(sponsor);

        arena.drawPanel(id, 1);
        (address a, address b, address c) = arena.panelSeats(id, 1);
        assertTrue(a != seat1 && b != seat1 && c != seat1, "a seat that declared the sponsor is excluded");
        assertTrue(a != sponsor && a != agent && a != skeptic);
        assertTrue(a != b && b != c && a != c, "three distinct seats");
    }

    function test_745_Draw_FailsClosedWhenNobodyIsRichEnough() public {
        ArgusCourt poor = new ArgusCourt();
        Arena poorArena = new Arena(treasury, address(poor), 0);
        poor.setArena(address(poorArena));
        address pa = makeAddr("pa");
        address pb = makeAddr("pb");
        address pc = makeAddr("pc");
        // A seat under the absolute floor cannot even open.
        vm.deal(pa, 5 ether);
        vm.prank(pa);
        vm.expectRevert(ArgusCourt.BondTooSmall.selector);
        poor.bondSeat{value: 0.001 ether}();
        // Three seats that exist but cannot meet THIS trial's draw floor (0.2): bonded, visible,
        // and never pickable. The panel simply does not form, and the docket waits for O8.
        vm.deal(pb, 5 ether);
        vm.prank(pb);
        poor.bondSeat{value: 0.05 ether}();
        vm.deal(pc, 5 ether);
        vm.prank(pc);
        poor.bondSeat{value: 0.05 ether}();
        assertEq(poor.poolLength(), 2);

        bytes32 poorCommitment = _holdoutCommitment();
        vm.prank(sponsor);
        uint256 id = poorArena.postTrial{value: R + F}(R, SPEC, SUITE, poorCommitment, WINDOW, OPEN_SPAN);
        vm.prank(agent);
        poorArena.claimTrial{value: B}(id);
        vm.prank(agent);
        poorArena.setRunner(id, runner);
        // submit with the real arena's domain would not verify; sign against this one.
        bytes32 runDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                poorArena.DOMAIN(),
                keccak256(
                    abi.encode(
                        poorArena.RUN_TYPEHASH(),
                        bytes32(id),
                        agent,
                        ARTIFACT,
                        VERDICT,
                        REPLAY,
                        HARNESS,
                        uint64(1),
                        SIG_DEADLINE
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, runDigest);
        bytes32 attestDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                poorArena.DOMAIN(),
                keccak256(
                    abi.encode(poorArena.ATTEST_TYPEHASH(), bytes32(id), ARTIFACT, VERDICT, REPLAY, true, SIG_DEADLINE)
                )
            )
        );
        poorArena.setAttestor(attestor, true);
        (uint8 av, bytes32 ar, bytes32 asig) = vm.sign(ATTESTOR_KEY, attestDigest);
        vm.prank(agent);
        poorArena.submitRun(
            id,
            ARTIFACT,
            VERDICT,
            REPLAY,
            HARNESS,
            1,
            SIG_DEADLINE,
            abi.encodePacked(r, s, v),
            abi.encodePacked(ar, asig, av)
        );
        _windowClosedFor(poorArena, id);
        vm.prank(cranker);
        poorArena.freezeDocket(id);

        vm.expectRevert(); // NotEnoughSeats, surfaced through the Arena's external call
        poorArena.drawPanel(id, 1);
    }

    function _windowClosedFor(Arena which, uint256 id) internal {
        uint256 windowEnd = which.windowEndOf(id);
        vm.warp(windowEnd + Params.BREAK_REVEAL_GRACE_SECONDS + 1);
    }

    function test_745_Vote_ASeatThatNeverCommitsIsSlashedForItsOwnBond() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        _breakRevealed(id, skeptic, Arena.BreakKind.PublicFail, S);
        _windowClosed(id);
        vm.prank(cranker);
        arena.freezeDocket(id);
        arena.drawPanel(id, 1);

        bytes memory uphold = hex"00";
        bytes memory reject = hex"01";
        _vote(id, 1, seat1, uphold);
        _vote(id, 1, seat2, uphold);
        // seat3 says nothing at all.
        _pastVoteWindows(id);
        vm.prank(cranker);
        arena.tally(id);

        (uint256 bond,,) = court.bondedOf(seat3);
        assertEq(
            bond,
            SEAT_BOND - (SEAT_BOND * Params.SEAT_SLASH_BPS) / 10000,
            "20% of a no-show's bond, not of its earnings"
        );
        // The arena's treasury credit is the fee plus the void seat's unearned share. The
        // no-show slash is the COURT's money, credited on its own side of the fence.
        // An O3 verdict returns the fee to the sponsor, so the treasury's arena credit is only
        // the bond's remainder plus the share the no-show forfeited. The slash itself is the
        // court's money and lands on the court's side of the ledger.
        assertEq(_credited(treasury), (B - PRIZE - A) + SHARE, "bond remainder plus the forfeited share");
        assertEq(court.credit(treasury), SEAT_BOND * Params.SEAT_SLASH_BPS / 10000, "the no-show slash");
        assertEq(_credited(seat3), 0, "a seat that did not show earns nothing");
        assertTrue(court.conservationHolds(), "the court's own books must still balance");
        _assertConservation("no-show slash");
    }

    function test_745_Vote_ALateRevealIsASlashNotASilentDrop() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        _breakRevealed(id, skeptic, Arena.BreakKind.PublicFail, S);
        _windowClosed(id);
        vm.prank(cranker);
        arena.freezeDocket(id);
        arena.drawPanel(id, 1);

        bytes memory uphold = hex"00";
        _vote(id, 1, seat1, uphold);
        _vote(id, 1, seat2, uphold);

        // seat3 commits inside the window, then sits out the reveal window entirely.
        bytes32 salt = keccak256(abi.encodePacked("vote-salt", seat3));
        bytes32 lateCommitment =
            sha256(abi.encodePacked("CRUCIBLE:vote:v1", bytes32(id), uint8(1), seat3, uphold, REPLAY, salt));
        vm.prank(seat3);
        arena.commitVote(id, lateCommitment);

        uint256 drawnAt = arena.panelDrawnAt(id, 1);
        vm.warp(drawnAt + Params.VOTE_COMMIT_WINDOW_SECONDS + Params.VOTE_REVEAL_WINDOW_SECONDS + 1);
        vm.prank(seat3);
        arena.revealVote(id, 1, uphold, REPLAY, salt); // late: slashed and voided, not silently dropped

        (uint256 bond,,) = court.bondedOf(seat3);
        assertLt(bond, SEAT_BOND);
        assertTrue(arena.voteVoided(id, 1, seat3));
    }

    function test_745_Vote_AMechanicalVoteWithTheWrongReplayHashIsVoid() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        _breakRevealed(id, skeptic, Arena.BreakKind.ReplayMismatch, S);
        _windowClosed(id);
        vm.prank(cranker);
        arena.freezeDocket(id);
        arena.drawPanel(id, 1);

        bytes memory uphold = hex"00";
        // seat1 votes uphold but claims a different replay than the attested one.
        bytes32 salt = keccak256(abi.encodePacked("vote-salt", seat1));
        bytes32 staleReplay = keccak256("a different replay");
        bytes32 ballot =
            sha256(abi.encodePacked("CRUCIBLE:vote:v1", bytes32(id), uint8(1), seat1, uphold, staleReplay, salt));
        vm.prank(seat1);
        arena.commitVote(id, ballot);
        vm.prank(seat1);
        arena.revealVote(id, 1, uphold, keccak256("a different replay"), salt);
        assertTrue(arena.voteVoided(id, 1, seat1), "a mechanical vote that cannot reproduce is void");

        // An abstain-only ballot with a stale hash is not a false measurement, so it stands.
        bytes32 salt2 = keccak256(abi.encodePacked("vote-salt", seat2));
        bytes memory abstain = hex"02";
        bytes32 staleOnly = keccak256("stale");
        bytes32 abstainBallot =
            sha256(abi.encodePacked("CRUCIBLE:vote:v1", bytes32(id), uint8(1), seat2, abstain, staleOnly, salt2));
        vm.prank(seat2);
        arena.commitVote(id, abstainBallot);
        vm.prank(seat2);
        arena.revealVote(id, 1, abstain, keccak256("stale"), salt2);
        assertFalse(arena.voteVoided(id, 1, seat2));
    }

    function test_745_SeatCannotUnbondWhileSittingOnAPanel() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        _breakRevealed(id, skeptic, Arena.BreakKind.PublicFail, S);
        _windowClosed(id);
        vm.prank(cranker);
        arena.freezeDocket(id);
        arena.drawPanel(id, 1);

        vm.prank(seat1);
        vm.expectRevert(ArgusCourt.SeatIsDrawn.selector);
        court.requestUnbond();

        bytes memory uphold = hex"00";
        _vote(id, 1, seat1, uphold);
        _vote(id, 1, seat2, uphold);
        _vote(id, 1, seat3, uphold);
        _pastVoteWindows(id);
        vm.prank(cranker);
        arena.tally(id);

        vm.prank(seat1);
        court.requestUnbond(); // released once the panel closed
        (uint256 bond, uint256 unbondAt, uint256 draws) = court.bondedOf(seat1);
        assertEq(draws, 0);
        assertEq(unbondAt, block.timestamp + Params.SEAT_UNBONDING_SECONDS);
        assertEq(bond, SEAT_BOND);
        vm.warp(unbondAt + 1);
        vm.prank(seat1);
        court.withdrawSeat();
        // Dealt 5, bonded 0.2 out of it, and the bond came back: the fee it earned is still a
        // credit in the arena's ledger, not ETH in this wallet.
        assertEq(seat1.balance, 5 ether);
        assertTrue(court.conservationHolds());
    }

    // ───────────────────────── gate 746 — exits never close ─────────────────────────
    function test_746_Exit_EveryNonTerminalStateHasAPermissionlessCrank() public {
        // Open -> expire by a stranger.
        uint256 a = _post();
        uint256 openUntil = arena.openUntilOf(a);
        vm.warp(openUntil + 1);
        vm.prank(cranker);
        arena.expireTrial(a);
        Arena.Outcome aOutcome = arena.outcomeOf(a);
        assertEq(uint8(aOutcome), uint8(Arena.Outcome.O6), "end state: settled");

        // Claimed -> timeout by a stranger. The span is long enough that the claim deadline
        // lands well before the trial's own expiry, which is the only way the reopen is real:
        // a 2-day trial that times out at its deadline has nowhere to reopen to.
        bytes32 bCommitment = _holdoutCommitment();
        vm.prank(sponsor);
        uint256 b = arena.postTrial{value: R + F}(R, SPEC, SUITE, bCommitment, WINDOW, 20 days);
        _claim(b);
        uint256 claimDeadline = arena.claimDeadlineOf(b);
        vm.warp(claimDeadline + 1);
        vm.prank(cranker);
        arena.claimTimeout(b);
        Arena.Status bStatus = arena.statusOf(b);
        assertEq(uint8(bStatus), uint8(Arena.Status.Open), "end state: the trial is claimable again");

        // Submitted -> O1 by a stranger, with nobody filing.
        uint256 c = _post();
        _claim(c);
        _submit(c);
        _windowClosed(c);
        vm.prank(cranker);
        arena.freezeDocket(c);
        Arena.Outcome cOutcome = arena.outcomeOf(c);
        assertEq(uint8(cOutcome), uint8(Arena.Outcome.O1), "end state: settled");

        // Docketed with a jury that never convenes -> O8 by a stranger, twice.
        uint256 d = _post();
        _claim(d);
        _submit(d);
        _breakRevealed(d, skeptic, Arena.BreakKind.PublicFail, S);
        _windowClosed(d);
        vm.prank(cranker);
        arena.freezeDocket(d);
        _panelVoted(d, hex"00", hex"01", hex"02");
        vm.prank(cranker);
        arena.tally(d); // round 2 armed, no seats commit
        // Round 2 excludes the round-1 jury, so it needs a bench: a pool of three cannot retry.
        _bondSeat(vm.addr(0xE33));
        _bondSeat(vm.addr(0xE44));
        _bondSeat(vm.addr(0xE55));
        uint8 round = arena.roundOf(d);
        assertEq(round, 2);
        arena.drawPanel(d, 2);
        _pastVoteWindows(d); // nobody votes in round 2 either
        vm.prank(cranker);
        arena.tally(d);
        Arena.Outcome dOutcome = arena.outcomeOf(d);
        assertEq(uint8(dOutcome), uint8(Arena.Outcome.O8), "end state: everyone refunded");
        // a expired (R+F), b timed out and REOPENED (forfeit only, the reward still escrowed),
        // c settled O1 (nothing to the sponsor), d hit O8 (R+F back).
        assertEq(
            _credited(sponsor), 2 * (R + F) + 0.02 ether, "the sponsor is made whole twice, plus one timeout forfeit"
        );
        // c paid the agent R + B on O1; b returned the bond less the forfeit; d refunded it whole.
        assertEq(_credited(agent), (R + B) + (B - 0.02 ether) + B, "reward on the clean pass, bonds back elsewhere");
        _assertConservation("nothing stranded");
    }

    function test_746_WithdrawIsTheOnlyDoorAndItCreditedOnly() public {
        uint256 id = _post();
        _claim(id);
        _submit(id);
        _windowClosed(id);
        vm.prank(cranker);
        arena.freezeDocket(id);

        vm.prank(cranker);
        vm.expectRevert(Arena.NothingToWithdraw.selector);
        arena.withdraw();

        uint256 owed = _credited(agent);
        assertEq(owed, R + B);
        uint256 before = agent.balance;
        vm.prank(agent);
        arena.withdraw();
        assertEq(agent.balance - before, owed, "the pull ledger pays exactly what it owes, once");
        assertEq(_credited(agent), 0);
        assertEq(arena.withdrawn(agent), owed);
        _assertConservation("after withdrawal");
    }
}
