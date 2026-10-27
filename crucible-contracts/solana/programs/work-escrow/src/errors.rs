//! Typed fail-closed error table (gate 705). Names follow the EVM contract's
//! error vocabulary (NotOpen, DeadlinePassed, AlreadySettled, ...) so a failure
//! reads identically on both chains.

use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("Escrow is not in the state this instruction requires (illegal transition)")]
    IllegalTransition,
    #[msg("Escrow is not Open")]
    NotOpen,
    #[msg("Escrow is not Posted")]
    NotPosted,
    #[msg("Escrow already settled")]
    AlreadySettled,
    #[msg("Escrow already expired")]
    AlreadyExpired,
    #[msg("A dispute is open; settle is blocked until it resolves")]
    DisputeOpen,
    #[msg("No dispute is open to resolve")]
    NotDisputed,
    #[msg("Deadline has not passed yet")]
    DeadlineNotPassed,
    #[msg("Deadline has passed; this path is closed")]
    DeadlinePassed,
    #[msg("Claim hash does not match the verdict hash posted at post_work")]
    VerdictHashMismatch,
    #[msg("Stake is below the published floor (k x estimated verification cost)")]
    StakeBelowFloor,
    #[msg("Checked u64 math overflowed — fail closed")]
    MathOverflow,
    #[msg("Conservation predicate violated: deposited != vault + withdrawn + swept")]
    ConservationViolated,
    #[msg("Payout account is not owned by the principal recorded at open (gate 837)")]
    PayoutAccountMismatch,
    #[msg("Mint is not the classic SPL Token program mint (Token-2022 extensions are not handled in v1)")]
    UnsupportedMint,
}
