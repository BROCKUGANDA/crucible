//! Gate 703 — Error codes for work-escrow, mirroring the EVM custom-error set.
//! 13 codes matching the EVM table (gate 725 parity test checks this count).

use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Reward must be greater than zero")]
    RewardZero = 6001,
    #[msg("Stake below floor: stake >= k * estimated verification cost")]
    StakeFloorViolation = 6002,
    #[msg("Deadline has already passed")]
    DeadlinePassed = 6003,
    #[msg("Illegal state transition for this escrow")]
    IllegalTransition = 6004,
    #[msg("Escrow not in Posted state")]
    NotPosted = 6005,
    #[msg("Escrow not in Running state")]
    NotRunning = 6006,
    #[msg("Escrow not in VerdictPending state")]
    NotVerdictPending = 6007,
    #[msg("Escrow not in Disputed state")]
    NotDisputed = 6008,
    #[msg("Escrow already terminal")]
    AlreadyTerminal = 6009,
    #[msg("Only the worker may post work")]
    NotWorker = 6010,
    #[msg("Only the client may open or expire")]
    NotClient = 6011,
    #[msg("Conservation invariant violated")]
    ConservationViolation = 6012,
    #[msg("Verdict hash mismatch: recomputed hash does not match on-chain")]
    VerdictHashMismatch = 6013,
}
