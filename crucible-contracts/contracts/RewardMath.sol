// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

/**
 * @title RewardMath
 * @notice Pure math encoding every row of the CRUCIBLE reward flow table
 *         (gates 640–655). All functions are pure — no state, no external calls.
 *         The flow table is the single economic source of truth; this library is its
 *         executable spec. CRUCIBLE's fee is FEE_BPS = 500 = 5% (AGENTS.md: the code,
 *         the tests, and the contract-spec win over any external PRD).
 *
 * Rows encoded:
 *   postWork accepted     -> escrow internally split: (10000-FEE_BPS)% worker / FEE_BPS% fee
 *   Settle on PASS        -> worker ← workerShare + stake; feeVault ← feeShare
 *   Settle on FAIL        -> funder ← full reward; stake slashed 50/50 funder/feeVault; fee returns
 *   Deadline expiry       -> funder ← full refund (pull); worker ← stake back
 *   Dispute overturn      -> worker ← full restitution; dispute fee → winner
 *   Stake floor           -> stake ≥ estimated verification cost
 *   Conservation          -> balance == rewardsHeld + stakesHeld + disputeFeesHeld + feeVault + pending
 */
library RewardMath {
    uint256 internal constant FEE_BPS = 500; // 5% settlement fee (gate 641)
    uint256 internal constant BPS = 10_000;

    /// @notice Split of an accepted postWork: worker-share / fee-share. Fee is assessed
    ///         and frozen here; it moves at settle (gate 641).
    function splitPostWork(uint256 reward) internal pure returns (uint256 workerShare, uint256 feeShare) {
        feeShare = (reward * FEE_BPS) / BPS;
        workerShare = reward - feeShare;
    }

    /// @notice Settle on PASS (gate 644): worker ← workerShare + stake back; feeVault ← feeShare.
    function settleOnPass(uint256 reward, uint256 stake)
        internal
        pure
        returns (uint256 workerPayout, uint256 feePayout, uint256 stakeBack)
    {
        (uint256 workerShare, uint256 feeShare) = splitPostWork(reward);
        workerPayout = workerShare + stake;
        feePayout = feeShare;
        stakeBack = stake;
    }

    /// @notice Settle on FAIL (gate 643): funder ← full reward incl. frozen fee; stake slashed
    ///         50/50 (funder compensation / feeVault). Verification is not charged when it finds
    ///         failure — the fee returns to the funder with the reward.
    function settleOnFail(uint256 reward, uint256 stake)
        internal
        pure
        returns (uint256 funderRefund, uint256 funderStakeBack, uint256 feeStakeBack)
    {
        funderRefund = reward;
        funderStakeBack = stake / 2;
        feeStakeBack = stake - stake / 2;
    }

    /// @notice Deadline expiry (gate 645): funder ← full refund via pull; worker ← stake back.
    ///         Nothing silently decays into the vault.
    function settleOnExpiry(uint256 reward, uint256 stake)
        internal
        pure
        returns (uint256 funderRefund, uint256 stakeBack)
    {
        funderRefund = reward;
        stakeBack = stake;
    }

    /// @notice Dispute overturn (gate 646): full worker restitution; dispute fee → winner.
    function settleOnDisputeOverturn(uint256 reward, uint256 stake, uint256 disputeFee)
        internal
        pure
        returns (uint256 workerRestitution, uint256 winnerDisputeFee)
    {
        workerRestitution = reward + stake;
        winnerDisputeFee = disputeFee;
    }

    /// @notice Stake floor (gate 642): stake ≥ k × estimated verification cost. k ≥ 1 for v1.
    function stakeFloor(uint256 estimatedVerificationCost) internal pure returns (uint256) {
        return estimatedVerificationCost;
    }

    /// @notice Conservation check (gate 647): contract balance equals the sum of every
    ///         book entry — the exact equality the invariant battery enforces nightly.
    ///         Gas never enters this math (AGENTS.md: conservation is about contract-held ETH).
    function conservation(
        uint256 balance,
        uint256 rewardsHeld,
        uint256 stakesHeld,
        uint256 disputeFeesHeld,
        uint256 feeVault,
        uint256 pendingHeld
    ) internal pure returns (bool ok) {
        return balance == rewardsHeld + stakesHeld + disputeFeesHeld + feeVault + pendingHeld;
    }
}
