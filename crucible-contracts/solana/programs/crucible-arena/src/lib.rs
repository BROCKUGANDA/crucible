//! CRUCIBLE arena, Solana side (gates 734-746, 748-751, 753, 783).
//!
//! Scaffold only: account and instruction stubs. Full handlers land per phase
//! (P4 core: post/claim/submit/settle/timeouts; then breaks, panels, standing).
//! Spec: v2 bible §9 (accounts, seeds, instructions, credential, clock).

pub mod errors;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use state::Config;

// Program id generated on 2026-10-30 (solana-keygen). Keypair lives in the build
// host's target/deploy (gitignored) and must be backed up before deploy (gate 731).
declare_id!("AikvHhtXSuZ8PuKoqYG5WASJGWTEu4RQYmYbeSzoPLJV");

#[program]
pub mod crucible_arena {
    use super::*;

    pub fn init_config(ctx: Context<InitConfig>) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.bump = ctx.bumps.config;
        cfg.paused = false;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        seeds = [b"config"],
        bump,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}
