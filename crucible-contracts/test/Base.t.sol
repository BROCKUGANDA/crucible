// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";
import {AlloyRegistry} from "../contracts/AlloyRegistry.sol";

abstract contract Base is Test {
    CrucibleTrials trials;
    AlloyRegistry alloy;

    uint256 constant RUNNER_KEY = 0xA11CE;
    uint256 constant REWARD = 1 ether; // bond = 0.2 ether, min break stake = 0.01 ether
    uint64 constant WINDOW = 12 hours;

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

    function setUp() public virtual {
        address[] memory seats = new address[](3);
        seats[0] = a1;
        seats[1] = a2;
        seats[2] = a3;
        alloy = new AlloyRegistry();
        trials = new CrucibleTrials(makeAddr("treasury"), address(alloy), seats);
        alloy.setForge(address(trials));
    }

    function _register(uint256 stake) internal returns (uint256 aid) {
        vm.deal(operator, stake);
        vm.prank(operator);
        aid = trials.registerAgent{value: stake}("ipfs://manifest", runner);
    }

    /// create (sponsor) + register (operator, 1 ETH stake) + claim
    function _liveTrial() internal returns (uint256 id, uint256 aid) {
        vm.deal(sponsor, REWARD);
        vm.prank(sponsor);
        id = trials.createTrial{value: REWARD}(SPEC, TESTS, uint64(block.timestamp + 2 days), WINDOW);
        aid = _register(1 ether);
        vm.prank(operator);
        trials.claimTrial(id);
    }

    function _digest(uint256 id, uint256 aid, bytes32 runHash, uint64 sigDeadline) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01", trials.DOMAIN(), keccak256(abi.encode(trials.RUN_TYPEHASH(), id, aid, runHash, sigDeadline))
            )
        );
    }

    /// NOTE: no `_sign(uint256 key, ...)` helper by design — signing always goes through
    /// `vm.sign(RUNNER_KEY, _digest(...))` inline so the domain can never be faked.
    function _submitRun(uint256 id) internal returns (uint256 aid) {
        aid = trials.getTrial(id).agentId;
        uint64 sd = uint64(block.timestamp + 10 minutes);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, _digest(id, aid, RUN, sd));
        vm.prank(relayer);
        trials.submitRun(id, RUN, abi.encodePacked(r, s, v), sd);
    }

    function _fileBreak(uint256 id) internal {
        vm.deal(skeptic, 1 ether);
        vm.prank(skeptic);
        trials.fileBreak{value: 0.01 ether}(id, keccak256("proof"));
    }

    /// stakes exactly the 1% floor for this trial's reward, so it works for any reward size
    function _fileBreakExact(uint256 id) internal {
        uint256 minStake = trials.getTrial(id).reward / trials.BREAK_STAKE_DEN();
        vm.deal(skeptic, minStake);
        vm.prank(skeptic);
        trials.fileBreak{value: minStake}(id, keccak256("proof"));
    }

    /// a second, independent agent — one agent per operator, so `operator` can only register once
    function _liveTrialSecondAgent() internal returns (uint256 id, uint256 aid) {
        address op2 = makeAddr("operator2");
        vm.deal(sponsor, REWARD);
        vm.prank(sponsor);
        id = trials.createTrial{value: REWARD}(SPEC, TESTS, uint64(block.timestamp + 2 days), WINDOW);
        vm.deal(op2, 1 ether);
        vm.prank(op2);
        aid = trials.registerAgent{value: 1 ether}("ipfs://manifest2", vm.addr(RUNNER_KEY));
        vm.prank(op2);
        trials.claimTrial(id);
    }

    /// two Argus seats commit + reveal the same vote → threshold reached → settles
    function _resolve(uint256 id, bool breakWins) internal {
        bytes32 salt = keccak256("salt");
        bytes32 commit = keccak256(abi.encodePacked(id, breakWins, salt));
        vm.prank(a1);
        trials.commitVote(id, commit);
        vm.prank(a2);
        trials.commitVote(id, commit);
        vm.prank(a1);
        trials.revealVote(id, breakWins, salt);
        vm.prank(a2);
        trials.revealVote(id, breakWins, salt);
    }
}
