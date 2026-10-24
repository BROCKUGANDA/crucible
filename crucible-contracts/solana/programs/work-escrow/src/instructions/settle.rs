//! settle — permissionless (any caller may submit a claim), live-only: blocked
//! while a dispute is open and after the deadline. A PASS requires the claim
//! hash to equal the verdict hash posted at post_work (gate 712); a mismatch is
//! a typed rejection the client routes to `dispute`.

use crate::errors::EscrowError;
use crate::instructions::{assert_conservation, transfer_out};
use crate::math;
use crate::state::{Escrow, EscrowStatus};
use crate::Settle;
use anchor_lang::prelude::*;

pub fn handler(ctx: Context<Settle>, _work_id: u64, pass: bool, claim_hash: [u8; 32]) -> Result<()> {
    let clock = Clock::get()?;
    if clock.slot >= ctx.accounts.escrow.expiry_slot {
        return Err(error!(EscrowError::DeadlinePassed));
    }

    // (a) read everything into owned locals — no borrows held across writes.
    let escrow = &mut ctx.accounts.escrow;
    let reward = escrow.reward_amount;
    let stake = escrow.stake_amount;
    if pass && claim_hash != escrow.verdict_hash {
        return Err(error!(EscrowError::VerdictHashMismatch));
    }

    // (b) compute the row.
    let (worker_payout, fee_payout, funder_total, treasury_stake) = if pass {
        let (w, f) = math::settle_on_pass(reward, stake).map_err(|_| error!(EscrowError::MathOverflow))?;
        (w, f, 0, 0)
    } else {
        let (refund, funder_stake, t_stake) =
            math::settle_on_fail(reward, stake).map_err(|_| error!(EscrowError::MathOverflow))?;
        let funder = refund
            .checked_add(funder_stake)
            .ok_or(error!(EscrowError::MathOverflow))?;
        (0, 0, funder, t_stake)
    };

    // (c) effects: books + terminal state, before any value moves (gate 714).
    let (add_withdrawn, add_swept) = if pass {
        (worker_payout, fee_payout)
    } else {
        (funder_total, treasury_stake)
    };
    escrow.withdrawn = escrow
        .withdrawn
        .checked_add(add_withdrawn)
        .ok_or(error!(EscrowError::MathOverflow))?;
    escrow.swept = escrow
        .swept
        .checked_add(add_swept)
        .ok_or(error!(EscrowError::MathOverflow))?;
    escrow.status = EscrowStatus::Settled;

    // (d) owned seed bytes + account infos, built after the writes.
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

    // (e) value last: the transfers that partition the pot exactly once.
    if pass {
        transfer_out(
            &vault_info,
            &ctx.accounts.worker_ata.to_account_info(),
            &escrow_info,
            seeds,
            worker_payout,
            &token_program,
        )?;
        transfer_out(
            &vault_info,
            &ctx.accounts.treasury_ata.to_account_info(),
            &escrow_info,
            seeds,
            fee_payout,
            &token_program,
        )?;
    } else {
        transfer_out(
            &vault_info,
            &ctx.accounts.funder_ata.to_account_info(),
            &escrow_info,
            seeds,
            funder_total,
            &token_program,
        )?;
        transfer_out(
            &vault_info,
            &ctx.accounts.treasury_ata.to_account_info(),
            &escrow_info,
            seeds,
            treasury_stake,
            &token_program,
        )?;
    }

    // (f) the conservation read, on the settled end-state.
    assert_conservation(deposited, withdrawn, swept, &vault_info)
}
