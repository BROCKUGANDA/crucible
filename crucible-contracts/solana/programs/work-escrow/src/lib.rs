//! CRUCIBLE work escrow, Solana side — the EVM reward flow table as an Anchor
//! program (gates 701-720, spec: crucible-contracts/solana/README.md).
//!
//! A mirror, not a mutation: same state machine (Open -> Posted -> Settled or
//! Expired, Disputed as an overlay that can only exist while Posted), same math
//! (RewardMath ported function-for-function in `math.rs`), same fail-closed
//! posture. Deviations the two chains force are written down in the README's
//! deviation table, each with its reason.
//!
//! Layout note: anchor 0.30.1's program macro resolves the generated
//! `__client_accounts_*` modules from the crate root, so every Accounts struct
//! is defined HERE, at the root, with the handler bodies living in
//! `instructions/` — the canonical 0.30.1 shape, not a style choice.

pub mod errors;
pub mod instructions;
pub mod math;
pub mod state;

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};
use errors::EscrowError;
use state::{Escrow, EscrowStatus};

// The localnet program id, kept in sync with target/deploy/work_escrow-keypair.json
// via `anchor keys sync`. Localnet ids are per-environment (the keypair is generated
// on first build and gitignored); what is pinned and reproducible is the toolchain.
declare_id!("AnctSTeT8TNQ4riTxkh8Kh8hKpQGfmhQjhd3M15VaJAD");

// ---------------------------------------------------------------------------
// Accounts structs (crate root — see the layout note above)
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(work_id: u64)]
pub struct OpenEscrow<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,

    /// The seed identity of the worker this escrow belongs to.
    /// CHECK: only used as a PDA seed and stored; never signs, never pays.
    pub worker: UncheckedAccount<'info>,

    /// Committee/keeper authority recorded for resolve_dispute (EVM: Argus).
    /// CHECK: stored only; verified by signature at resolve time.
    pub resolver: UncheckedAccount<'info>,

    #[account(
        constraint = mint.to_account_info().owner == &token_program.to_account_info().key()
            @ EscrowError::UnsupportedMint
    )]
    pub mint: Account<'info, Mint>,

    #[account(
        init,
        seeds = [b"escrow", worker.key().as_ref(), &work_id.to_le_bytes()],
        bump,
        payer = funder,
        space = 8 + Escrow::INIT_SPACE,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        init,
        seeds = [b"vault", escrow.key().as_ref()],
        bump,
        payer = funder,
        token::mint = mint,
        token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = funder_ata.mint == mint.key(),
        constraint = funder_ata.owner == funder.key(),
    )]
    pub funder_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(work_id: u64)]
pub struct PostWork<'info> {
    #[account(mut)]
    pub worker: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", worker.key().as_ref(), &work_id.to_le_bytes()],
        bump = escrow.bump,
        constraint = escrow.status == EscrowStatus::Open @ EscrowError::NotOpen,
        constraint = escrow.worker == worker.key(),
        constraint = escrow.mint == mint.key(),
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = worker_ata.mint == mint.key(),
        constraint = worker_ata.owner == worker.key(),
    )]
    pub worker_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(work_id: u64)]
pub struct Settle<'info> {
    /// Any account may settle — the verdict hash is the authorization.
    pub caller: Signer<'info>,

    /// CHECK: seed identity only; matches the stored worker.
    pub worker: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"escrow", worker.key().as_ref(), &work_id.to_le_bytes()],
        bump = escrow.bump,
        constraint = escrow.status == EscrowStatus::Posted @ EscrowError::IllegalTransition,
        constraint = !escrow.dispute_open @ EscrowError::DisputeOpen,
        constraint = escrow.mint == mint.key(),
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(mut, constraint = worker_ata.mint == mint.key())]
    pub worker_ata: Account<'info, TokenAccount>,

    #[account(mut, constraint = funder_ata.mint == mint.key())]
    pub funder_ata: Account<'info, TokenAccount>,

    /// Protocol treasury — the fee's destination.
    #[account(mut, constraint = treasury_ata.mint == mint.key())]
    pub treasury_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(work_id: u64)]
