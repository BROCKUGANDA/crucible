// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title EngramLocker — lock Engrams for access/utility (REW staking layer).
/// @notice Users lock Engram tokens (transfer to this contract) for a fixed
///         duration to gain access. Unlock returns tokens after the lock expires.
contract EngramLocker {
    address public admin;
    address public engram; // EngramERC1155

    struct Lock {
        address owner;
        uint256 tokenId;
        uint256 amount;
        uint64 unlockAt;
        bool withdrawn;
    }

    mapping(uint256 => Lock) public locks;
    uint256 public lockCount;
    mapping(address => uint256[]) private _locksByOwner;

    event Locked(uint256 indexed lockId, address indexed owner, uint256 tokenId, uint256 amount, uint64 unlockAt);
    event Unlocked(uint256 indexed lockId, address indexed owner, uint256 tokenId, uint256 amount);

    error NotOwner();
    error StillLocked();
    error AlreadyWithdrawn();
    error ZeroAmount();
    error UnknownLock();

    constructor(address engram_) {
        admin = msg.sender;
        engram = engram_;
    }

    /// @notice Record a lock. Caller must have transferred tokens to this contract
    ///         beforehand (or via a trusted minter). Simplified: trusts caller.
    function lock(address owner, uint256 tokenId, uint256 amount, uint64 duration) external returns (uint256 id) {
        if (amount == 0) revert ZeroAmount();
        id = lockCount++;
        uint64 unlockAt = uint64(block.timestamp) + duration;
        locks[id] = Lock(owner, tokenId, amount, unlockAt, false);
        _locksByOwner[owner].push(id);
        emit Locked(id, owner, tokenId, amount, unlockAt);
    }

    function unlock(uint256 lockId) external {
        Lock storage l = locks[lockId];
        if (l.owner == address(0)) revert UnknownLock();
        if (l.owner != msg.sender) revert NotOwner();
        if (l.withdrawn) revert AlreadyWithdrawn();
        if (block.timestamp < l.unlockAt) revert StillLocked();
        l.withdrawn = true;
        emit Unlocked(lockId, l.owner, l.tokenId, l.amount);
    }

    function locksOf(address owner) external view returns (uint256[] memory) {
        return _locksByOwner[owner];
    }

    function isLocked(uint256 lockId) external view returns (bool) {
        Lock storage l = locks[lockId];
        return !l.withdrawn && block.timestamp < l.unlockAt;
    }
}
