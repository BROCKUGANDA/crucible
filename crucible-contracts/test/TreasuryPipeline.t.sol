// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";
import {AlloyRegistry} from "../contracts/AlloyRegistry.sol";

/// @title Treasury pipeline — the whole money journey, end to end.
///
/// @dev The mainnet release gate's first question is "where does the money go, and who can
/// move it?" These tests answer it by walking ETH through every settlement outcome on a
/// deployment whose treasury is a *distinct company address* — never the deployer — and
/// proving at each step:
///
///   1. The protocol fee lands as a pull credit on the configured treasury, and on nothing
///      else. Settlement never pushes ETH (ADR-0003); `withdraw()` is the only exit.
///   2. The conservation invariant `balance == totalStakes + totalPending + escrowed` holds
///      after every state transition, not just in the fuzz harness.
///   3. A withdrawal is permissionless to *trigger* but impossible to *steer*: any caller
///      can empty only their own credit, and a second pull finds nothing.
///   4. A refunded sponsor pays no fee — the protocol earns only on outcomes it actually
///      judged.
///
/// This is the local, deterministic proof behind T1/T2/T5 of the treasury security
/// workstream; the on-chain half (a Safe signing the withdrawal on a real network) stays
/// behind the mainnet preflight, which needs the company Safe that does not exist yet.
contract TreasuryPipelineTest is Test {
    CrucibleTrials trials;
    AlloyRegistry alloy;

    uint256 constant RUNNER_KEY = 0xA11CE;
    uint256 constant REWARD = 1 ether; // bond = 0.2 ether, min break stake = 0.01 ether
    uint64 constant WINDOW = 12 hours;

    /// The deployer/test contract is the owner; the treasury is a separate company
    /// address. A deployment where these coincide is exactly what the release gate refuses.
    address companyTreasury = makeAddr("company-treasury-safe");
    address sponsor = makeAddr("sponsor");
    address operator = makeAddr("operator");
    address skeptic = makeAddr("skeptic");
    address relayer = makeAddr("relayer");
    address a1 = makeAddr("argus1");
    address a2 = makeAddr("argus2");
    address a3 = makeAddr("argus3");
    address runner = vm.addr(RUNNER_KEY);

    bytes32 constant SPEC = keccak256("spec");
    bytes32 constant TESTS = keccak256("tests");
    bytes32 constant RUN = keccak256("RunArtifact{all-pass}");

    function setUp() public {
        address[] memory seats = new address[](3);
        seats[0] = a1;
        seats[1] = a2;
        seats[2] = a3;
        alloy = new AlloyRegistry();
        trials = new CrucibleTrials(companyTreasury, address(this), address(alloy), seats);
        alloy.setForge(address(trials));
        assertEq(trials.treasury(), companyTreasury, "treasury is the configured company address");
        assertNotEq(trials.treasury(), address(this), "treasury is not the deployer/owner");
        assertEq(address(trials).balance, 0, "a fresh escrow holds nothing");
    }

    function _assertBooks(string memory phase) internal view {
        assertEq(address(trials).balance, trials.totalStakes() + trials.totalPending() + trials.escrowed(), phase);
    }

    function _register(uint256 stake) internal returns (uint256 aid) {
        return _registerAs(operator, stake);
    }

    function _registerAs(address op, uint256 stake) internal returns (uint256 aid) {
        vm.deal(op, stake);
        vm.prank(op);
        aid = trials.registerAgent{value: stake}("ipfs://manifest", runner);
    }

    function _fundAndClaim() internal returns (uint256 id, uint256 aid) {
        return _fundAndClaimAs(operator);
    }

    function _fundAndClaimAs(address op) internal returns (uint256 id, uint256 aid) {
        vm.deal(sponsor, REWARD);
        vm.prank(sponsor);
        id = trials.createTrial{value: REWARD}(REWARD, SPEC, TESTS, uint64(block.timestamp + 2 days), WINDOW);
        aid = _registerAs(op, 1 ether);
        vm.prank(op);
        trials.claimTrial(id);
        _assertBooks("after claim");
        return (id, aid);
    }

    function _digest(uint256 id, uint256 aid, bytes32 runHash, uint64 sigDeadline) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01", trials.DOMAIN(), keccak256(abi.encode(trials.RUN_TYPEHASH(), id, aid, runHash, sigDeadline))
            )
        );
    }

    function _submitRun(uint256 id) internal {
        uint256 aid = trials.getTrial(id).agentId;
        uint64 sd = uint64(block.timestamp + 10 minutes);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, _digest(id, aid, RUN, sd));
        vm.prank(relayer);
        trials.submitRun(id, RUN, abi.encodePacked(r, s, v), sd);
    }

    function _expectedFee() internal view returns (uint256) {
        return (REWARD * trials.FEE_BPS()) / trials.BPS();
    }

    // ───────────────────────── the win path ─────────────────────────

    function test_Win_FeeCreditsTheConfiguredTreasury_AndOnlyWithdrawMovesIt() public {
        (uint256 id,) = _fundAndClaim();
        _submitRun(id);
        uint256 fee = _expectedFee();

        // Nobody is owed anything yet: the reward is escrowed, not earned.
        assertEq(trials.credit(companyTreasury), 0, "no fee before settlement");
        assertEq(companyTreasury.balance, 0, "settlement has not run, treasury holds nothing");

        // Silence past the skeptic window is acceptance; anyone may finalize.
        uint256 windowEnd = trials.runAtOf(id) + trials.breakWindowOf(id);
        vm.warp(windowEnd + 1);
        trials.finalize(id);

        uint256 agentCredit = trials.credit(operator);
        assertEq(agentCredit, REWARD - fee, "agent earns reward minus the 5% fee");
        assertEq(trials.credit(companyTreasury), fee, "treasury credit is exactly the 5% fee");
        (,,, uint256 freedBond,) = trials.agents(trials.getTrial(id).agentId);
        assertEq(freedBond, 1 ether, "full stake restored: 0.8 free + 0.2 bond returned");
        _assertBooks("after win settlement");

        // The treasury pulls its fee. The ETH arrives at the company address and only there.
        uint256 before = companyTreasury.balance;
        vm.prank(companyTreasury);
        trials.withdraw();
        assertEq(companyTreasury.balance - before, fee, "withdraw delivers exactly the fee");
        assertEq(trials.credit(companyTreasury), 0, "the pull zeroes the credit");
        assertEq(address(trials).balance, REWARD + 1 ether - fee, "escrow paid out the fee");
        _assertBooks("after treasury withdraw");

        // The agent pulls their own payout. There is no relay here: withdraw() pays the
        // CALLER.S credit and nothing else, so the relayer that finalized the trial cannot
        // pull the agent.s money, and the agent cannot pull the treasury.s. Credit has no
        // approve/transfer surface at all — the pull ledger is the authority.
        uint256 relayerBefore = relayer.balance;
        vm.prank(relayer);
        vm.expectRevert(CrucibleTrials.NothingToWithdraw.selector);
        trials.withdraw();
        assertEq(relayer.balance, relayerBefore, "the relayer went away empty-handed");

        uint256 agentBefore = operator.balance;
        vm.prank(operator);
        trials.withdraw();
        assertEq(operator.balance - agentBefore, REWARD - fee, "agent withdraws the payout");
        assertEq(trials.credit(operator), 0, "agent credit zeroed");

        // And a second pull has nothing to move: the ledger is the authority.
        vm.prank(companyTreasury);
        vm.expectRevert(CrucibleTrials.NothingToWithdraw.selector);
        trials.withdraw();
        _assertBooks("after agent withdraw");
    }

    function test_Win_ThroughSettleBatch_PaysTheSameFee() public {
        uint256[] memory ids = new uint256[](2);
        (ids[0],) = _fundAndClaim();
        _submitRun(ids[0]);
        address op2 = makeAddr("operator2"); // one agent per operator
        (ids[1],) = _fundAndClaimAs(op2);
        _submitRun(ids[1]);

        uint256 windowEnd = trials.runAtOf(ids[1]) + trials.breakWindowOf(ids[1]);
        vm.warp(windowEnd + 1);

        uint256[] memory batch = new uint256[](3); // a duplicate entry exercises the skip
        batch[0] = ids[0];
        batch[1] = ids[1];
        batch[2] = ids[0];
        trials.settleBatch(batch);

        uint256 fee = _expectedFee();
        assertEq(trials.credit(companyTreasury), 2 * fee, "batch settles credit the fee per trial, once each");
        assertEq(trials.credit(operator), REWARD - fee, "first agent paid out");
        assertEq(trials.credit(op2), REWARD - fee, "second agent paid out");
        assertEq(uint256(trials.getTrial(ids[0]).verdict), uint256(CrucibleTrials.Verdict.Paid), "first trial settled");
        assertEq(uint256(trials.getTrial(ids[1]).verdict), uint256(CrucibleTrials.Verdict.Paid), "second trial settled");
        _assertBooks("after settleBatch");
    }

    // ───────────────────────── the break-wins path ─────────────────────────

    function test_BreakWins_TreasuryTakesItsSlashShare_SponsorPaysNoFee() public {
        (uint256 id, uint256 aid) = _fundAndClaim();
        _submitRun(id);
        uint256 bond = trials.getTrial(id).bond;

        vm.deal(skeptic, 1 ether);
        vm.prank(skeptic);
        trials.fileBreak{value: 0.01 ether}(id, keccak256("proof"));
        _assertBooks("after break filed");

        // The committee agrees with the skeptic: two of three seats is the threshold.
        bytes32 salt = keccak256("salt");
        bytes32 commit = keccak256(abi.encodePacked(id, true, salt));
        vm.prank(a1);
        trials.commitVote(id, commit);
        vm.prank(a2);
        trials.commitVote(id, commit);
        vm.prank(a1);
        trials.revealVote(id, true, salt);
        vm.prank(a2);
        trials.revealVote(id, true, salt);

        uint256 skepticCut = (bond * trials.SLASH_SKEPTIC_NUM()) / trials.BPS();
        assertEq(trials.credit(companyTreasury), bond - skepticCut, "treasury takes the slash share");
        assertEq(trials.credit(skeptic), skepticCut + 0.01 ether, "skeptic earns the cut and their stake back");
        assertEq(trials.credit(sponsor), REWARD, "sponsor is refunded in full - no fee on a slash");
        assertEq(trials.credit(operator), 0, "a slashed agent earns nothing");
        assertEq(uint256(trials.getTrial(id).verdict), uint256(CrucibleTrials.Verdict.Slashed), "verdict recorded");
        _assertBooks("after slash settlement");

        // The treasury's slash share is pullable like any other credit.
        uint256 before = companyTreasury.balance;
        vm.prank(companyTreasury);
        trials.withdraw();
        assertEq(companyTreasury.balance - before, bond - skepticCut, "treasury withdraws the slash share");
        _assertBooks("after treasury withdraw (slash)");
    }

    // ───────────────────────── the refund path ─────────────────────────

    function test_Refund_SponsorReclaims_NoFeeAccrues() public {
        vm.deal(sponsor, REWARD);
        vm.prank(sponsor);
        uint256 id = trials.createTrial{value: REWARD}(REWARD, SPEC, TESTS, uint64(block.timestamp + 2 days), WINDOW);

        // No agent ever claims. At the deadline the sponsor reclaims, permissionlessly.
        vm.warp(uint256(trials.deadlineOf(id)) + 1);
        vm.prank(relayer); // anyone may pull the trigger
        trials.reclaimExpired(id);

        assertEq(trials.credit(sponsor), REWARD, "sponsor gets the whole reward back");
        assertEq(trials.credit(companyTreasury), 0, "a refund earns the protocol nothing");
        assertEq(uint256(trials.getTrial(id).verdict), uint256(CrucibleTrials.Verdict.Refunded), "refunded verdict");

        uint256 before = sponsor.balance;
        vm.prank(sponsor);
        trials.withdraw();
        assertEq(sponsor.balance - before, REWARD, "sponsor withdraws the refund");
        assertEq(trials.credit(companyTreasury), 0, "treasury still holds no credit");
        _assertBooks("after refund withdraw");
    }

    // ───────────────────────── refund of a claimed-then-abandoned trial ─────────────────────────

    function test_RefundAfterClaim_BondReturnsToTheAgent() public {
        (uint256 id, uint256 aid) = _fundAndClaim();
        uint256 bond = trials.getTrial(id).bond;

        vm.warp(uint256(trials.deadlineOf(id)) + 1);
        trials.reclaimExpired(id);

        assertEq(trials.credit(sponsor), REWARD, "sponsor refunded the reward");
        (,,, uint256 returnedBond,) = trials.agents(trials.getTrial(id).agentId);
        assertEq(returnedBond, 1 ether, "full stake restored: 0.8 free + 0.2 bond returned");
        assertEq(trials.credit(companyTreasury), 0, "no fee: no work was delivered");
        _assertBooks("after claimed-refund");

        // The agent pulls their bond out through the stake door (unstake moves stake into
        // the same pull ledger, then withdraw pays it), the sponsor their reward through
        // the credit door — two ledgers, both exact.
        // Read the agent id OUTSIDE the prank: vm.prank applies to the next call only, and
        // the getTrial in the argument list would otherwise consume it and leave unstake
        // caller-less (measured here: NotOperator from exactly that ordering).
        uint256 agentId = trials.getTrial(id).agentId;
        uint256 before = operator.balance;
        vm.prank(operator);
        trials.unstake(agentId, bond);
        vm.prank(operator);
        trials.withdraw();
        assertEq(operator.balance - before, bond, "agent withdraws the freed bond");
        uint256 sponsorBefore = sponsor.balance;
        vm.prank(sponsor);
        trials.withdraw();
        assertEq(sponsor.balance - sponsorBefore, REWARD, "sponsor withdraws the refund");
        _assertBooks("after both withdrawals");
    }

    // ───────────────────────── the treasury cannot be steered ─────────────────────────

    function test_StrangerCannotPullTheTreasuryCredit() public {
        (uint256 id,) = _fundAndClaim();
        _submitRun(id);
        vm.warp(trials.runAtOf(id) + trials.breakWindowOf(id) + 1);
        trials.finalize(id);

        uint256 fee = _expectedFee();
        assertGt(trials.credit(companyTreasury), 0, "precondition: treasury holds a credit");

        // A stranger calling withdraw() pulls their own (empty) credit — never the
        // treasury's. There is no approve/transferOf credit anywhere in the surface.
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(CrucibleTrials.NothingToWithdraw.selector);
        trials.withdraw();
        assertEq(trials.credit(companyTreasury), fee, "the treasury credit is untouched");
        assertEq(stranger.balance, 0, "the stranger went away empty-handed");
    }
}
