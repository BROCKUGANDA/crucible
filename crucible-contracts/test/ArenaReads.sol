// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Arena} from "../contracts/Arena.sol";

/**
 * @notice The per-field getters the tests used to read off `Arena` itself.
 *
 * They are gone from the contract on purpose: each one was a strict subset of a multi-return
 * getter, and nineteen of them cost 1,189 bytes of runtime code — the difference between
 * `Arena` fitting EIP-170's 24,576-byte limit and not. The contract exposes `stateOf`,
 * `amountsOf`, `windowsOf` and `breakAt`; everything here projects those, so a test still reads
 * the field it means by name.
 *
 * This lives in `test/` and not in the contract: a convenience wrapper is a reader's affordance,
 * and putting it back on-chain is how the bytecode regrew in the first place.
 */
library ArenaReads {
    function statusOf(Arena a, uint256 id) internal view returns (Arena.Status status) {
        (status,,,,,) = a.stateOf(id);
    }

    function outcomeOf(Arena a, uint256 id) internal view returns (Arena.Outcome outcome) {
        (, outcome,,,,) = a.stateOf(id);
    }

    function roundOf(Arena a, uint256 id) internal view returns (uint8 round) {
        (,, round,,,) = a.stateOf(id);
    }

    function docketFrozenOf(Arena a, uint256 id) internal view returns (bool frozen) {
        (,,, frozen,,) = a.stateOf(id);
    }

    function holdoutRevealedOf(Arena a, uint256 id) internal view returns (bool revealed) {
        (,,,, revealed,) = a.stateOf(id);
    }

    function holdoutMissedOf(Arena a, uint256 id) internal view returns (bool missed) {
        (,,,,, missed) = a.stateOf(id);
    }

    function rewardOf(Arena a, uint256 id) internal view returns (uint256 reward) {
        (reward,,,,) = a.amountsOf(id);
    }

    function feeOf(Arena a, uint256 id) internal view returns (uint256 fee) {
        (, fee,,,) = a.amountsOf(id);
    }

    function bondOf(Arena a, uint256 id) internal view returns (uint256 bond) {
        (,, bond,,) = a.amountsOf(id);
    }

    function openUntilOf(Arena a, uint256 id) internal view returns (uint256 openUntil) {
        (, openUntil,,,,,) = a.windowsOf(id);
    }

    function claimDeadlineOf(Arena a, uint256 id) internal view returns (uint256 claimDeadline) {
        (,, claimDeadline,,,,) = a.windowsOf(id);
    }

    function submittedAtOf(Arena a, uint256 id) internal view returns (uint256 submittedAt) {
        (,,, submittedAt,,,) = a.windowsOf(id);
    }

    function windowEndOf(Arena a, uint256 id) internal view returns (uint256 windowEnd) {
        (,,,, windowEnd,,) = a.windowsOf(id);
    }

    function holdoutDueByOf(Arena a, uint256 id) internal view returns (uint256 holdoutDueBy) {
        (,,,,, holdoutDueBy,) = a.windowsOf(id);
    }

    function skepticWindowOf(Arena a, uint256 id) internal view returns (uint32 skepticWindow) {
        (,,,,,, skepticWindow) = a.windowsOf(id);
    }

    function breakSkepticAt(Arena a, uint256 id, uint256 index) internal view returns (address skeptic) {
        (skeptic,,,,,,,) = a.breakAt(id, index);
    }

    function breakRevealedAt(Arena a, uint256 id, uint256 index) internal view returns (bool revealed) {
        (,,, revealed,,,,) = a.breakAt(id, index);
    }

    function breakOnDocketAt(Arena a, uint256 id, uint256 index) internal view returns (bool onDocket) {
        (,,,, onDocket,,,) = a.breakAt(id, index);
    }

    function breakLandedAt(Arena a, uint256 id, uint256 index) internal view returns (bool landed) {
        (,,,,, landed,,) = a.breakAt(id, index);
    }
}
