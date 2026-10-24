//! post_work — the worker commits: stake in, verdict hash recorded, fee
//! assessed and frozen. EVM rows: "postWork accepted: internal split" and
//! "Worker stakes: worker -> escrow.stakes".

use crate::errors::EscrowError;
use crate::instructions::{assert_conservation, transfer_in};
use crate::math;
use crate::state::EscrowStatus;
use crate::PostWork;
use anchor_lang::prelude::*;

pub fn handler(
    ctx: Context<PostWork>,
    _work_id: u64,
    stake: u64,
    verdict_hash: [u8; 32],
    claim_hash: [u8; 32],
) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;

    // Work cannot arrive after the funder's deadline — the Open-state expiry
    // (funder reclaim) is the only path once it passes. The deadline itself is
    // recorded at open, funder-controlled, mirroring the EVM law.
    let clock = Clock::get()?;
    if clock.slot >= escrow.expiry_slot {
        return Err(error!(EscrowError::DeadlinePassed));
    }

    // Gate 710: the stake must clear the floor recorded at open.
    if stake < escrow.stake_floor {
        return Err(error!(EscrowError::StakeBelowFloor));
    }
    // Gate 712: the verdict binding. The posted verdict hash is sha256 over the
    // JCS verdict body; the claim hash is what the grader's claim says. They
    // must agree now — a later mismatch at settle is the dispute trigger.
    if verdict_hash != claim_hash {
        return Err(error!(EscrowError::VerdictHashMismatch));
    }

    let deposited = escrow
        .deposited
        .checked_add(stake)
        .ok_or(error!(EscrowError::MathOverflow))?;

    // Effects first: freeze the fee (gate 707) and record the binding, then move.
    let (_, fee_share) = math::split_post_work(escrow.reward_amount)
        .map_err(|_| error!(EscrowError::MathOverflow))?;
    escrow.fee_held = fee_share;
    escrow.stake_amount = stake;
    escrow.deposited = deposited;
    escrow.verdict_hash = verdict_hash;
    escrow.status = EscrowStatus::Posted;

    transfer_in(
        &ctx.accounts.worker_ata.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.worker.to_account_info(),
        stake,
        &ctx.accounts.token_program.to_account_info(),
    )?;

    let (d, w, s) = (escrow.deposited, escrow.withdrawn, escrow.swept);
    assert_conservation(d, w, s, &ctx.accounts.vault.to_account_info())
}
