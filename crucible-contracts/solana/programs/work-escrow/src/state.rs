//! Escrow account state — mirrors the EVM struct field-for-field, plus the
//! ghost-ledger fields the conservation predicate reads (gates 704, 711).

use anchor_lang::prelude::*;

/// Explicit layout version. A future migration bumps this and says how, in
/// writing, before any account is resized (gate 704).
pub const ESCROW_VERSION: u8 = 1;

/// Slots per second at the 400ms target — the one consensus-visible constant
/// every expiry comparison goes through (gate 713). Solana has no oracle-free
/// wall clock; this estimate is the documented stand-in, and changing it is a
/// spec-table change, not a tune-up.
pub const SLOTS_PER_SECOND_ESTIMATE: u64 = 2; // 1 slot / 400ms target ≈ 2.5; pinned low deliberately

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EscrowStatus {
    /// Created and funded with the reward (fee inside it); floor recorded.
    Open,
    /// Stake in the vault too; verdict hash and expiry recorded.
    Posted,
    /// Terminal: pass or fail (or dispute) paid out.
    Settled,
    /// Terminal: deadline crank ran.
    Expired,
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    /// Layout tag — gate 704.
    pub version: u8,
    /// The worker this escrow is seeded against (`["escrow", worker, work_id]`).
    pub worker: Pubkey,
    /// Who posted the money and receives fail/expiry refunds.
    pub funder: Pubkey,
    /// Committee/keeper authority that may resolve a dispute (EVM: Argus).
    pub resolver: Pubkey,
    /// External work identifier, part of the PDA seeds.
    pub work_id: u64,
    /// SPL token mint — classic Token program only in v1 (gate 719).
    pub mint: Pubkey,
    /// Stake floor computed at open from the published cost estimate (gate 710).
    pub stake_floor: u64,
    /// Worker's stake, must clear the floor at post_work.
    pub stake_amount: u64,
    /// Full posted reward; the fee is carved from this, never added on top.
    pub reward_amount: u64,
    /// Fee assessed and frozen at post_work — a field, not an implication (gate 707).
    pub fee_held: u64,
    /// Ghost ledger: total ever transferred into the vault (reward + stake + dispute fees).
    pub deposited: u64,
    /// Ghost ledger: total transferred out to parties.
    pub withdrawn: u64,
    /// Ghost ledger: total transferred out to the protocol treasury.
    pub swept: u64,
    pub status: EscrowStatus,
    /// Dispute overlay — settle is blocked while open.
    pub dispute_open: bool,
    /// sha256 over the JCS verdict body — the triple-identity binding (gate 712).
    pub verdict_hash: [u8; 32],
    /// Slot after which the expiry crank may fire.
    pub expiry_slot: u64,
    /// The escrow PDA's canonical bump, stored so every sign-out uses it.
    pub bump: u8,
}
