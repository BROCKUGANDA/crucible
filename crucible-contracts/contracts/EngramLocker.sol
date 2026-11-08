// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title EngramLocker — decision record encoded as code: DISABLED for mainnet.
/// @notice The pre-fix design recorded locks without moving tokens, letting any
/// caller create a record naming another wallet. Custody without authorization
/// is not a lock. This contract therefore refuses all lock/unlock calls.
/// Future custodial design must be a separately audited contract.
contract EngramLocker {
    error LockerDisabled();

    event LockerDisabledNotice(string reason);

    constructor() {
        emit LockerDisabledNotice("custody semantics unresolved; see docs/adr/engram-locker-decision.md");
    }

    function lock(address, uint256, uint256, uint64) external pure returns (uint256) {
        revert LockerDisabled();
    }

    function unlock(uint256) external pure {
        revert LockerDisabled();
    }

    function locksOf(address) external pure returns (uint256[] memory) {
        return new uint256[](0);
    }

    function isLocked(uint256) external pure returns (bool) {
        return false;
    }
}
