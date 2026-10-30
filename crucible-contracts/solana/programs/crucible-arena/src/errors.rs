//! CRUCIBLE arena error codes (mirrors EVM custom errors; see §9.7).

use anchor_lang::prelude::*;

#[error_code]
pub enum ArenaError {
    #[msg("unsupported mint or forbidden extension")]
    UnsupportedMint,
    #[msg("trial not open")]
    TrialNotOpen,
    #[msg("illegal state transition")]
    IllegalTransition,
    #[msg("not enough seats")]
    NotEnoughSeats,
    #[msg("randomness not configured")]
    RandomnessNotConfigured,
    #[msg("bond shortfall")]
    BondShortfall,
    #[msg("dispute open")]
    DisputeOpen,
    #[msg("not disputed")]
    NotDisputed,
    #[msg("payout account mismatch")]
    PayoutAccountMismatch,
    #[msg("claim timeout")]
    ClaimTimeout,
    #[msg("unrevealed commit")]
    UnrevealedCommit,
    #[msg("overflow")]
    Overflow,
}
