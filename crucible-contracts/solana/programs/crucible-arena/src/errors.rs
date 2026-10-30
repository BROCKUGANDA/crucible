//! CRUCIBLE arena error codes (mirrors EVM custom errors; §9.7).

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
    #[msg("stake too small")]
    StakeTooSmall,
    #[msg("too small")]
    TooSmall,
    #[msg("bad window")]
    BadWindow,
    #[msg("bad open span")]
    BadOpenSpan,
    #[msg("reward too small")]
    RewardTooSmall,
    #[msg("reward mismatch (must be R + F)")]
    RewardMismatch,
    #[msg("already claimed")]
    AlreadyClaimed,
    #[msg("claim window closed")]
    ClaimWindowClosed,
    #[msg("self claim not allowed")]
    SelfClaim,
    #[msg("too many active claims")]
    TooManyActiveClaims,
    #[msg("yield cooldown")]
    YieldCooldown,
    #[msg("window still open")]
    WindowStillOpen,
    #[msg("spec or suite digest zero")]
    ZeroDigest,
    #[msg("bad signer")]
    BadSigner,
    #[msg("overflow")]
    Overflow,
}
