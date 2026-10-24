//! open_escrow — the funder commits the reward (fee inside it) and the escrow
//! records its floor. EVM row: "Escrow opened: funder -> escrow: reward".

use crate::errors::EscrowError;
use crate::instructions::{assert_conservation, transfer_in};
use crate::math;
use crate::state::{Escrow, EscrowStatus, ESCROW_VERSION};
use crate::OpenEscrow;
use anchor_lang::prelude::*;

pub fn handler(
    ctx: Context<OpenEscrow>,
    work_id: u64,
    estimated_verification_cost: u64,
    reward: u64,
    expiry_slots: u64,
) -> Result<()> {
    let bump = ctx.bumps.escrow;
    let clock = Clock::get()?;

    // Effects first (gate 714): the account is fully written before any value moves.
    let escrow = &mut ctx.accounts.escrow;
    **escrow = Escrow {
        version: ESCROW_VERSION,
        worker: ctx.accounts.worker.key(),
        funder: ctx.accounts.funder.key(),
        resolver: ctx.accounts.resolver.key(),
        work_id,
        mint: ctx.accounts.mint.key(),
        stake_floor: math::stake_floor(estimated_verification_cost),
        stake_amount: 0,
        reward_amount: reward,
        fee_held: 0,
        deposited: reward,
        withdrawn: 0,
        swept: 0,
        status: EscrowStatus::Open,
        dispute_open: false,
        verdict_hash: [0u8; 32],
        expiry_slot: clock
            .slot
            .checked_add(expiry_slots)
            .ok_or(error!(EscrowError::MathOverflow))?,
        bump,
    };

    // Value last: the reward transfer, fee carved from it, not added on top.
    transfer_in(
        &ctx.accounts.funder_ata.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.funder.to_account_info(),
        reward,
        &ctx.accounts.token_program.to_account_info(),
    )?;

    assert_conservation(reward, 0, 0, &ctx.accounts.vault.to_account_info())
}
