//! Instruction handlers. Each mutating instruction writes state first, moves
//! value last, and asserts the conservation predicate at its very end (gates
//! 711, 714) — a Solana transaction is atomic, so the late assert reverts the
//! transfers too and verifies the settled end-state, not the optimistic one.

pub mod dispute;
pub mod expire;
pub mod open_escrow;
pub mod post_work;
pub mod resolve_dispute;
pub mod settle;

use crate::errors::EscrowError;
use crate::math;
use anchor_lang::prelude::*;
use anchor_spl::token::Transfer;

/// Refreshes the vault's balance after a CPI and asserts the conservation
/// predicate: deposited == vault_now + withdrawn + swept. The ghost-ledger
/// fields are ordinary account state (written before any transfer), so this
/// reads the settled truth, and any lamport the books cannot explain fails
/// the whole transaction with a named error.
///
/// The vault amount is read from the classic SPL token account layout at its
/// frozen offset (mint 32 + owner 32, then u64 LE amount) — anchor 0.30 has no
/// refresh helper for `Account<TokenAccount>`, and this layout is part of the
/// deployed token program's compatibility contract.
pub fn assert_conservation(
    deposited: u64,
    withdrawn: u64,
    swept: u64,
    vault_info: &AccountInfo,
) -> Result<()> {
    let data = vault_info
        .try_borrow_data()
        .map_err(|_| error!(EscrowError::ConservationViolated))?;
    let bytes: [u8; 8] = data
        .get(64..72)
        .and_then(|s| <[u8; 8]>::try_from(s).ok())
        .ok_or_else(|| error!(EscrowError::ConservationViolated))?;
    let vault_now = u64::from_le_bytes(bytes);
    if !math::conservation(deposited, vault_now, withdrawn, swept) {
        return Err(error!(EscrowError::ConservationViolated));
    }
    Ok(())
}

/// Transfers `amount` into the vault from a user-owned token account.
pub fn transfer_in<'info>(
    from: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    token_program: &AccountInfo<'info>,
) -> Result<()> {
    let cpi = CpiContext::new(
        token_program.clone(),
        Transfer {
            from: from.clone(),
            to: vault.clone(),
            authority: authority.clone(),
        },
    );
    anchor_spl::token::transfer(cpi, amount)
}

/// Transfers `amount` out of the PDA-owned vault. The escrow PDA is the vault's
/// token authority, so this signs with the escrow seeds (gate 706: the only
/// spend path is a program instruction that enforces the state machine).
///
/// `seeds` must be freshly built at the call site (owned locals) so no borrow
/// of the escrow account outlives the state writes that precede value movement.
/// `seeds` is ONE PDA's seed slices; bound in a local array so the outer
/// reference outlives the CpiContext (new_with_signer takes `&[&[&[u8]]]`).
pub fn transfer_out<'info>(
    vault: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    escrow_info: &AccountInfo<'info>,
    seeds: &[&[u8]],
    amount: u64,
    token_program: &AccountInfo<'info>,
) -> Result<()> {
    let signers: [&[&[u8]]; 1] = [seeds];
    let cpi = CpiContext::new_with_signer(
        token_program.clone(),
        Transfer {
            from: vault.clone(),
            to: to.clone(),
            authority: escrow_info.clone(),
        },
        &signers,
    );
    anchor_spl::token::transfer(cpi, amount)
}
