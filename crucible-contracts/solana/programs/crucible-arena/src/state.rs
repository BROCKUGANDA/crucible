//! Account state for crucible-arena (§9.1). Layouts are minimal but typed; fields
//! grow as handlers land. All amounts are in the trial mint's base units.

use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

pub const TRIAL_SEED: &[u8] = b"trial";
pub const VAULT_SEED: &[u8] = b"vault";
pub const CLAIM_SEED: &[u8] = b"claim";
pub const CONFIG_SEED: &[u8] = b"config";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum TrialStatus {
    #[default]
    Open,
    Claimed,
    Submitted,
    Docketed,
    Panel,
    Settled,
    Cancelled,
    Expired,
}

impl anchor_lang::Space for TrialStatus {
    const INIT_SPACE: usize = 1;
}

#[account]
#[derive(Default, InitSpace)]
pub struct Config {
    pub bump: u8,
    pub paused: bool,
    pub authority: Pubkey,
}

#[account]
#[derive(Default, InitSpace)]
pub struct Trial {
    pub bump: u8,
    pub sponsor: Pubkey,
    pub status: TrialStatus,
    pub ever_claimed: bool,
    pub reward: u64,
    pub fee: u64,
    pub deposited: u64,
    pub paid_out: u64,
    pub opened_at: i64,
    pub open_until: i64,
    pub skeptic_window: u32,
    pub claim_deadline: i64,
    pub agent: Pubkey,
    pub runner_key: Pubkey,
    pub bond: u64,
    pub active_counted: bool,
    pub spec_digest: [u8; 32],
    pub suite_digest: [u8; 32],
    pub holdout_commitment: [u8; 32],
    pub nonce: u64,
    pub submitted_at: i64,
    pub window_end: i64,
    pub holdout_due_by: i64,
    pub run_hash: [u8; 32],
    pub verdict_hash: [u8; 32],
    pub replay_hash: [u8; 32],
    pub model_harness_id: [u8; 32],
    pub break_count: u16,
    pub docket_frozen: bool,
    pub docket_size: u8,
    pub mint: Pubkey,
    pub claim_span_override: u32,
}

#[account]
#[derive(Default, InitSpace)]
pub struct Claim {
    pub bump: u8,
    pub trial: Pubkey,
    pub agent: Pubkey,
    pub bond: u64,
    pub claim_deadline: i64,
    pub identity_epoch: u64,
    pub runner_key: Pubkey,
}

#[account]
#[derive(Default, InitSpace)]
pub struct Break {
    pub bump: u8,
    pub trial: Pubkey,
    pub skeptic: Pubkey,
    pub commitment: [u8; 32],
    pub stake: u64,
    pub seat_fee: u64,
    pub committed_at: i64,
    pub revealed: bool,
    pub revealed_type: u8,
    pub evidence_digest: [u8; 32],
    pub salt: [u8; 32],
    pub settled: bool,
}

// Vault is a TokenAccount (PDA-owned); no separate struct needed.
pub type Vault = TokenAccount;
