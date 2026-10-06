// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Base} from "./Base.t.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";

contract CrucibleTrialsTest is Base {
    // ── creation ──
    function test_CreateTrial_EscrowsReward() public {
        vm.deal(sponsor, REWARD);
        vm.prank(sponsor);
        uint256 id = trials.createTrial{value: REWARD}(SPEC, TESTS, uint64(block.timestamp + 2 days), WINDOW);
        CrucibleTrials.Trial memory t = trials.getTrial(id);
        assertEq(t.sponsor, sponsor);
        assertEq(t.reward, REWARD);
        assertEq(t.bond, 0.2 ether);
        assertEq(uint8(t.status), uint8(CrucibleTrials.Status.Open));
        assertEq(address(trials).balance, REWARD);
    }

    function test_CreateTrial_RevertTooSmall() public {
        vm.deal(sponsor, 0.001 ether);
        vm.prank(sponsor);
        vm.expectRevert(CrucibleTrials.RewardTooSmall.selector);
        trials.createTrial{value: 0.001 ether}(SPEC, TESTS, uint64(block.timestamp + 2 days), WINDOW);
    }

    function test_CreateTrial_RevertBadWindow() public {
        vm.deal(sponsor, REWARD);
        vm.prank(sponsor);
        vm.expectRevert(CrucibleTrials.BadWindow.selector);
        trials.createTrial{value: REWARD}(SPEC, TESTS, uint64(block.timestamp + 2 days), 30 minutes);
    }

    function test_CreateTrial_RevertBadDeadline() public {
        vm.deal(sponsor, REWARD);
        vm.prank(sponsor);
        vm.expectRevert(CrucibleTrials.BadDeadline.selector);
        trials.createTrial{value: REWARD}(SPEC, TESTS, uint64(block.timestamp + 1 minutes), WINDOW);
    }

    // ── registration & claim ──
    function test_RegisterAgent_AndClaim() public {
        vm.deal(sponsor, REWARD);
        vm.prank(sponsor);
        uint256 id = trials.createTrial{value: REWARD}(SPEC, TESTS, uint64(block.timestamp + 2 days), WINDOW);
        uint256 aid = _register(1 ether);
        vm.prank(operator);
        trials.claimTrial(id);
        assertEq(uint8(trials.getTrial(id).status), uint8(CrucibleTrials.Status.Assigned));
        assertEq(trials.getAgent(aid).stake, 0.8 ether); // 1.0 − 0.2 bond
        assertEq(trials.escrowed(), REWARD + 0.2 ether);
        assertEq(trials.totalStakes(), 0.8 ether);
    }

    function test_RegisterAgent_RevertTwice() public {
        _register(1 ether);
        // top up first: the revert must be AlreadyRegistered, not OutOfFunds
        vm.deal(operator, 1 ether);
        vm.prank(operator);
        vm.expectRevert(CrucibleTrials.AlreadyRegistered.selector);
        trials.registerAgent{value: 1 ether}("ipfs://manifest", runner);
    }

    function test_Claim_RevertInsufficientStake() public {
        vm.deal(sponsor, REWARD);
        vm.prank(sponsor);
        uint256 id = trials.createTrial{value: REWARD}(SPEC, TESTS, uint64(block.timestamp + 2 days), WINDOW);
        _register(0.05 ether); // stake < 0.2 bond
        vm.prank(operator);
        vm.expectRevert(CrucibleTrials.StakeTooSmall.selector);
        trials.claimTrial(id);
    }

    /// The real first-come-first-served property: a *second, independent* agent
    /// (different operator, own stake, own runner key) is locked out of a claimed
    /// trial. The old version re-claimed from the same operator, which trivially
    /// reverted on status and never exercised the cross-agent path.
    function test_Claim_RevertSecondIndependentAgent() public {
        (uint256 id,) = _liveTrial(); // operator claims first
        address op2 = makeAddr("operator2");
        uint256 runnerKey2 = 0xB0B;
        vm.deal(op2, 1 ether);
        vm.prank(op2);
        uint256 aid2 = trials.registerAgent{value: 1 ether}("ipfs://manifest2", vm.addr(runnerKey2));
        assertGt(aid2, 0);
        assertTrue(op2 != operator);

        vm.prank(op2);
        vm.expectRevert(CrucibleTrials.NotOpen.selector);
        trials.claimTrial(id);

        // the first agent still owns it
        assertEq(trials.getTrial(id).agentId, trials.agentIdOf(operator));
        assertEq(trials.getAgent(trials.agentIdOf(operator)).active, 1);
        assertEq(trials.getAgent(aid2).active, 0);
        assertEq(trials.getAgent(aid2).stake, 1 ether); // loser was not penalised
    }

    function test_Claim_RevertSameOperatorTwice() public {
        (uint256 id,) = _liveTrial();
        vm.prank(operator);
        vm.expectRevert(CrucibleTrials.NotOpen.selector);
        trials.claimTrial(id);
    }

    function test_Claim_RevertAfterDeadline() public {
        vm.deal(sponsor, REWARD);
        vm.prank(sponsor);
        uint256 id = trials.createTrial{value: REWARD}(SPEC, TESTS, uint64(block.timestamp + 2 days), WINDOW);
        _register(1 ether);
        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(operator);
        vm.expectRevert(CrucibleTrials.DeadlinePassed.selector);
        trials.claimTrial(id);
    }

    function test_Claim_RevertNotAnAgent() public {
        vm.deal(sponsor, REWARD);
        vm.prank(sponsor);
        uint256 id = trials.createTrial{value: REWARD}(SPEC, TESTS, uint64(block.timestamp + 2 days), WINDOW);
        vm.prank(skeptic);
        vm.expectRevert(CrucibleTrials.NotAnAgent.selector);
        trials.claimTrial(id);
    }

    function test_SetRunner_AndSubmitWithNewKey() public {
        (uint256 id, uint256 aid) = _liveTrial();
        uint256 newKey = 0xB0B;
        address newRunner = vm.addr(newKey);
        vm.prank(operator);
        trials.setRunner(aid, newRunner);

        uint64 sd = uint64(block.timestamp + 10 minutes);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(newKey, _digest(id, aid, RUN, sd));
        vm.prank(relayer);
        trials.submitRun(id, RUN, abi.encodePacked(r, s, v), sd);
        assertEq(uint8(trials.getTrial(id).status), uint8(CrucibleTrials.Status.Judging));
    }

    // ── run submission & EIP-712 ──
    function test_SubmitRun_ValidSig_PermissionlessRelay() public {
        (uint256 id,) = _liveTrial();
        _submitRun(id); // submitted by `relayer`, authorized by runner's signature
        assertEq(uint8(trials.getTrial(id).status), uint8(CrucibleTrials.Status.Judging));
    }

    function test_SubmitRun_RevertWrongSigner() public {
        (uint256 id, uint256 aid) = _liveTrial();
        uint64 sd = uint64(block.timestamp + 10 minutes);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, _digest(id, aid, RUN, sd));
        vm.prank(relayer);
        vm.expectRevert(CrucibleTrials.BadSigner.selector);
        trials.submitRun(id, RUN, abi.encodePacked(r, s, v), sd);
    }

    function test_SubmitRun_RevertSigForOtherTrial() public {
        (uint256 id, uint256 aid) = _liveTrial();
        // second agent/operator: one agent per operator, so the first operator can't re-register
        (uint256 id2,) = _liveTrialSecondAgent();
        uint64 sd = uint64(block.timestamp + 10 minutes);
        // sig bound to id2
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, _digest(id2, aid, RUN, sd));
        vm.prank(relayer);
        vm.expectRevert(CrucibleTrials.BadSigner.selector);
        trials.submitRun(id, RUN, abi.encodePacked(r, s, v), sd);
    }

    function test_SubmitRun_RevertReplay() public {
        (uint256 id,) = _liveTrial();
        uint64 sd = uint64(block.timestamp + 10 minutes);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, _digest(id, trials.getTrial(id).agentId, RUN, sd));
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.prank(relayer);
        trials.submitRun(id, RUN, sig, sd); // ok once
        vm.prank(relayer);
        vm.expectRevert(CrucibleTrials.NotAssigned.selector); // replay blocked by status
        trials.submitRun(id, RUN, sig, sd);
    }

    function test_SubmitRun_RevertSigExpired() public {
        (uint256 id, uint256 aid) = _liveTrial();
        uint64 sd = uint64(block.timestamp + 10 minutes);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, _digest(id, aid, RUN, sd));
        vm.warp(sd + 1);
        vm.prank(relayer);
        vm.expectRevert(CrucibleTrials.SigExpired.selector);
        trials.submitRun(id, RUN, abi.encodePacked(r, s, v), sd);
    }

    function test_SubmitRun_RevertAfterDeadline() public {
        (uint256 id, uint256 aid) = _liveTrial();
        uint64 sd = uint64(block.timestamp + 3 days);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, _digest(id, aid, RUN, sd));
        vm.warp(trials.deadlineOf(id));
        vm.prank(relayer);
        vm.expectRevert(CrucibleTrials.DeadlinePassed.selector);
        trials.submitRun(id, RUN, abi.encodePacked(r, s, v), sd);
    }

    function test_SubmitRun_RevertMalleableSig() public {
        (uint256 id, uint256 aid) = _liveTrial();
        uint64 sd = uint64(block.timestamp + 10 minutes);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, _digest(id, aid, RUN, sd));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 sBad = bytes32(n - uint256(s)); // s' > n/2
        vm.prank(relayer);
        vm.expectRevert(CrucibleTrials.SigMalleable.selector);
        trials.submitRun(id, RUN, abi.encodePacked(r, sBad, v), sd);
    }

    function test_SubmitRun_RevertMalformedSig() public {
        (uint256 id,) = _liveTrial();
        vm.prank(relayer);
        vm.expectRevert(CrucibleTrials.BadSig.selector);
        trials.submitRun(id, RUN, hex"1234", uint64(block.timestamp + 10 minutes));
    }

    // ── happy path: no break ──
    function test_Finalize_NoBreak_PaysAgentMinusFee_MintsIron() public {
        (uint256 id, uint256 aid) = _liveTrial();
        _submitRun(id);
        vm.warp(block.timestamp + WINDOW + 1);
        trials.finalize(id);
        assertEq(trials.credit(operator), 0.95 ether); // 1.0 − 5%
        assertEq(trials.credit(trials.treasury()), 0.05 ether);
        assertEq(trials.getAgent(aid).stake, 1 ether); // bond returned
        assertEq(uint8(trials.getTrial(id).verdict), uint8(CrucibleTrials.Verdict.Paid));
        assertEq(alloy.tierOf(aid), 1); // Iron
        assertTrue(alloy.locked(aid)); // soulbound
        assertEq(alloy.ownerOf(aid), operator);
        assertEq(trials.escrowed(), 0);
    }

    function test_Finalize_RevertTwice() public {
        (uint256 id,) = _liveTrial();
        _submitRun(id);
        vm.warp(block.timestamp + WINDOW + 1);
        trials.finalize(id);
        vm.expectRevert(CrucibleTrials.NotFinalizable.selector);
        trials.finalize(id);
    }

    // ── skeptics ──
    function test_FileBreak_LocksAndEscrows() public {
        (uint256 id,) = _liveTrial();
        _submitRun(id);
        _fileBreak(id);
        CrucibleTrials.Trial memory t = trials.getTrial(id);
        assertEq(uint8(t.status), uint8(CrucibleTrials.Status.Challenged));
        assertEq(t.breakSkeptic, skeptic);
        assertEq(trials.escrowed(), REWARD + 0.2 ether + 0.01 ether);
    }

    function test_FileBreak_RevertStakeTooSmall() public {
        (uint256 id,) = _liveTrial();
        _submitRun(id);
        vm.deal(skeptic, 1 ether);
        vm.prank(skeptic);
        vm.expectRevert(CrucibleTrials.StakeTooSmall.selector);
        trials.fileBreak{value: 0.001 ether}(id, keccak256("proof"));
    }

    function test_FileBreak_RevertSecondBreak() public {
        (uint256 id,) = _liveTrial();
        _submitRun(id);
        _fileBreak(id);
        vm.deal(relayer, 1 ether);
        vm.prank(relayer);
        vm.expectRevert(CrucibleTrials.NotJudging.selector); // one break slot per trial
        trials.fileBreak{value: 0.01 ether}(id, keccak256("proof2"));
    }

    function test_FileBreak_RevertAfterWindow() public {
        (uint256 id,) = _liveTrial();
        _submitRun(id);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.deal(skeptic, 1 ether);
        vm.prank(skeptic);
        vm.expectRevert(CrucibleTrials.WindowClosed.selector);
        trials.fileBreak{value: 0.01 ether}(id, keccak256("proof"));
    }

    function test_Finalize_RevertWhileWindowOpen() public {
        (uint256 id,) = _liveTrial();
        _submitRun(id);
        vm.expectRevert(CrucibleTrials.WindowOpen.selector);
        trials.finalize(id);
    }

    // ── dispute: break FAILS → agent paid, skeptic stake split ──
    function test_Dispute_BreakFails_AgentPaid_SkepticSplit() public {
        (uint256 id, uint256 aid) = _liveTrial();
        _submitRun(id);
        _fileBreak(id);
        _resolve(id, false); // 2/3 Argus: run survives
        assertEq(trials.credit(operator), 0.95 ether + 0.005 ether); // payout + half skeptic stake
        assertEq(trials.credit(trials.treasury()), 0.05 ether + 0.005 ether);
        assertEq(trials.credit(skeptic), 0);
        assertEq(trials.getAgent(aid).stake, 1 ether);
        assertEq(uint8(trials.getTrial(id).verdict), uint8(CrucibleTrials.Verdict.Paid));
        assertEq(survivedOf(aid), 1); // survived a break attempt → counts to Steel
    }

    // ── dispute: break WINS → slash 30/70, sponsor refunded ──
    function test_Dispute_BreakWins_Slashed() public {
        (uint256 id, uint256 aid) = _liveTrial();
        _submitRun(id);
        _fileBreak(id);
        _resolve(id, true);
        CrucibleTrials.Trial memory t = trials.getTrial(id);
        assertEq(uint8(t.verdict), uint8(CrucibleTrials.Verdict.Slashed));
        assertEq(trials.credit(sponsor), 1 ether); // reward refunded
        assertEq(trials.credit(skeptic), 0.06 ether + 0.01 ether); // 30% bond + own stake back
        assertEq(trials.credit(trials.treasury()), 0.14 ether); // 70% bond
        assertEq(trials.getAgent(aid).stake, 0.8 ether); // bond gone
        assertEq(slashesOf(aid), 1);
        assertEq(trials.escrowed(), 0);
    }

    function test_Dispute_RevertNonArgus() public {
        (uint256 id,) = _liveTrial();
        _submitRun(id);
        _fileBreak(id);
        vm.prank(skeptic);
        vm.expectRevert(CrucibleTrials.NotArgus.selector);
        trials.commitVote(id, keccak256("x"));
    }

    function test_Dispute_RevertDoubleCommit() public {
        (uint256 id,) = _liveTrial();
        _submitRun(id);
        _fileBreak(id);
        vm.prank(a1);
        trials.commitVote(id, keccak256("c"));
        vm.prank(a1);
        vm.expectRevert(CrucibleTrials.AlreadyCommitted.selector);
        trials.commitVote(id, keccak256("c2"));
    }

    function test_Dispute_RevertDoubleReveal() public {
        (uint256 id,) = _liveTrial();
        _submitRun(id);
        _fileBreak(id);
        bytes32 salt = keccak256("salt");
        bool breakWins = true;
        bytes32 commit = keccak256(abi.encodePacked(id, breakWins, salt));
        vm.prank(a1);
        trials.commitVote(id, commit);
        vm.prank(a2);
        trials.commitVote(id, commit);
        vm.prank(a1);
        trials.revealVote(id, breakWins, salt); // settles at 1 vote? no — threshold is 2
        vm.prank(a1);
        vm.expectRevert(CrucibleTrials.AlreadyRevealed.selector);
        trials.revealVote(id, breakWins, salt);
    }

    function test_Dispute_RevertRevealWithoutCommit() public {
        (uint256 id,) = _liveTrial();
        _submitRun(id);
        _fileBreak(id);
        vm.prank(a1);
        vm.expectRevert(CrucibleTrials.CommitMismatch.selector);
        trials.revealVote(id, false, keccak256("salt"));
    }

    function test_Dispute_CommitMismatch() public {
        (uint256 id,) = _liveTrial();
        _submitRun(id);
        _fileBreak(id);
        vm.prank(a1);
        trials.commitVote(id, keccak256(abi.encodePacked(id, true, keccak256("s1"))));
        vm.prank(a1);
        vm.expectRevert(CrucibleTrials.CommitMismatch.selector);
        trials.revealVote(id, true, keccak256("WRONG"));
    }

    function test_Dispute_RevealLockedAfterFirstReveal() public {
        (uint256 id,) = _liveTrial();
        _submitRun(id);
        _fileBreak(id);
        bytes32 salt = keccak256("salt");
        vm.prank(a1);
        trials.commitVote(id, keccak256(abi.encodePacked(id, false, salt)));
        vm.prank(a2);
        trials.commitVote(id, keccak256(abi.encodePacked(id, false, salt)));
        vm.prank(a1);
        trials.revealVote(id, false, salt);
        vm.prank(a3); // late commit after reveal phase started
        vm.expectRevert(CrucibleTrials.RevealClosed.selector);
        trials.commitVote(id, keccak256(abi.encodePacked(id, false, salt)));
    }

    function test_Dispute_FinalizeRevertBeforeTimeout() public {
        (uint256 id,) = _liveTrial();
        _submitRun(id);
        _fileBreak(id);
        vm.expectRevert(CrucibleTrials.DisputeUnresolved.selector);
        trials.finalize(id);
    }

    function test_Dispute_Timeout_DefaultsToAgentWin() public {
        (uint256 id,) = _liveTrial();
        _submitRun(id);
        _fileBreak(id);
        vm.warp(block.timestamp + trials.DISPUTE_TIMEOUT() + 1);
        trials.finalize(id); // skeptic failed to prove in time
        assertEq(uint8(trials.getTrial(id).verdict), uint8(CrucibleTrials.Verdict.Paid));
        // a failed break costs the skeptic their whole stake: half to the agent, half to treasury
        assertEq(trials.credit(skeptic), 0);
        assertEq(trials.credit(operator), 0.95 ether + 0.005 ether);
        assertEq(trials.credit(trials.treasury()), 0.05 ether + 0.005 ether);
    }

    // ── reclaim & ledger ──
    function test_ReclaimExpired_NoRun_SponsorRefund() public {
        (uint256 id, uint256 aid) = _liveTrial();
        vm.warp(block.timestamp + 2 days + 1);
        trials.reclaimExpired(id);
        assertEq(uint8(trials.getTrial(id).verdict), uint8(CrucibleTrials.Verdict.Refunded));
        assertEq(trials.credit(sponsor), 1 ether);
        assertEq(trials.getAgent(aid).stake, 1 ether); // bond returned, no penalty
        assertEq(alloy.tierOf(aid), 0); // no win recorded
        assertEq(trials.escrowed(), 0);
    }

    function test_Reclaim_RevertBeforeDeadline() public {
        (uint256 id,) = _liveTrial();
        vm.expectRevert(CrucibleTrials.DeadlineNotPassed.selector);
        trials.reclaimExpired(id);
    }

    /**
     * This test used to assert that reclaiming an *unclaimed* trial reverts — which was the
     * fund lock, written down as an expectation. The cases that must still refuse are "too
     * early" and "already settled", and they are what is checked now.
     */
    function test_Reclaim_RevertBeforeDeadlineAndAfterSettlement() public {
        vm.deal(sponsor, REWARD);
        vm.prank(sponsor);
        uint256 id = trials.createTrial{value: REWARD}(SPEC, TESTS, uint64(block.timestamp + 2 days), WINDOW);

        vm.expectRevert(CrucibleTrials.DeadlineNotPassed.selector);
        trials.reclaimExpired(id);

        vm.warp(block.timestamp + 2 days + 1);
        trials.reclaimExpired(id);

        vm.expectRevert(CrucibleTrials.NotReclaimable.selector);
        trials.reclaimExpired(id);
    }

    function test_Withdraw_PullPattern() public {
        (uint256 id,) = _liveTrial();
        _submitRun(id);
        vm.warp(block.timestamp + WINDOW + 1);
        trials.finalize(id);
        vm.prank(operator);
        trials.withdraw();
        assertEq(operator.balance, 0.95 ether);
        assertEq(trials.credit(operator), 0);
    }

    function test_Withdraw_RevertNothing() public {
        vm.deal(operator, 1 ether);
        vm.prank(operator);
        vm.expectRevert(CrucibleTrials.NothingToWithdraw.selector);
        trials.withdraw();
    }

    function test_Unstake_ThenWithdraw() public {
        uint256 aid = _register(1 ether);
        vm.prank(operator);
        trials.unstake(aid, 0.4 ether);
        assertEq(trials.getAgent(aid).stake, 0.6 ether);
        vm.prank(operator);
        trials.withdraw();
        assertEq(operator.balance, 0.4 ether);
    }

    function test_Unstake_RevertNonOperator() public {
        uint256 aid = _register(1 ether);
        vm.prank(skeptic);
        vm.expectRevert(CrucibleTrials.NotOperator.selector);
        trials.unstake(aid, 0.1 ether);
    }

    function test_Unstake_RevertTooMuch() public {
        uint256 aid = _register(1 ether);
        vm.prank(operator);
        vm.expectRevert(CrucibleTrials.StakeTooSmall.selector);
        trials.unstake(aid, 1 ether + 1);
    }

    // ── ledger conservation: nothing can leak or appear from nothing ──
    function test_Conservation_AfterPaidVerdict() public {
        (uint256 id,) = _liveTrial();
        uint256 aid = trials.getTrial(id).agentId;
        _submitRun(id);
        vm.warp(block.timestamp + WINDOW + 1);
        trials.finalize(id);
        assertEq(address(trials).balance, trials.totalStakes() + trials.totalPending() + trials.escrowed());
        assertEq(trials.escrowed(), 0);
        assertEq(trials.totalPending(), trials.credit(operator) + trials.credit(trials.treasury()));
        assertEq(trials.totalStakes(), trials.getAgent(aid).stake);
    }

    function test_Conservation_AfterSlash() public {
        (uint256 id,) = _liveTrial();
        _submitRun(id);
        _fileBreak(id);
        _resolve(id, true);
        assertEq(address(trials).balance, trials.totalStakes() + trials.totalPending() + trials.escrowed());
        assertEq(trials.escrowed(), 0);
        assertEq(
            trials.totalPending(), trials.credit(sponsor) + trials.credit(skeptic) + trials.credit(trials.treasury())
        );
    }

    /// `records` is a public mapping to a struct, so it returns a tuple
    /// (wins, survived, slashes, tier), not a struct.
    function survivedOf(uint256 agentId) internal view returns (uint32) {
        (, uint32 survived,,) = alloy.records(agentId);
        return survived;
    }

    function slashesOf(uint256 agentId) internal view returns (uint32) {
        (,, uint32 slashes,) = alloy.records(agentId);
        return slashes;
    }

    // ── fuzz: bond floor & fee math ──
    /// the packed-timestamp accessors must round-trip exactly, since deadline/breakWindow
    /// gate every window check in the contract
    function test_TimestampPacking_RoundTrips() public {
        (uint256 id,) = _liveTrial();
        _submitRun(id);
        uint64 created = trials.createdAtOf(id);
        uint64 deadline = trials.deadlineOf(id);
        uint64 win = trials.breakWindowOf(id);
        uint64 runAt = trials.runAtOf(id);

        assertEq(win, WINDOW);
        assertEq(runAt, uint64(block.timestamp));
        assertGt(deadline, created);
        assertEq(deadline - created, 2 days);

        // the raw word is exactly the four values, nothing else
        uint256 word = trials.getTrial(id).timestamps;
        assertEq(uint64(word), created);
        assertEq(uint64(word >> 64), deadline);
        assertEq(uint64(word >> 128), win);
        assertEq(uint64(word >> 192), runAt);
    }

    /// _setRunAt must not clobber the other three timestamps
    function test_TimestampPacking_SetRunAtPreservesOthers() public {
        (uint256 id,) = _liveTrial();
        uint64 created = trials.createdAtOf(id);
        uint64 deadline = trials.deadlineOf(id);
        uint64 win = trials.breakWindowOf(id);

        _submitRun(id);

        assertEq(trials.createdAtOf(id), created);
        assertEq(trials.deadlineOf(id), deadline);
        assertEq(trials.breakWindowOf(id), win);
    }

    function testFuzz_BondFloor(uint128 reward) public view {
        reward = uint128(bound(reward, 0.01 ether, 1000 ether));
        uint256 b = trials.bondFor(reward);
        assertTrue(b >= trials.MIN_BOND());
        assertEq(b, trials.bondFor(reward)); // deterministic
        if (reward >= 5 * trials.MIN_BOND()) assertEq(b, reward / 5);
        else assertEq(b, trials.MIN_BOND());
    }

    function testFuzz_FeeMath(uint128 reward) public {
        reward = uint128(bound(reward, 0.01 ether, 100 ether));
        vm.deal(sponsor, reward);
        vm.prank(sponsor);
        uint256 id = trials.createTrial{value: reward}(SPEC, TESTS, uint64(block.timestamp + 2 days), WINDOW);
        _register(1000 ether);
        vm.prank(operator);
        trials.claimTrial(id);
        _submitRun(id);
        vm.warp(block.timestamp + WINDOW + 1);
        trials.finalize(id);
        assertEq(trials.credit(operator), reward - (reward * 500) / 10_000);
        assertEq(trials.credit(trials.treasury()), (reward * 500) / 10_000);
    }

    function testFuzz_SlashNeverExceedsBond(uint128 reward, uint8 wins) public {
        reward = uint128(bound(reward, 0.05 ether, 20 ether));
        wins = uint8(bound(wins, 1, 25));
        vm.deal(sponsor, reward);
        vm.prank(sponsor);
        uint256 id = trials.createTrial{value: reward}(SPEC, TESTS, uint64(block.timestamp + 2 days), WINDOW);
        uint256 aid = _register(1000 ether);
        vm.prank(operator);
        trials.claimTrial(id);
        _submitRun(id);
        _fileBreakExact(id); // stakes the 1% floor, which scales with reward
        _resolve(id, true);
        uint256 bond = uint256(trials.bondFor(reward));
        uint256 bStake = uint256(trials.getTrial(id).breakStake);
        // skeptic takes 30% of the bond back plus their own stake; the treasury takes the other 70%
        assertEq(trials.credit(skeptic), bond * trials.SLASH_SKEPTIC_NUM() / trials.BPS() + bStake);
        assertEq(trials.credit(trials.treasury()), bond - bond * trials.SLASH_SKEPTIC_NUM() / trials.BPS());
        assertLe(trials.credit(skeptic), bond + bStake); // slashing never exceeds the bond
        assertGe(trials.getAgent(aid).stake, 1000 ether - bond);
    }
    // ── an abandoned trial must not become a trap ─────────────────────────
    /**
     * A trial nobody claimed used to be a one-way door: `finalize` needs a submitted run,
     * `claimTrial` is closed past the deadline, and `reclaimExpired` demanded `Assigned`.
     * The reward stayed in escrow forever, so a sponsor that priced a job too high to
     * attract an agent lost the whole amount to its own optimism.
     */
    function test_Reclaim_UnclaimedTrialReturnsTheReward() public {
        vm.deal(sponsor, REWARD);
        vm.prank(sponsor);
        uint256 id = trials.createTrial{value: REWARD}(SPEC, TESTS, uint64(block.timestamp + 2 days), WINDOW);
        assertEq(trials.escrowed(), REWARD, "reward should be the only thing escrowed");

        vm.warp(block.timestamp + 3 days);
        trials.reclaimExpired(id); // permissionless, like finalize

        assertEq(uint8(trials.getTrial(id).status), uint8(CrucibleTrials.Status.Settled));
        assertEq(uint8(trials.getTrial(id).verdict), uint8(CrucibleTrials.Verdict.Refunded));
        assertEq(trials.credit(sponsor), REWARD);
        assertEq(trials.escrowed(), 0, "nothing may remain escrowed once reclaimed");
        assertEq(address(trials).balance, REWARD, "the ETH is owed, not yet withdrawn");
    }

    /**
     * The unclaimed path has no agent, so it must not touch agent accounting at all. The
     * old shared body would have run `agents[0].active -= 1` against the zero agent.
     */
    function test_Reclaim_UnclaimedTrialTouchesNoAgent() public {
        vm.deal(sponsor, REWARD);
        vm.prank(sponsor);
        uint256 id = trials.createTrial{value: REWARD}(SPEC, TESTS, uint64(block.timestamp + 2 days), WINDOW);
        uint256 aid = _register(1 ether);
        uint256 stakeBefore = trials.getAgent(aid).stake;

        vm.warp(block.timestamp + 3 days);
        trials.reclaimExpired(id);

        assertEq(trials.getAgent(aid).stake, stakeBefore, "an unclaimed trial owes no bond");
        assertEq(trials.getAgent(aid).active, 0);
        assertEq(trials.totalStakes(), 1 ether, "the registered stake was never at risk");
    }

    function test_Reclaim_BondStillReturnsToTheAgentWhenClaimed() public {
        (uint256 id, uint256 aid) = _liveTrial();
        assertEq(trials.escrowed(), REWARD + 0.2 ether, "reward plus bond");

        vm.warp(block.timestamp + 3 days);
        trials.reclaimExpired(id);

        assertEq(trials.escrowed(), 0);
        assertEq(trials.credit(sponsor), REWARD);
        assertEq(trials.getAgent(aid).stake, 1 ether, "the bond comes back");
        assertEq(trials.getAgent(aid).active, 0);
    }

    // ── nobody may attack their own trial ─────────────────────────────────
    /**
     * A sponsor filing a break against its own trial buys a "survived an attack" record —
     * the only gate between Iron and Steel — for 1% of a reward it then gets back, plus the
     * skeptic stake it also paid itself. It is net positive before the reputation is worth
     * anything, which is exactly why it has to be a revert rather than a discouragement.
     */
    function test_FileBreak_RevertSponsorSelfBreak() public {
        (uint256 id,) = _liveTrial();
        _submitRun(id);
        vm.deal(sponsor, 1 ether);
        vm.prank(sponsor);
        vm.expectRevert(CrucibleTrials.SelfBreak.selector);
        trials.fileBreak{value: 0.01 ether}(id, keccak256("my own trial, my own attack"));
    }

    function test_FileBreak_RevertOperatorSelfBreak() public {
        (uint256 id,) = _liveTrial();
        _submitRun(id);
        vm.deal(operator, 1 ether);
        vm.prank(operator);
        vm.expectRevert(CrucibleTrials.SelfBreak.selector);
        trials.fileBreak{value: 0.01 ether}(id, keccak256("attacking my own run to move the stake"));
    }

    function test_FileBreak_UnrelatedSkepticStillBreaks() public {
        // The guard must not become a wall: a third party is the whole point of the role.
        (uint256 id,) = _liveTrial();
        _submitRun(id);
        _fileBreak(id);
        assertEq(uint8(trials.getTrial(id).status), uint8(CrucibleTrials.Status.Challenged));
    }

}
