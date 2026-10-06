// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";
import {AlloyRegistry} from "../contracts/AlloyRegistry.sol";

/// Drives every state transition, swallowing reverts the way a real actor's
/// transactions would (a rejected tx changes nothing, it must not break the run).
contract Handler is Test {
    CrucibleTrials public immutable trials;
    address public immutable runner;
    address public immutable operator;
    address public immutable sponsor;
    address public immutable skeptic;
    address public immutable a1;
    address public immutable a2;
    address public immutable a3;
    uint256 public agentId;

    bytes32 constant SPEC = keccak256("spec");
    bytes32 constant TESTS = keccak256("tests");
    bytes32 constant RUN = keccak256("run");
    uint256 constant RUNNER_KEY = 0xA11CE;

    constructor(CrucibleTrials t) {
        trials = t;
        runner = vm.addr(RUNNER_KEY);
        operator = makeAddr("h.operator");
        sponsor = makeAddr("h.sponsor");
        skeptic = makeAddr("h.skeptic");
        a1 = makeAddr("h.argus1");
        a2 = makeAddr("h.argus2");
        a3 = makeAddr("h.argus3");
    }

    function init() external {
        vm.deal(operator, 100 ether);
        vm.prank(operator);
        agentId = trials.registerAgent{value: 10 ether}("ipfs://m", runner);
    }

    function createTrial(uint256 rSeed, uint256 wSeed) external {
        uint256 reward = bound(rSeed, 0.05 ether, 2 ether);
        uint64 win = uint64(bound(wSeed, 1 hours, 3 days));
        vm.deal(sponsor, reward);
        vm.prank(sponsor);
        try trials.createTrial{value: reward}(SPEC, TESTS, uint64(block.timestamp + 2 days), win) {} catch {}
    }

    function claim(uint256 idSeed) external {
        uint256 id = bound(idSeed, 1, trials.trialCount());
        vm.prank(operator);
        try trials.claimTrial(id) {} catch {}
    }

    function submit(uint256 idSeed) external {
        uint256 id = bound(idSeed, 1, trials.trialCount());
        uint64 sd = uint64(block.timestamp + 10 minutes);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01", trials.DOMAIN(), keccak256(abi.encode(trials.RUN_TYPEHASH(), id, agentId, RUN, sd))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, digest);
        vm.prank(makeAddr("h.relayer"));
        try trials.submitRun(id, RUN, abi.encodePacked(r, s, v), sd) {} catch {}
    }

    function unstake(uint256 amtSeed) external {
        uint256 amt = bound(amtSeed, 1, 10 ether);
        vm.prank(operator);
        try trials.unstake(agentId, amt) {} catch {}
    }

    function breakRun(uint256 idSeed, uint256 sSeed) external {
        uint256 id = bound(idSeed, 1, trials.trialCount());
        CrucibleTrials.Trial memory t = trials.getTrial(id);
        uint256 min = uint256(t.reward) / trials.BREAK_STAKE_DEN();
        uint256 max = min + 0.5 ether;
        uint256 stake = bound(sSeed, min, max);
        vm.deal(skeptic, stake);
        vm.prank(skeptic);
        try trials.fileBreak{value: stake}(id, keccak256("p")) {} catch {}
    }

    function dispute(uint256 idSeed, bool breakWins) external {
        uint256 id = bound(idSeed, 1, trials.trialCount());
        bytes32 salt = keccak256(abi.encode(breakWins, id));
        bytes32 commit = keccak256(abi.encodePacked(id, breakWins, salt));
        vm.prank(a1);
        try trials.commitVote(id, commit) {} catch {}
        vm.prank(a2);
        try trials.commitVote(id, commit) {} catch {}
        vm.prank(a1);
        try trials.revealVote(id, breakWins, salt) {} catch {}
        vm.prank(a2);
        try trials.revealVote(id, breakWins, salt) {} catch {}
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1 minutes, 10 days));
    }

    function finalize(uint256 idSeed) external {
        uint256 id = bound(idSeed, 1, trials.trialCount());
        try trials.finalize(id) {} catch {}
    }

    function reclaim(uint256 idSeed) external {
        uint256 id = bound(idSeed, 1, trials.trialCount());
        vm.prank(sponsor);
        try trials.reclaimExpired(id) {} catch {}
    }

    function withdrawAll() external {
        vm.prank(sponsor);
        try trials.withdraw() {} catch {}
        vm.prank(operator);
        try trials.withdraw() {} catch {}
        vm.prank(skeptic);
        try trials.withdraw() {} catch {}
        vm.prank(trials.treasury());
        try trials.withdraw() {} catch {}
    }

    function setRunner(uint256 rSeed) external {
        vm.prank(operator);
        try trials.setRunner(agentId, vm.addr(bound(rSeed, 1, type(uint160).max))) {} catch {}
    }

    receive() external payable {}
}

