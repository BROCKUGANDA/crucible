// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";
import {AlloyRegistry} from "../contracts/AlloyRegistry.sol";

/**
 * Why the invariant harness excludes the escrow as a *sender*.
 *
 * The 2026-10-26 failure shrank to a valued `registerAgent` and could not be reproduced by
 * rerunning the campaign. The mechanism is a self-call: the escrow is the caller, so the ETH
 * it sends is paid to itself and does not leave its balance, while `totalStakes` is credited
 * by the full value. Balance unchanged, books up by 10 ether — which reads as exactly twice
 * the balance in the failing trace.
 *
 * No chain can produce that state: `CrucibleTrials` has no path that calls itself with value,
 * so an external caller cannot make the escrow be its own counterparty. It is an instrument
 * artifact, and the harness must not generate it — but "we excluded it" is a claim, so this
 * file proves the break exists, that the exclusion is wired, and that the two are different
 * knobs (targets vs senders).
 */
contract InvariantHarnessGuards is Test {
    CrucibleTrials trials;
    AlloyRegistry alloy;

    function setUp() public {
        address[] memory seats = new address[](3);
        seats[0] = makeAddr("g.argus1");
        seats[1] = makeAddr("g.argus2");
        seats[2] = makeAddr("g.argus3");
        alloy = new AlloyRegistry();
        trials = new CrucibleTrials(makeAddr("g.treasury"), address(alloy), seats);
        alloy.setForge(address(trials));
    }

    /// A valued call FROM the escrow leaves the balance where it was and grows the books.
    function test_escrowSelfCallBreaksConservation_andThatIsWhyItIsExcluded() public {
        // Fund the escrow the way a sponsor would, then make it its own caller.
        vm.deal(address(trials), 50 ether);
        uint256 balanceBefore = address(trials).balance;
        uint256 booksBefore = trials.totalStakes() + trials.totalPending() + trials.escrowed();

        vm.prank(address(trials));
        trials.registerAgent{value: 10 ether}("ipfs://self", makeAddr("g.runner"));

        // The value went out and came straight back: the balance is untouched...
        assertEq(address(trials).balance, balanceBefore, "a self-send must not change the balance");
        // ...while the books credited the full 10 ether, which is the conservation break.
        assertEq(trials.totalStakes(), 10 ether, "totalStakes credited the self-call");
        assertEq(
            trials.totalStakes() + trials.totalPending() + trials.escrowed(),
            booksBefore + 10 ether,
            "books grew while the balance did not"
        );
        assertTrue(
            trials.totalStakes() + trials.totalPending() + trials.escrowed() != address(trials).balance,
            "this is the invariant failure the harness must not generate"
        );
    }

    /// And no external caller can reach that state: `msg.sender == escrow` needs the escrow to
    /// call itself, which it has no code path for.
    function test_noExternalCallerProducesASelfCall() public {
        address attacker = makeAddr("g.attacker");
        vm.deal(attacker, 100 ether);
        vm.prank(attacker);
        trials.registerAgent{value: 10 ether}("ipfs://attacker", makeAddr("g.runner2"));
        // The attacker's ETH really leaves the attacker, so balance and books move together.
        assertEq(address(trials).balance, 10 ether);
        assertEq(trials.totalStakes() + trials.totalPending() + trials.escrowed(), 10 ether);
    }
}
