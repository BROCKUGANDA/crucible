//! expire — the permissionless crank. After the expiry slot anyone may fire it:
//! a Posted escrow refunds the funder in full (including the frozen fee — a fee
//! frozen for work nobody verified was never earned, gate 708) and returns the
//! worker's stake; an Open escrow that never received work reclaims the reward.

use crate::errors::EscrowError;
use crate::instructions::{assert_conservation, transfer_out};
use crate::math;
use crate::state::{Escrow, EscrowStatus};
use crate::Expire;
use anchor_lang::prelude::*;

pub fn handler(ctx: Context<Expire>, _work_id: u64) -> Result<()> {
    let clock = Clock::get()?;

    // (a) owned locals.
    let escrow = &mut ctx.accounts.escrow;
    if clock.slot < escrow.expiry_slot {
        return Err(error!(EscrowError::DeadlineNotPassed));
    }
    let was_open = escrow.status == EscrowStatus::Open;
    let (funder_refund, stake_back) = if was_open {
        // No work ever arrived: the funder reclaims the reward, fee included.
        (escrow.reward_amount, 0)
    } else {
        math::settle_on_expiry(escrow.reward_amount, escrow.stake_amount)
            .map_err(|_| error!(EscrowError::MathOverflow))?
    };

    // (c) effects.
    escrow.withdrawn = escrow
        .withdrawn
        .checked_add(funder_refund)
        .and_then(|x| x.checked_add(stake_back))
        .ok_or(error!(EscrowError::MathOverflow))?;
    escrow.status = EscrowStatus::Expired;

    // (d) owned seeds + infos after the writes.
    let worker_bytes = escrow.worker.to_bytes();
    let work_bytes = escrow.work_id.to_le_bytes();
    let bump = [escrow.bump];
    let seeds: &[&[u8]] = &[b"escrow", &worker_bytes, &work_bytes, &bump];
    let escrow_info = escrow.to_account_info();
    let vault_info = ctx.accounts.vault.to_account_info();
    let token_program = ctx.accounts.token_program.to_account_info();
    let deposited = escrow.deposited;
    let withdrawn = escrow.withdrawn;
    let swept = escrow.swept;

    // (e) value last.
    transfer_out(
        &vault_info,
        &ctx.accounts.funder_ata.to_account_info(),
        &escrow_info,
        seeds,
        funder_refund,
        &token_program,
    )?;
    if !was_open {
        transfer_out(
            &vault_info,
            &ctx.accounts.worker_ata.to_account_info(),
            &escrow_info,
            seeds,
            stake_back,
            &token_program,
        )?;
    }

    // (f) conservation on the settled end-state.
    assert_conservation(deposited, withdrawn, swept, &vault_info)
}