contract ConservationInvariants is Test {
    CrucibleTrials trials;
    AlloyRegistry alloy;
    Handler handler;

    function setUp() public {
        address[] memory seats = new address[](3);
        seats[0] = makeAddr("h.argus1");
        seats[1] = makeAddr("h.argus2");
        seats[2] = makeAddr("h.argus3");
        alloy = new AlloyRegistry();
        trials = new CrucibleTrials(makeAddr("treasury"), address(alloy), seats);
        alloy.setForge(address(trials));
        handler = new Handler(trials);
        handler.init();

        // targetSelector, not targetContract: init() must not be fuzzed (it reverts once the
        // agent is registered, and every revert would show up as noise in the call table)
        bytes4[] memory sels = new bytes4[](11);
        sels[0] = Handler.createTrial.selector;
        sels[1] = Handler.claim.selector;
        sels[2] = Handler.submit.selector;
        sels[3] = Handler.unstake.selector;
        sels[4] = Handler.breakRun.selector;
        sels[5] = Handler.dispute.selector;
        sels[6] = Handler.warp.selector;
        sels[7] = Handler.finalize.selector;
        sels[8] = Handler.reclaim.selector;
        sels[9] = Handler.withdrawAll.selector;
        sels[10] = Handler.setRunner.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// forge invariant: Σ(balance) == Σ(stakes) + Σ(credits) + Σ(escrow) — always
    function invariant_balanceConservation() public view {
        assertEq(address(trials).balance, trials.totalStakes() + trials.totalPending() + trials.escrowed());
    }

    function invariant_escrowNeverExceedsBalance() public view {
        assertLe(trials.escrowed(), address(trials).balance);
    }

    function invariant_pendingNeverExceedsBalance() public view {
        assertLe(trials.totalPending(), address(trials).balance);
    }

    /// every trial's bond was computed by the same rule that claimTrial consumed
    function invariant_bondAlwaysAtLeastFloor() public view {
        uint256 n = trials.trialCount();
        for (uint256 i = 1; i <= n; ++i) {
            CrucibleTrials.Trial memory t = trials.getTrial(i);
            assertGe(t.bond, trials.MIN_BOND());
            assertEq(t.bond, trials.bondFor(t.reward));
        }
    }

    /// Alloy tiers are only ever written by settlement, and never rise past Damascus
    function invariant_alloyTierAlwaysInRange() public view {
        uint256 n = trials.agentCount();
        for (uint256 i = 1; i <= n; ++i) {
            assertLe(alloy.tierOf(i), 4);
            assertTrue(alloy.locked(i) == (alloy.ownerOf(i) != address(0)));
        }
    }

    /// no settled trial can ever be settled again
    function invariant_settledTrialsHaveTerminalVerdicts() public view {
        uint256 n = trials.trialCount();
        for (uint256 i = 1; i <= n; ++i) {
            CrucibleTrials.Trial memory t = trials.getTrial(i);
            if (uint8(t.status) == uint8(CrucibleTrials.Status.Settled)) {
                assertTrue(uint8(t.verdict) != uint8(CrucibleTrials.Verdict.None));
            } else {
                assertEq(uint8(t.verdict), uint8(CrucibleTrials.Verdict.None));
            }
        }
    }
}
