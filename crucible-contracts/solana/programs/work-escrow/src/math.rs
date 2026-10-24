//! RewardMath, ported — the reward flow table as pure functions (gates 707-711).
//!
//! This module is the byte-for-byte mirror of `crucible-contracts/contracts/RewardMath.sol`
//! on the EVM side: same rows, same truncation direction, same constants. The two
//! implementations must agree to the lamport or nothing ships (gate 716); the host
//! tests below run with plain `cargo test -p work-escrow` and assert every row plus
//! the partition property each payout must satisfy.
//!
//! One deliberate deviation from the port spec's prose, recorded per its own
//! deviation-table discipline (gate 713): the spec text says "frozen 15% fee", but
//! the EVM source of truth is `FEE_BPS = 500` = **5%** and AGENTS.md makes that
//! number load-bearing ("the code, the tests and the contract-spec win over any
//! external PRD"). A 15% fee here would be the product pivot AGENTS.md names, so
//! this port carries 500 bps and this comment is the record of the disagreement.
//!
//! All arithmetic is checked u64; an overflow is a program error, which on-chain
//! is a failed transaction — fail-closed by construction (gate 710).

/// Settlement fee in basis points — 500 = 5% (RewardMath.sol, gate 641).
pub const FEE_BPS: u64 = 500;
/// Basis point denominator.
pub const BPS: u64 = 10_000;

/// A checked-math failure. Every function returns this instead of panicking so
/// the caller can surface a typed error code, not an abort.
pub type MathResult<T> = Result<T, MathError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError {
    Overflow,
}

fn checked_add(a: u64, b: u64) -> MathResult<u64> {
    a.checked_add(b).ok_or(MathError::Overflow)
}

fn checked_mul(a: u64, b: u64) -> MathResult<u64> {
    a.checked_mul(b).ok_or(MathError::Overflow)
}

/// Split of an accepted post_work: worker-share / fee-share. The fee is assessed
/// and frozen here (recorded as `fee_held` on the account — gate 707); it moves
/// at settle. Truncation direction matches Solidity: `fee = reward * FEE_BPS / BPS`
/// rounds the fee DOWN and the worker UP, exactly as `(reward * 500) / 10_000`.
pub fn split_post_work(reward: u64) -> MathResult<(u64, u64)> {
    let fee_share = checked_mul(reward, FEE_BPS)? / BPS;
    let worker_share = reward - fee_share; // fee_share <= reward/BPS*500 < reward; cannot underflow
    Ok((worker_share, fee_share))
}

/// Settle on PASS (RewardMath row: gate 644): worker gets worker-share + stake
/// back; the treasury gets the fee. Returns (worker_payout, fee_payout).
pub fn settle_on_pass(reward: u64, stake: u64) -> MathResult<(u64, u64)> {
    let (worker_share, fee_share) = split_post_work(reward)?;
    Ok((checked_add(worker_share, stake)?, fee_share))
}

/// Settle on FAIL (RewardMath row: gate 643): the funder is refunded the full
/// reward including the frozen fee — verification is never charged when it finds
/// failure — and the stake is slashed 50/50 (funder compensation / treasury).
/// Returns (funder_refund, funder_stake_back, treasury_stake_back).
pub fn settle_on_fail(reward: u64, stake: u64) -> MathResult<(u64, u64, u64)> {
    let funder_stake_back = stake / 2;
    let treasury_stake_back = stake - funder_stake_back; // odd stakes: treasury takes the remainder, as `stake - stake/2`
    Ok((reward, funder_stake_back, treasury_stake_back))
}

/// Deadline expiry (RewardMath row: gate 645): funder refunded in full including
/// the frozen fee (a fee frozen for work nobody verified was never earned —
/// gate 708); worker takes the stake back. Returns (funder_refund, stake_back).
pub fn settle_on_expiry(reward: u64, stake: u64) -> MathResult<(u64, u64)> {
    Ok((reward, stake))
}

/// Dispute overturn (RewardMath row: gate 646): full worker restitution —
/// reward AND stake — plus the dispute fee to the winning side. On the port the
/// dispute fee is forfeited to the protocol treasury because the resolve context
/// carries no disputer token account (spec, instruction section).
/// Returns (worker_restitution, winner_dispute_fee).
pub fn settle_on_dispute_overturn(reward: u64, stake: u64, dispute_fee: u64) -> MathResult<(u64, u64)> {
    Ok((checked_add(reward, stake)?, dispute_fee))
}

/// Stake floor (RewardMath row: gate 642): stake must cover the estimated
/// verification cost. k = 1 for v1, mirroring `stakeFloor`.
pub fn stake_floor(estimated_verification_cost: u64) -> u64 {
    estimated_verification_cost
}

