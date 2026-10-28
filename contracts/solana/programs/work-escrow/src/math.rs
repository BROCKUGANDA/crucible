//! Gate 702 — RewardMath for Solana work-escrow.
//!
//! Mirrors the EVM RewardMath flow table field-for-field:
//!   postWork accepted: escrow internally split 95% worker-share / 5% fee-share,
//!     fee assessed & frozen here, moved at settle.
//!   Settle on PASS: worker <- worker_share + stake; feeVault <- fee_share.
//!   Settle on FAIL: funder <- full reward; funder <- 50% stake; feeVault <- 50% stake.
//!   Deadline expiry: funder <- full refund (pull); worker <- stake back.
//!   Dispute overturn: full worker restitution; dispute fee -> feeVault.
//!
//! All arithmetic is checked-u64 (overflow-checks = true in workspace Cargo.toml).

pub const FEE_BPS: u64 = 500; // 5% protocol fee — mirrors EVM RewardMath (gate 641), not the v2 arena's ARENA_FEE_BPS 1500
pub const BPS: u64 = 10_000;
pub const K_FLOOR: u64 = 3; // minimum stake
pub const DISPUTE_SLASH_NUM: u64 = 500; // 50% slash on dispute loss
pub const DISPUTE_SLASH_DEN: u64 = 1000;

/// Split an accepted postWork into worker-share / fee-share.
/// Fee is assessed and frozen here; it moves only at settle (gate 641).
pub fn assess_fee(reward: u64) -> (u64, u64) {
    let fee_share = reward
        .checked_mul(FEE_BPS)
        .and_then(|v| v.checked_div(BPS))
        .expect("reward * FEE_BPS overflow");
    let worker_share = reward
        .checked_sub(fee_share)
        .expect("reward - fee_share underflow");
    (worker_share, fee_share)
}

/// Settle on PASS (gate 644): worker <- worker_share + stake back; feeVault <- fee_share.
pub fn settle_pass(reward: u64, stake: u64) -> (u64, u64, u64) {
    let (worker_share, fee_share) = assess_fee(reward);
    let worker_payout = worker_share
        .checked_add(stake)
        .expect("worker_share + stake overflow");
    (worker_payout, fee_share, stake)
}

/// Settle on FAIL (gate 643): funder <- full reward; stake slashed 50/50;
/// feeVault <- 50% of stake. Fee returns on fail — verification never charged
/// when it finds failure.
pub fn settle_fail(reward: u64, stake: u64) -> (u64, u64, u64) {
    let funder_refund = reward;
    let funder_stake_back = stake
        .checked_div(2)
        .expect("stake / 2 underflow");
    let fee_stake_back = stake
        .checked_sub(funder_stake_back)
        .expect("stake - funder_stake_back underflow");
    (funder_refund, funder_stake_back, fee_stake_back)
}

/// Resolve a dispute (gate 646): `approve == true` -> pass applies;
/// `approve == false` -> fail applies. Returns
/// (worker_payout, funder_payout, fee_vault_payout, dispute_pool_slashed).
pub fn resolve_dispute(reward: u64, stake: u64, approve: bool) -> (u64, u64, u64, u64) {
    if approve {
        // Verdict upheld (worker wins): worker gets full reward + stake back;
        // fee vault gets the 5% fee; dispute fee forfeited to treasury.
        // No slash — the worker's claim survived.
        let (worker_share, fee_share) = assess_fee(reward);
        let worker_payout = worker_share
            .checked_add(stake)
            .expect("worker_share + stake overflow");
        let funder_payout = 0;
        let fee_vault_payout = fee_share;
        let dispute_pool_slashed = 0;
        (worker_payout, funder_payout, fee_vault_payout, dispute_pool_slashed)
    } else {
        // Verdict overturned (worker loses): funder gets reward + half stake;
        // fee vault gets the other half (50/50 slash). Worker gets nothing.
        // Dispute fee forfeited to treasury.
        let (funder_refund, funder_stake_back, fee_stake_back) = settle_fail(reward, stake);
        let funder_payout = funder_refund
            .checked_add(funder_stake_back)
            .expect("funder_refund + funder_stake_back overflow");
        let fee_vault_payout = fee_stake_back;
        let dispute_pool_slashed = fee_stake_back; // 50% of stake slashed to fee vault
        (0, funder_payout, fee_vault_payout, dispute_pool_slashed)
    }
}

