//! resolve_dispute — the recorded resolver authority (the committee/keeper, EVM:
//! Argus) applies the outcome. Worker wins: full restitution, dispute fee
//! forfeited to the treasury (the resolve context carries no disputer token
//! account — routing the fee anywhere else would need one; the spec records
//! that as the reason, not an apology). Worker loses: the fail row, plus the fee.

use crate::errors::EscrowError;
use crate::instructions::{assert_conservation, transfer_out};
use crate::math;
use crate::state::{Escrow, EscrowStatus};
use crate::ResolveDispute;
use anchor_lang::prelude::*;

pub fn handler(ctx: Context<ResolveDispute>, _work_id: u64, worker_won: bool) -> Result<()> {
    // (a) owned locals; the dispute fee is whatever the vault took beyond
    // reward + stake — the only amounts dispute() ever added.
    let escrow = &mut ctx.accounts.escrow;
    let reward = escrow.reward_amount;
    let stake = escrow.stake_amount;
    let dispute_fee = escrow
        .deposited
        .checked_sub(reward)
        .and_then(|x| x.checked_sub(stake))
        .ok_or(error!(EscrowError::MathOverflow))?;

    // (b) the row.
    let (worker_payout, funder_payout, treasury_payout) = if worker_won {
        let (restitution, winner_fee) =
            math::settle_on_dispute_overturn(reward, stake, dispute_fee)
                .map_err(|_| error!(EscrowError::MathOverflow))?;
        (restitution, 0, winner_fee)
    } else {
        let (refund, funder_stake, treasury_stake) =
            math::settle_on_fail(reward, stake).map_err(|_| error!(EscrowError::MathOverflow))?;
        let funder = refund
            .checked_add(funder_stake)
            .ok_or(error!(EscrowError::MathOverflow))?;
        let treasury = treasury_stake
            .checked_add(dispute_fee)
            .ok_or(error!(EscrowError::MathOverflow))?;
        (0, funder, treasury)
    };

    // (c) effects: books + close the overlay + terminal state.
    let add_withdrawn = worker_payout + funder_payout;
    escrow.withdrawn = escrow
        .withdrawn
        .checked_add(add_withdrawn)
        .ok_or(error!(EscrowError::MathOverflow))?;
    escrow.swept = escrow
        .swept
        .checked_add(treasury_payout)
        .ok_or(error!(EscrowError::MathOverflow))?;
    escrow.dispute_open = false;
    escrow.status = EscrowStatus::Settled;

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
    if worker_won {
        transfer_out(
            &vault_info,
            &ctx.accounts.worker_ata.to_account_info(),
            &escrow_info,
            seeds,
            worker_payout,
            &token_program,
        )?;
    } else {
        transfer_out(
            &vault_info,
            &ctx.accounts.funder_ata.to_account_info(),
            &escrow_info,
            seeds,
            funder_payout,
            &token_program,
        )?;
    }
    transfer_out(
        &vault_info,
        &ctx.accounts.treasury_ata.to_account_info(),
        &escrow_info,
        seeds,
        treasury_payout,
        &token_program,
    )?;

    // (f) conservation on the settled end-state.
    assert_conservation(deposited, withdrawn, swept, &vault_info)
}