/// Conservation predicate (gate 711, and RewardMath row: gate 647): what was
/// ever deposited must equal what the vault holds now plus everything that left.
/// `fees_held`/`pending` are parked subsets of the books, never additive — same
/// ghost-mirror semantics the Foundry suite checks on the EVM side.
pub fn conservation(deposited: u64, vault_now: u64, withdrawn: u64, swept: u64) -> bool {
    match withdrawn
        .checked_add(swept)
        .and_then(|out| vault_now.checked_add(out))
    {
        Some(total) => total == deposited,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every test below mirrors a row the Foundry suite asserts on the EVM side
    // (gate 716). The partition checks are the ones that catch a port drift:
    // each payout row must divide the pot exactly once, with no lamport created
    // or destroyed by the math itself.

    const REWARD: u64 = 1_000_000_007; // prime-ish: exercises rounding
    const STAKE: u64 = 250_000_003;
    const DISPUTE_FEE: u64 = 40_000;

    #[test]
    fn fee_is_five_percent_not_fifteen() {
        // The number AGENTS.md makes load-bearing: 500 bps. If this port ever
        // says 1500, it is the product pivot, not a refactor.
        assert_eq!(FEE_BPS, 500);
        let (_, fee) = split_post_work(10_000).unwrap();
        assert_eq!(fee, 500); // exactly 5%
    }

    #[test]
    fn split_truncates_like_solidity() {
        // Solidity: feeShare = reward * 500 / 10_000 (integer division, fee down).
        let (worker, fee) = split_post_work(REWARD).unwrap();
        assert_eq!(fee, REWARD * 500 / 10_000);
        assert_eq!(worker + fee, REWARD, "split must partition the reward");
        assert!(fee * 10_000 <= REWARD * 500, "fee must round down");
    }

    #[test]
    fn pass_row_partitions_the_pot() {
        let (worker_payout, fee_payout) = settle_on_pass(REWARD, STAKE).unwrap();
        assert_eq!(worker_payout, REWARD - REWARD * 500 / 10_000 + STAKE);
        assert_eq!(fee_payout, REWARD * 500 / 10_000);
        // pot = reward + stake; worker + treasury == pot.
        assert_eq!(worker_payout + fee_payout, REWARD + STAKE);
    }

    #[test]
    fn fail_row_refunds_fee_and_slashes_stake() {
        let (funder_refund, funder_stake, treasury_stake) = settle_on_fail(REWARD, STAKE).unwrap();
        assert_eq!(funder_refund, REWARD, "funder takes the full reward incl. frozen fee");
        assert_eq!(funder_stake, STAKE / 2);
        assert_eq!(treasury_stake, STAKE - STAKE / 2);
        assert_eq!(funder_refund + funder_stake + treasury_stake, REWARD + STAKE);
    }

    #[test]
    fn odd_stake_slash_gives_remainder_to_treasury() {
        let (_, f, t) = settle_on_fail(0, 7).unwrap();
        assert_eq!((f, t), (3, 4), "stake - stake/2, mirroring Solidity");
        assert_eq!(f + t, 7);
    }

    #[test]
    fn expiry_row_returns_everything() {
        let (funder_refund, stake_back) = settle_on_expiry(REWARD, STAKE).unwrap();
        assert_eq!(funder_refund, REWARD);
        assert_eq!(stake_back, STAKE);
        assert_eq!(funder_refund + stake_back, REWARD + STAKE, "nothing decays into the vault");
    }

    #[test]
    fn overturn_row_restitutes_worker_fully() {
        let (restitution, winner_fee) = settle_on_dispute_overturn(REWARD, STAKE, DISPUTE_FEE).unwrap();
        assert_eq!(restitution, REWARD + STAKE);
        assert_eq!(winner_fee, DISPUTE_FEE);
    }

    #[test]
    fn stake_floor_is_k_one() {
        assert_eq!(stake_floor(123_456), 123_456);
    }

    #[test]
    fn conservation_holds_and_catches() {
        assert!(conservation(100, 60, 30, 10));
        assert!(!conservation(100, 60, 30, 11), "one lamport out of place must fail");
        assert!(!conservation(100, 61, 30, 10));
        // overflow of the books side is a violation, not a pass
        assert!(!conservation(100, u64::MAX, 1, 1));
    }

    #[test]
    fn overflow_fails_closed() {
        assert_eq!(settle_on_pass(u64::MAX, 1), Err(MathError::Overflow));
        assert_eq!(settle_on_dispute_overturn(u64::MAX, 1, 0), Err(MathError::Overflow));
    }

    #[test]
    fn zero_reward_edge() {
        let (worker, fee) = split_post_work(0).unwrap();
        assert_eq!((worker, fee), (0, 0));
        let (payout, fee_payout) = settle_on_pass(0, 5).unwrap();
        assert_eq!((payout, fee_payout), (5, 0));
    }
}