/// Stake floor (gate 642): stake >= k * estimated verification cost.
/// k >= 1 for v1; contract enforces the floor, keeper enforces the estimate.
pub fn check_stake_floor(stake: u64) -> bool {
    stake >= K_FLOOR
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assess_fee_5_percent() {
        let (worker, fee) = assess_fee(10_000);
        assert_eq!(fee, 500);
        assert_eq!(worker, 9_500);
        assert_eq!(worker + fee, 10_000);
    }

    #[test]
    fn settle_pass_pays_worker_share_plus_stake() {
        let (worker, fee, stake_back) = settle_pass(10_000, 1_000);
        assert_eq!(worker, 10_500); // 9500 + 1000
        assert_eq!(fee, 500);
        assert_eq!(stake_back, 1_000);
    }

    #[test]
    fn settle_fail_returns_full_reward_and_slashes_stake() {
        let (funder, funder_stake, fee_stake) = settle_fail(10_000, 1_000);
        assert_eq!(funder, 10_000);
        assert_eq!(funder_stake, 500);
        assert_eq!(fee_stake, 500);
        assert_eq!(funder_stake + fee_stake, 1_000);
    }

    #[test]
    fn check_stake_floor() {
        assert!(!check_stake_floor(2));
        assert!(check_stake_floor(3));
        assert!(check_stake_floor(1_000));
    }

    // ── property tests (gate 716): conservation holds for random inputs ──
    use proptest::prelude::*;

    proptest! {
        /// assess_fee splits reward into worker_share + fee_share with no loss.
        #[test]
        fn prop_assess_fee_conserves(reward in 0u64..1_000_000_000_000_000_000u64) {
            let (worker_share, fee_share) = assess_fee(reward);
            prop_assert_eq!(worker_share + fee_share, reward);
            prop_assert!(fee_share <= reward);
            prop_assert!(worker_share <= reward);
        }

        /// settle_pass conserves: worker_payout + fee_payout = reward + stake.
        #[test]
        fn prop_settle_pass_conserves(reward in 0u64..1_000_000_000_000_000_000u64, stake in 0u64..1_000_000u64) {
            let (worker_payout, fee_payout, _stake_back) = settle_pass(reward, stake);
            prop_assert_eq!(worker_payout + fee_payout, reward + stake);
            prop_assert_eq!(_stake_back, stake);
        }

        /// settle_fail conserves: funder_refund + funder_stake_back + fee_stake_back = reward + stake.
        #[test]
        fn prop_settle_fail_conserves(reward in 0u64..1_000_000_000_000_000_000u64, stake in 0u64..1_000_000u64) {
            let (funder_refund, funder_stake_back, fee_stake_back) = settle_fail(reward, stake);
            prop_assert_eq!(funder_refund + funder_stake_back + fee_stake_back, reward + stake);
            prop_assert_eq!(funder_stake_back + fee_stake_back, stake);
            prop_assert_eq!(funder_refund, reward);
        }

        /// resolve_dispute conserves in both branches.
        #[test]
        fn prop_resolve_dispute_conserves(reward in 0u64..1_000_000_000_000_000_000u64, stake in 0u64..1_000_000u64, approve in bool) {
            let (worker, funder, fee_vault, _slashed) = resolve_dispute(reward, stake, approve);
            prop_assert_eq!(worker + funder + fee_vault, reward + stake);
        }
    }
}
