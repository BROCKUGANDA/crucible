//! Gate 703 — State machine for work-escrow.
//!
//! Single canonical machine merged from EscrowStatus + DisputeState:
//!   Open -> Running -> Disputed -> Terminal
//!   (Posted and VerdictPending are transitional states absorbed into
//!    post_work and settle instructions.)
//! Terminal: Settled-Pass, Settled-Fail, Settled-Split, Expired.
//!
//! Every transition runs checks -> effects -> interactions and asserts
//! conservation (gate 647). One in-flight transition per escrow.

use anchor_lang::prelude::*;
use crate::errors::ErrorCode;

/// Estimated slots per second on Solana devnet/mainnet.
///
/// Documented deviation from EVM block time: the deadline clock is measured in
/// slots, not seconds. `SLOTS_PER_SECOND_ESTIMATE = 2` is the planning figure;
/// the actual slot rate can drift, so the reference slot is stored per-escrow
/// and can be updated via `set_clock_slot` (gate: runtime-updatable clock parameter).
pub const SLOTS_PER_SECOND_ESTIMATE: i64 = 2;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EscrowStatus {
    Open,
    Posted,
    Running,
    VerdictPending,
    Disputed,
    SettledPass,
    SettledFail,
    SettledSplit,
    Expired,
}

impl EscrowStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            EscrowStatus::SettledPass
                | EscrowStatus::SettledFail
                | EscrowStatus::SettledSplit
                | EscrowStatus::Expired
        )
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum DisputeState {
    None,
    Opened,
    Resolved,
}

#[account]
#[derive(InitSpace)]
pub struct GhostLedger {
    pub deposited: u64,
    pub withdrawn: u64,
    pub swept: u64,
}

impl GhostLedger {
    pub fn net(&self) -> u64 {
        self.deposited
            .checked_sub(self.withdrawn)
            .and_then(|v| v.checked_sub(self.swept))
            .expect("ghost ledger underflow")
    }
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub version: u8, // explicit version tag for future migrations (gate 704)
    pub bump: u8,
    pub work_id: u64,
    pub client: Pubkey,
    pub worker: Pubkey,
    pub reward: u64,
    pub stake: u64,
    pub fee: u64,
    pub suite_root: [u8; 32],
    pub result_hash: [u8; 32],
    pub verdict_hash: [u8; 32],
    pub deadline_slot: i64,
    pub clock_slot: i64, // reference slot for deadline math; set at open, updatable via set_clock_slot
    pub status: EscrowStatus,
    pub dispute_state: DisputeState,
    pub dispute_fee: u64,
    pub ghost_ledger: GhostLedger,
}

impl Escrow {
    /// Guard: transition only from `from` to `to`, assert conservation.
    pub fn assert_transition(&self, from: EscrowStatus, to: EscrowStatus) -> Result<()> {
        require!(
            self.status == from,
            ErrorCode::IllegalTransition
        );
        assert_conservation(self)?;
        Ok(())
    }
}

/// Conservation invariant: deposited == vault_now + withdrawn + swept (gate 647).
/// Gas never enters this math. fees_held and pending_held are parked subsets of
/// the vault balance, not additive ledgers (ghost-mirror semantics).
pub fn assert_conservation(escrow: &Escrow) -> Result<()> {
    // vault_now = current holdings = reward + stake + dispute_fee (parked fees
    // are a subset of reward, not additive).
    let vault_now = escrow
        .reward
        .checked_add(escrow.stake)
        .and_then(|v| v.checked_add(escrow.dispute_fee))
        .expect("vault balance overflow");
    // deposited = total in; withdrawn + swept = total out; vault_now = remaining.
    let total_out = escrow
        .ghost_ledger
        .withdrawn
        .checked_add(escrow.ghost_ledger.swept)
        .expect("total out overflow");
    let expected_deposited = vault_now
        .checked_add(total_out)
        .expect("conservation sum overflow");
    require!(
        escrow.ghost_ledger.deposited == expected_deposited,
        ErrorCode::ConservationViolation
    );
    Ok(())
}
