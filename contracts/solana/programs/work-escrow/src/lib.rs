//! Gate 701 — work-escrow Anchor program entry point.
//!
//! Seven instructions: open, post_work, settle, dispute, resolve, expire, set_clock_slot.
//! Serial writer: exactly one signer (client/worker/resolver) mutates the escrow PDA.

use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("PLACEHOLDER_REPLACE_WITH_REAL_KEYPAIR_PUBKEY");

#[program]
pub mod work_escrow {
    use super::*;

    pub fn open(ctx: Context<Open>, args: instructions::OpenArgs) -> Result<()> {
        instructions::open(ctx, args)
    }

    pub fn post_work(ctx: Context<PostWork>, args: instructions::PostWorkArgs) -> Result<()> {
        instructions::post_work(ctx, args)
    }

    pub fn settle(ctx: Context<Settle>, args: instructions::SettleArgs) -> Result<()> {
        instructions::settle(ctx, args)
    }

    pub fn dispute(ctx: Context<Dispute>, args: instructions::DisputeArgs) -> Result<()> {
        instructions::dispute(ctx, args)
    }

    pub fn resolve(ctx: Context<Resolve>, args: instructions::ResolveArgs) -> Result<()> {
        instructions::resolve(ctx, args)
    }

    pub fn expire(ctx: Context<Expire>) -> Result<()> {
        instructions::expire(ctx)
    }

    /// Set the reference slot used for deadline math (gate: runtime-updatable clock).
    pub fn set_clock_slot(ctx: Context<SetClockSlot>, args: instructions::SetClockSlotArgs) -> Result<()> {
        instructions::set_clock_slot(ctx, args)
    }
}