pub struct Dispute<'info> {
    #[account(mut)]
    pub disputer: Signer<'info>,

    /// CHECK: seed identity only; matches the stored worker.
    pub worker: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"escrow", worker.key().as_ref(), &work_id.to_le_bytes()],
        bump = escrow.bump,
        constraint = escrow.status == EscrowStatus::Posted @ EscrowError::NotPosted,
        constraint = !escrow.dispute_open @ EscrowError::DisputeOpen,
        constraint = escrow.mint == mint.key(),
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = disputer_ata.mint == mint.key(),
        constraint = disputer_ata.owner == disputer.key(),
    )]
    pub disputer_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(work_id: u64)]
pub struct ResolveDispute<'info> {
    /// Must be the resolver recorded at open — the dispute authority.
    pub resolver: Signer<'info>,

    /// CHECK: seed identity only; matches the stored worker.
    pub worker: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"escrow", worker.key().as_ref(), &work_id.to_le_bytes()],
        bump = escrow.bump,
        constraint = escrow.status == EscrowStatus::Posted @ EscrowError::NotPosted,
        constraint = escrow.dispute_open @ EscrowError::NotDisputed,
        constraint = escrow.resolver == resolver.key(),
        constraint = escrow.mint == mint.key(),
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(mut, constraint = worker_ata.mint == mint.key())]
    pub worker_ata: Account<'info, TokenAccount>,

    #[account(mut, constraint = funder_ata.mint == mint.key())]
    pub funder_ata: Account<'info, TokenAccount>,

    #[account(mut, constraint = treasury_ata.mint == mint.key())]
    pub treasury_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(work_id: u64)]
pub struct Expire<'info> {
    /// Anyone may crank the expiry — permissionless by law.
    pub caller: Signer<'info>,

    /// CHECK: seed identity only; matches the stored worker.
    pub worker: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"escrow", worker.key().as_ref(), &work_id.to_le_bytes()],
        bump = escrow.bump,
        constraint = escrow.status == EscrowStatus::Open || escrow.status == EscrowStatus::Posted
            @ EscrowError::IllegalTransition,
        constraint = !escrow.dispute_open @ EscrowError::DisputeOpen,
        constraint = escrow.mint == mint.key(),
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(mut, constraint = worker_ata.mint == mint.key())]
    pub worker_ata: Account<'info, TokenAccount>,

    #[account(mut, constraint = funder_ata.mint == mint.key())]
    pub funder_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[program]
pub mod work_escrow {
    use super::*;

    /// Funder commits the reward (fee inside it); escrow + PDA-owned vault are
    /// created; the stake floor is computed and recorded.
    pub fn open_escrow(
        ctx: Context<OpenEscrow>,
        work_id: u64,
        estimated_verification_cost: u64,
        reward: u64,
        expiry_slots: u64,
    ) -> Result<()> {
        instructions::open_escrow::handler(ctx, work_id, estimated_verification_cost, reward, expiry_slots)
    }

    /// Worker commits: stake in (must clear the floor), verdict hash + claim
    /// hash recorded and cross-checked, fee assessed and frozen, status Posted.
    pub fn post_work(
        ctx: Context<PostWork>,
        work_id: u64,
        stake: u64,
        verdict_hash: [u8; 32],
        claim_hash: [u8; 32],
    ) -> Result<()> {
        instructions::post_work::handler(ctx, work_id, stake, verdict_hash, claim_hash)
    }

    /// Permissionless settlement. PASS requires the claim hash to match the
    /// posted verdict hash; a mismatch is a typed rejection, not a payout.
    pub fn settle(ctx: Context<Settle>, work_id: u64, pass: bool, claim_hash: [u8; 32]) -> Result<()> {
        instructions::settle::handler(ctx, work_id, pass, claim_hash)
    }

    /// Opens the dispute overlay; escrows the disputer's fee into the vault.
    pub fn dispute(ctx: Context<Dispute>, work_id: u64, dispute_fee: u64) -> Result<()> {
        instructions::dispute::handler(ctx, work_id, dispute_fee)
    }

    /// Resolver authority applies the outcome; the fail row or full restitution.
    pub fn resolve_dispute(ctx: Context<ResolveDispute>, work_id: u64, worker_won: bool) -> Result<()> {
        instructions::resolve_dispute::handler(ctx, work_id, worker_won)
    }

    /// Permissionless expiry crank: refunds everything, frozen fee included.
    pub fn expire(ctx: Context<Expire>, work_id: u64) -> Result<()> {
        instructions::expire::handler(ctx, work_id)
    }
}
