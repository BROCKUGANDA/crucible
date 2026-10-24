//! dispute — opens the overlay and escrows the disputer's fee into the same
//! vault. Settlement is blocked while the overlay is open.

use crate::errors::EscrowError;
use crate::instructions::{assert_conservation, transfer_in};
use crate::state::{Escrow, EscrowStatus};
use crate::Dispute;
use anchor_lang::prelude::*;

pub fn handler(ctx: Context<Dispute>, _work_id: u64, dispute_fee: u64) -> Result<()> {
    if dispute_fee == 0 {
        return Err(error!(EscrowError::IllegalTransition));
    }
    let escrow = &mut ctx.accounts.escrow;
    escrow.deposited = escrow
        .deposited
        .checked_add(dispute_fee)
        .ok_or(error!(EscrowError::MathOverflow))?;
    escrow.dispute_open = true;

    transfer_in(
        &ctx.accounts.disputer_ata.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.disputer.to_account_info(),
        dispute_fee,
        &ctx.accounts.token_program.to_account_info(),
    )?;

    let (deposited, withdrawn, swept) = (escrow.deposited, escrow.withdrawn, escrow.swept);
    assert_conservation(
        deposited,
        withdrawn,
        swept,
        &ctx.accounts.vault.to_account_info(),
    )
}
