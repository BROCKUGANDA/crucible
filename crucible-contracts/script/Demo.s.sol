// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";
import {AlloyRegistry} from "../contracts/AlloyRegistry.sol";

/// Replays the full Crucible loop locally in one broadcast — stage insurance.
///   anvil                          # terminal 1
///   forge script script/Demo.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
contract Demo is Script {
    uint256 constant RUNNER_KEY = 0xA11CE;

    function run() external {
        AlloyRegistry alloy = new AlloyRegistry();
        address[] memory seats = new address[](3);
        seats[0] = makeAddr("argus1");
        seats[1] = makeAddr("argus2");
        seats[2] = makeAddr("argus3");
        CrucibleTrials trials = new CrucibleTrials(makeAddr("treasury"), address(alloy), seats);
        alloy.setForge(address(trials));

        address sponsor = makeAddr("sponsor");
        address operator = makeAddr("operator");
        address skeptic = makeAddr("skeptic");
        address runner = vm.addr(RUNNER_KEY);
        bytes32 spec = keccak256("spec");
        bytes32 tests = keccak256("tests");
        bytes32 runHash = keccak256("RunArtifact{all-pass}");

        console.log("1. sponsor lights trial (1 ETH reward)");
        vm.deal(sponsor, 2 ether);
        vm.prank(sponsor);
        uint256 id = trials.createTrial{value: 1 ether}(spec, tests, uint64(block.timestamp + 1 days), 12 hours);

        console.log("2. agent registers, claims, forges, submits");
        vm.deal(operator, 1 ether);
        vm.prank(operator);
        uint256 aid = trials.registerAgent{value: 1 ether}("ipfs://manifest", runner);
        vm.prank(operator);
        trials.claimTrial(id);

        uint64 sigDeadline = uint64(block.timestamp + 10 minutes);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01", trials.DOMAIN(), keccak256(abi.encode(trials.RUN_TYPEHASH(), id, aid, runHash, sigDeadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, digest);
        vm.prank(makeAddr("relayer")); // permissionless relay
        trials.submitRun(id, runHash, abi.encodePacked(r, s, v), sigDeadline);

        console.log("3. skeptic attacks and fails");
        vm.deal(skeptic, 1 ether);
        vm.prank(skeptic);
        trials.fileBreak{value: 0.01 ether}(id, keccak256("no-proof"));

        bool breakWins = false;
        bytes32 salt = keccak256("s");
        vm.prank(seats[0]);
        trials.commitVote(id, keccak256(abi.encodePacked(id, breakWins, salt)));
        vm.prank(seats[1]);
        trials.commitVote(id, keccak256(abi.encodePacked(id, breakWins, salt)));
        vm.prank(seats[0]);
        trials.revealVote(id, breakWins, salt);
        vm.prank(seats[1]);
        trials.revealVote(id, breakWins, salt); // 2/3 -> settles

        console.log("4. verdict Paid, agent payout (wei):", trials.credit(operator));
        console.log("5. Alloy tier:", alloy.tierName(aid));
    }
}
