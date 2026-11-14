//! CRUCIBLE arena, Solana side (gates 734-746, 748-751, 753, 783).
//! Native-SOL escrow: the trial PDA itself holds lamports (no SPL token accounts).

pub mod errors;
pub mod params;
pub mod state;

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;
use errors::ArenaError;
use params::*;
use state::*;

declare_id!("AikvHhtXSuZ8PuKoqYG5WASJGWTEu4RQYmYbeSzoPLJV");

// The ed25519 precompile (`Ed25519SigVerify111111111111111111111111111`), verified
// against https://solana.com/docs/core/programs/precompiles.
//
// This was previously a placeholder — `0xED, 0x25, 0x51, 0x90, 0…` — that matches no
// program on any Solana cluster. `submit_run` compares the instruction it introspects
// against this constant, so with the placeholder every genuine ed25519 instruction was
// rejected as a bad signer: no run could be submitted, and a posted bond or reward could
// never reach settlement. Nothing caught it because the arena had no test suite.
const ED25519_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0x03, 0x7d, 0x46, 0xd6, 0x7c, 0x93, 0xfb, 0xbe,
    0x12, 0xf9, 0x42, 0x8f, 0x83, 0x8d, 0x40, 0xff,
    0x05, 0x70, 0x74, 0x49, 0x27, 0xf4, 0x8a, 0x64,
    0xfc, 0xca, 0x70, 0x44, 0x80, 0x00, 0x00, 0x00,
]);

/// The protocol treasury: a PDA this program owns, never a caller-supplied address.
///
/// `Settle.treasury_wallet` was an `UncheckedAccount` with no constraint while `settle`
/// transferred the 15% arena fee to it, so any caller could pass an arbitrary address
/// and drain the fee — the EVM Arena uses an immutable treasury for exactly this reason.
///
/// Withdrawing from this PDA is not implemented. The constraint stops theft; it does not
/// make the fee spendable, and a treasury-withdraw instruction is the missing piece.
fn treasury_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"treasury"], &crate::ID).0
}

#[derive(Accounts)]
#[instruction(nonce: u64, reward: u64, spec_digest: [u8;32], suite_digest: [u8;32],
             holdout_commitment: [u8;32], skeptic_window: u32, open_span: u64)]
pub struct PostTrial<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,

    #[account(
        init,
        seeds = [b"trial", sponsor.key().as_ref(), &nonce.to_le_bytes()],
        bump,
        payer = sponsor,
        space = 8 + Trial::INIT_SPACE,
    )]
    pub trial: Box<Account<'info, Trial>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(bond: u64, runner_key: Pubkey)]
pub struct ClaimTrial<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,

    #[account(mut)]
    pub trial: Account<'info, Trial>,

    #[account(
        init,
        seeds = [b"claim", trial.key().as_ref()],
        bump,
        payer = agent,
        space = 8 + Claim::INIT_SPACE,
    )]
    pub claim: Account<'info, Claim>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitRun<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(mut)]
    pub trial: Account<'info, Trial>,

    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(mut)]
    pub trial: Account<'info, Trial>,

    #[account(
        mut,
        constraint = agent_wallet.key() == trial.agent
    )]
    pub agent_wallet: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = treasury_wallet.key() == treasury_pda()
    )]
    pub treasury_wallet: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct YieldTrial<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,

    #[account(mut)]
    pub trial: Account<'info, Trial>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimTimeout<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(mut)]
    pub trial: Account<'info, Trial>,

    #[account(mut, constraint = sponsor_wallet.key() == trial.sponsor)]
    pub sponsor_wallet: UncheckedAccount<'info>,

    #[account(mut, constraint = agent_wallet.key() == trial.agent)]
    pub agent_wallet: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(commitment: [u8;32])]
pub struct CommitBreak<'info> {
    #[account(mut)]
    pub skeptic: Signer<'info>,

    #[account(mut)]
    pub trial: Account<'info, Trial>,

    #[account(
        init,
        seeds = [b"break", trial.key().as_ref(), skeptic.key().as_ref(), &trial.break_count.to_le_bytes()],
        bump,
        payer = skeptic,
        space = 8 + Break::INIT_SPACE,
    )]
    pub brk: Account<'info, Break>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevealBreak<'info> {
    pub skeptic: Signer<'info>,

    #[account(mut)]
    pub trial: Account<'info, Trial>,

    #[account(mut, constraint = brk.trial == trial.key(), constraint = brk.skeptic == skeptic.key())]
    pub brk: Account<'info, Break>,
}

#[derive(Accounts)]
pub struct FreezeDocket<'info> {
    pub cranker: Signer<'info>,

    #[account(mut)]
    pub trial: Account<'info, Trial>,
}

#[program]
pub mod crucible_arena {
    use super::*;

    pub fn post_trial(
        ctx: Context<PostTrial>,
        nonce: u64,
        reward: u64,
        spec_digest: [u8; 32],
        suite_digest: [u8; 32],
        holdout_commitment: [u8; 32],
        skeptic_window: u32,
        open_span: u64,
    ) -> Result<()> {
        if spec_digest == [0u8; 32] || suite_digest == [0u8; 32] {
            return err!(ArenaError::ZeroDigest);
        }
        if skeptic_window < SKEPTIC_WINDOW_MIN_SECONDS as u32
            || skeptic_window > SKEPTIC_WINDOW_MAX_SECONDS as u32
        {
            return err!(ArenaError::BadWindow);
        }
        if open_span == 0 || open_span > TRIAL_OPEN_MAX_SECONDS {
            return err!(ArenaError::BadOpenSpan);
        }
        // Lamports, not wei: the trial PDA holds native SOL. Comparing the reward
        // against REWARD_FLOOR_ETH_WEI priced the minimum trial at 10,000,000 SOL.
        if reward < REWARD_FLOOR_SOL_LAMPORTS {
            return err!(ArenaError::RewardTooSmall);
        }
        let fee = (reward as u128 * ARENA_FEE_BPS as u128 / 10000) as u64;
        let amount = reward.checked_add(fee).ok_or(ArenaError::Overflow)?;

        let cpi_accounts = anchor_lang::system_program::Transfer {
            from: ctx.accounts.sponsor.to_account_info(),
            to: ctx.accounts.trial.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            cpi_accounts,
        );
        anchor_lang::system_program::transfer(cpi_ctx, amount)?;

        let clock = Clock::get()?;
        let t = &mut ctx.accounts.trial;
        t.bump = ctx.bumps.trial;
        t.sponsor = ctx.accounts.sponsor.key();
        t.status = TrialStatus::Open;
        t.ever_claimed = false;
        t.reward = reward;
        t.fee = fee;
        t.deposited = amount;
        t.paid_out = 0;
        t.opened_at = clock.unix_timestamp;
        t.open_until = clock.unix_timestamp.checked_add(open_span as i64).ok_or(ArenaError::Overflow)?;
        t.skeptic_window = skeptic_window;
        t.spec_digest = spec_digest;
        t.suite_digest = suite_digest;
        t.holdout_commitment = holdout_commitment;
        t.nonce = nonce;
        t.claim_deadline = 0;
        t.agent = Pubkey::default();
        t.bond = 0;
        t.active_counted = false;
        t.submitted_at = 0;
        t.window_end = 0;
        t.holdout_due_by = 0;
        t.run_hash = [0u8; 32];
        t.verdict_hash = [0u8; 32];
        t.replay_hash = [0u8; 32];
        t.model_harness_id = [0u8; 32];
        t.runner_key = Pubkey::default();
        t.break_count = 0;
        t.docket_frozen = false;
        t.docket_size = 0;
        Ok(())
    }

    pub fn claim_trial(ctx: Context<ClaimTrial>, bond: u64, runner_key: Pubkey) -> Result<()> {
        let clock = Clock::get()?;
        // validation (immutable borrow scoped)
        {
            let t = &ctx.accounts.trial;
            if t.status != TrialStatus::Open {
                return err!(ArenaError::AlreadyClaimed);
            }
            if clock.unix_timestamp >= t.open_until {
                return err!(ArenaError::ClaimWindowClosed);
            }
            if ctx.accounts.agent.key() == t.sponsor {
                return err!(ArenaError::SelfClaim);
            }
            let bond_min = (t.reward as u128 * AGENT_BOND_MIN_BPS as u128 / 10000) as u64;
            if bond < bond_min {
                return err!(ArenaError::StakeTooSmall);
            }
        }
        // transfer
        let cpi_accounts = anchor_lang::system_program::Transfer {
            from: ctx.accounts.agent.to_account_info(),
            to: ctx.accounts.trial.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            cpi_accounts,
        );
        anchor_lang::system_program::transfer(cpi_ctx, bond)?;

        let claim_span = {
            // re-read immutable
            let t = &ctx.accounts.trial;
            let remaining = if t.open_until > clock.unix_timestamp {
                (t.open_until - clock.unix_timestamp) as u64
            } else { 0u64 };
            if remaining < CLAIM_DEADLINE_MIN_SECONDS { remaining }
            else if remaining < CLAIM_DEADLINE_MAX_SECONDS { remaining }
            else { CLAIM_DEADLINE_MAX_SECONDS }
        };
        let deadline = clock.unix_timestamp.checked_add(claim_span as i64).ok_or(ArenaError::Overflow)?;

        let t = &mut ctx.accounts.trial;
        t.status = TrialStatus::Claimed;
        t.ever_claimed = true;
        t.agent = ctx.accounts.agent.key();
        t.runner_key = runner_key;
        t.bond = bond;
        t.claim_deadline = deadline;
        t.deposited = t.deposited.checked_add(bond).ok_or(ArenaError::Overflow)?;
        t.active_counted = true;

        let c = &mut ctx.accounts.claim;
        c.bump = ctx.bumps.claim;
        c.trial = ctx.accounts.trial.key();
        c.agent = ctx.accounts.agent.key();
        c.bond = bond;
        c.claim_deadline = deadline;
        c.identity_epoch = 0;
        c.runner_key = runner_key;
        Ok(())
    }

    pub fn submit_run(
        ctx: Context<SubmitRun>,
        artifact_digest: [u8; 32],
        verdict_hash: [u8; 32],
        replay_hash: [u8; 32],
        model_harness_id: [u8; 32],
    ) -> Result<()> {
        let clock = Clock::get()?;
        let t = &mut ctx.accounts.trial;
        if t.status != TrialStatus::Claimed {
            return err!(ArenaError::IllegalTransition);
        }
        if clock.unix_timestamp >= t.claim_deadline {
            return err!(ArenaError::ClaimTimeout);
        }
        if artifact_digest == [0u8; 32] || verdict_hash == [0u8; 32] || replay_hash == [0u8; 32] {
            return err!(ArenaError::ZeroDigest);
        }

        let ixs = ix_sysvar::load_current_index_checked(&ctx.accounts.instructions.to_account_info())?;
        if ixs == 0 {
            return err!(ArenaError::BadSigner);
        }
        let runner_ix = ix_sysvar::load_instruction_at_checked((ixs - 1) as usize, &ctx.accounts.instructions.to_account_info())?;
        if runner_ix.program_id != ED25519_PROGRAM_ID {
            return err!(ArenaError::BadSigner);
        }
        let (runner_pubkey, runner_message) = parse_ed25519(&runner_ix.data)?;
        if Pubkey::new_from_array(runner_pubkey) != t.runner_key {
            return err!(ArenaError::BadSigner);
        }
        if !runner_message.starts_with(b"CRUCIBLE:run:v2") {
            return err!(ArenaError::BadSigner);
        }
        if ixs >= 2 {
            let attest_ix = ix_sysvar::load_instruction_at_checked((ixs - 2) as usize, &ctx.accounts.instructions.to_account_info())?;
            if attest_ix.program_id == ED25519_PROGRAM_ID {
                let (_attest_pubkey, attest_message) = parse_ed25519(&attest_ix.data)?;
                if !attest_message.starts_with(b"CRUCIBLE:attest:v1") {
                    return err!(ArenaError::BadSigner);
                }
            }
        }

        t.status = TrialStatus::Submitted;
        t.run_hash = artifact_digest;
        t.verdict_hash = verdict_hash;
        t.replay_hash = replay_hash;
        t.model_harness_id = model_harness_id;
        t.submitted_at = clock.unix_timestamp;
        t.window_end = clock.unix_timestamp.checked_add(t.skeptic_window as i64).ok_or(ArenaError::Overflow)?;
        t.holdout_due_by = clock.unix_timestamp
            .checked_add((t.skeptic_window as i64) / 2)
            .ok_or(ArenaError::Overflow)?;
        if t.holdout_due_by > t.window_end { t.holdout_due_by = t.window_end; }
        Ok(())
    }

    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let clock = Clock::get()?;
        let (agent_amount, fee, sponsor_key, nonce, bump) = {
            let t = &mut ctx.accounts.trial;
            if t.status != TrialStatus::Submitted {
                return err!(ArenaError::IllegalTransition);
            }
            let grace_end = t.window_end.checked_add(BREAK_REVEAL_GRACE_SECONDS as i64).ok_or(ArenaError::Overflow)?;
            if clock.unix_timestamp < grace_end {
                return err!(ArenaError::WindowStillOpen);
            }
            let agent_amount = t.reward.checked_add(t.bond).ok_or(ArenaError::Overflow)?;
            let fee = t.fee;
            let sponsor_key = t.sponsor;
            let nonce = t.nonce;
            let bump = t.bump;
            t.status = TrialStatus::Settled;
            t.paid_out = t.paid_out.checked_add(agent_amount).ok_or(ArenaError::Overflow)?
                .checked_add(fee).ok_or(ArenaError::Overflow)?;
            t.bond = 0;
            (agent_amount, fee, sponsor_key, nonce, bump)
        };

        let seeds: &[&[u8]] = &[b"trial", sponsor_key.as_ref(), &nonce.to_le_bytes(), &[bump]];
        let signer = &[seeds];
        let trial_info = ctx.accounts.trial.to_account_info();
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: trial_info.clone(),
                    to: ctx.accounts.agent_wallet.to_account_info(),
                },
                signer,
            ),
            agent_amount,
        )?;
        if fee > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: trial_info.clone(),
                        to: ctx.accounts.treasury_wallet.to_account_info(),
                    },
                    signer,
                ),
                fee,
            )?;
        }
        Ok(())
    }

    pub fn yield_trial(ctx: Context<YieldTrial>) -> Result<()> {
        let clock = Clock::get()?;
        let t = &mut ctx.accounts.trial;
        if t.status != TrialStatus::Claimed {
            return err!(ArenaError::IllegalTransition);
        }
        if ctx.accounts.agent.key() != t.agent {
            return err!(ArenaError::SelfClaim);
        }
        let bump = t.bump;
        let sponsor_key = t.sponsor;
        let nonce = t.nonce;
        let bond = t.bond;
        t.status = TrialStatus::Open;
        t.bond = 0;
        t.agent = Pubkey::default();
        t.claim_deadline = 0;
        t.active_counted = false;

        let seeds: &[&[u8]] = &[b"trial", sponsor_key.as_ref(), &nonce.to_le_bytes(), &[bump]];
        let signer = &[seeds];
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.trial.to_account_info(),
                    to: ctx.accounts.agent.to_account_info(),
                },
                signer,
            ),
            bond,
        )?;
        let _ = clock;
        Ok(())
    }

    pub fn claim_timeout(ctx: Context<ClaimTimeout>) -> Result<()> {
        let clock = Clock::get()?;
        let t = &mut ctx.accounts.trial;
        if t.status != TrialStatus::Claimed {
            return err!(ArenaError::IllegalTransition);
        }
        if clock.unix_timestamp < t.claim_deadline {
            return err!(ArenaError::ClaimTimeout);
        }
        let bond = t.bond;
        let forfeit = (bond as u128 * CLAIM_TIMEOUT_FORFEIT_BPS as u128 / 10000) as u64;
        let agent_amount = bond.checked_sub(forfeit).ok_or(ArenaError::Overflow)?;
        let sponsor_key = t.sponsor;
        let nonce = t.nonce;
        let bump = t.bump;
        t.status = TrialStatus::Open;
        t.bond = 0;
        t.agent = Pubkey::default();
        t.claim_deadline = 0;
        t.active_counted = false;
        t.deposited = t.deposited.checked_sub(bond).ok_or(ArenaError::Overflow)?;
        t.paid_out = t.paid_out.checked_add(forfeit).ok_or(ArenaError::Overflow)?
            .checked_add(agent_amount).ok_or(ArenaError::Overflow)?;

        let seeds: &[&[u8]] = &[b"trial", sponsor_key.as_ref(), &nonce.to_le_bytes(), &[bump]];
        let signer = &[seeds];
        let trial_info = ctx.accounts.trial.to_account_info();
        if forfeit > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: trial_info.clone(),
                        to: ctx.accounts.sponsor_wallet.to_account_info(),
                    },
                    signer,
                ),
                forfeit,
            )?;
        }
        if agent_amount > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: trial_info.clone(),
                        to: ctx.accounts.agent_wallet.to_account_info(),
                    },
                    signer,
                ),
                agent_amount,
            )?;
        }
        Ok(())
    }

    pub fn commit_break(ctx: Context<CommitBreak>, commitment: [u8; 32]) -> Result<()> {
        let trial_key_for_break = ctx.accounts.trial.key();
        let skeptic_for_break = ctx.accounts.skeptic.key();
        let clock = Clock::get()?;
        // validation + compute values (immutable borrow scoped)
        let (stake_min, seat_fee, total) = {
            let t = &ctx.accounts.trial;
            if t.status != TrialStatus::Submitted {
                return err!(ArenaError::IllegalTransition);
            }
            if clock.unix_timestamp >= t.window_end {
                return err!(ArenaError::WindowStillOpen);
            }
            if commitment == [0u8; 32] {
                return err!(ArenaError::TooSmall);
            }
            if ctx.accounts.skeptic.key() == t.agent {
                return err!(ArenaError::SelfClaim);
            }
            let stake_min = (t.reward as u128 * SKEPTIC_STAKE_MIN_BPS as u128 / 10000) as u64;
            let seat_fee = (t.reward as u128 * SEAT_FEE_BPS as u128 * ARGUS_SEATS as u128 / 10000) as u64;
            let total = stake_min.checked_add(seat_fee).ok_or(ArenaError::Overflow)?;
            (stake_min, seat_fee, total)
        };

        let cpi_accounts = anchor_lang::system_program::Transfer {
            from: ctx.accounts.skeptic.to_account_info(),
            to: ctx.accounts.trial.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            cpi_accounts,
        );
        anchor_lang::system_program::transfer(cpi_ctx, total)?;

        let brk = &mut ctx.accounts.brk;
        brk.bump = ctx.bumps.brk;
        brk.trial = trial_key_for_break;
        brk.skeptic = skeptic_for_break;
        brk.commitment = commitment;
        brk.stake = stake_min;
        brk.seat_fee = seat_fee;
        brk.committed_at = clock.unix_timestamp;
        brk.revealed = false;
        brk.settled = false;

        let t = &mut ctx.accounts.trial;
        t.break_count = t.break_count.checked_add(1).ok_or(ArenaError::Overflow)?;
        t.deposited = t.deposited.checked_add(total).ok_or(ArenaError::Overflow)?;
        Ok(())
    }

    pub fn reveal_break(ctx: Context<RevealBreak>, break_type: u8, evidence_digest: [u8;32], salt: [u8;32]) -> Result<()> {
        let clock = Clock::get()?;
        let t = &ctx.accounts.trial;
        if clock.unix_timestamp < t.window_end {
            return err!(ArenaError::WindowStillOpen);
        }
        let grace_end = t.window_end.checked_add(BREAK_REVEAL_GRACE_SECONDS as i64).ok_or(ArenaError::Overflow)?;
        if clock.unix_timestamp > grace_end {
            return err!(ArenaError::ClaimTimeout);
        }
        let brk = &mut ctx.accounts.brk;
        if brk.revealed {
            return err!(ArenaError::IllegalTransition);
        }
        use anchor_lang::solana_program::hash::hash;
        let mut buf = Vec::new();
        buf.extend_from_slice(b"CRUCIBLE:break:v1");
        buf.extend_from_slice(ctx.accounts.trial.key().as_ref());
        buf.extend_from_slice(ctx.accounts.skeptic.key().as_ref());
        buf.push(break_type);
        buf.extend_from_slice(&evidence_digest);
        buf.extend_from_slice(&salt);
        let computed = hash(&buf);
        if computed.to_bytes() != brk.commitment {
            return err!(ArenaError::BadSigner);
        }
        brk.revealed = true;
        brk.revealed_type = break_type;
        brk.evidence_digest = evidence_digest;
        brk.salt = salt;
        Ok(())
    }

    pub fn freeze_docket(ctx: Context<FreezeDocket>) -> Result<()> {
        let t = &mut ctx.accounts.trial;
        if t.status != TrialStatus::Submitted {
            return err!(ArenaError::IllegalTransition);
        }
        t.docket_frozen = true;
        t.docket_size = t.break_count.min(MAX_DOCKET as u16) as u8;
        Ok(())
    }
}

fn _unused() {}
/// Parse the ed25519 precompile instruction data.
///
/// Layout, from `solana_ed25519_program` 3.0.0 (`Ed25519SignatureOffsets`):
///
/// ```text
/// bytes 0-1    num_signatures (u16 LE; the reference builder writes u8 + padding)
/// bytes 2-15   offsets, 14 bytes per signature, every field u16 LE:
///                +0   signature_offset
///                +2   signature_instruction_index
///                +4   public_key_offset
///                +6   public_key_instruction_index
///                +8   message_data_offset
///                +10  message_data_size
///                +12  message_instruction_index
/// byte 16+      the verification data those offsets point at
/// ```
///
/// This read `public_key_offset` from bytes 2-3 — which is `signature_offset` —
/// so the program compared the runner key against the first 32 bytes of the
/// signature, and every honest run failed `BadSigner`. It also used a 12-byte
/// per-signature stride and ignored `message_data_size`.
fn parse_ed25519(data: &[u8]) -> Result<([u8; 32], Vec<u8>)> {
    const HEADER: usize = 2;
    const PER_SIG: usize = 14;
    if data.len() < HEADER + PER_SIG {
        return err!(ArenaError::BadSigner);
    }
    let num = u16::from_le_bytes([data[0], data[1]]) as usize;
    if num == 0 {
        return err!(ArenaError::BadSigner);
    }
    let pubkey_offset = u16::from_le_bytes([data[HEADER + 4], data[HEADER + 5]]) as usize;
    let msg_offset = u16::from_le_bytes([data[HEADER + 8], data[HEADER + 9]]) as usize;
    let msg_size = u16::from_le_bytes([data[HEADER + 10], data[HEADER + 11]]) as usize;
    if pubkey_offset + 32 > data.len() {
        return err!(ArenaError::BadSigner);
    }
    if msg_size == 0 || msg_offset + msg_size > data.len() {
        return err!(ArenaError::BadSigner);
    }
    let mut pubkey = [0u8; 32];
    pubkey.copy_from_slice(&data[pubkey_offset..pubkey_offset + 32]);
    Ok((pubkey, data[msg_offset..msg_offset + msg_size].to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /**
     * The constant this program introspects against, pinned to the documented
     * precompile id.
     *
     * It was a placeholder (`0xED, 0x25, 0x51, 0x90, 0…`) that matches no program
     * on any cluster, so every genuine ed25519 instruction was rejected and no run
     * could ever be submitted. A byte literal cannot be checked against the docs by
     * reading it; the base58 form can.
     */
    #[test]
    fn ed25519_precompile_id_is_the_documented_one() {
        assert_eq!(
            ED25519_PROGRAM_ID.to_string(),
            "Ed25519SigVerify111111111111111111111111111",
            "the ed25519 precompile id drifted from the documented program id"
        );
    }

    /// The floor the Solana program enforces must be denominated in lamports.
    ///
    /// It used to compare the reward against `REWARD_FLOOR_ETH_WEI` — the EVM wei
    /// floor, 1e16 — against a lamport balance, which priced the minimum trial at
    /// 10,000,000 SOL and made the arena unusable.
    #[test]
    fn reward_floor_is_denominated_in_lamports() {
        assert_eq!(REWARD_FLOOR_SOL_LAMPORTS, 100_000_000, "0.1 SOL");
        assert!(
            REWARD_FLOOR_SOL_LAMPORTS < 1_000_000_000,
            "the floor must be under 1 SOL, not the 1e16 wei floor"
        );
    }

    /// The fee destination must be program-derived, not a caller-supplied address.
    #[test]
    fn treasury_is_program_derived() {
        let (pda, _bump) = Pubkey::find_program_address(&[b"treasury"], &crate::ID);
        assert_eq!(treasury_pda(), pda, "treasury PDA must be deterministic");
        assert_ne!(
            treasury_pda(),
            crate::ID,
            "the treasury must not be the program itself"
        );
    }

    /// Built exactly the way `solana_ed25519_program::new_ed25519_instruction_with_signature`
    /// builds it: a 2-byte count, a 14-byte offsets block, then key, signature, message.
    /// `signature_offset` and `public_key_offset` point at different bytes on purpose —
    /// the old parser read the public key from `signature_offset`.
    #[test]
    fn parse_ed25519_reads_a_well_formed_instruction() {
        let mut data = Vec::new();
        data.extend_from_slice(&1u16.to_le_bytes()); // num_signatures
        data.extend_from_slice(&48u16.to_le_bytes()); // signature_offset   (+0)
        data.extend_from_slice(&u16::MAX.to_le_bytes()); // signature_ix     (+2)
        data.extend_from_slice(&16u16.to_le_bytes()); // public_key_offset  (+4)
        data.extend_from_slice(&u16::MAX.to_le_bytes()); // public_key_ix    (+6)
        data.extend_from_slice(&112u16.to_le_bytes()); // message_offset     (+8)
        data.extend_from_slice(&5u16.to_le_bytes()); // message_size         (+10)
        data.extend_from_slice(&u16::MAX.to_le_bytes()); // message_ix       (+12)
        assert_eq!(data.len(), 16, "header must be 2 + 14 bytes");

        data.extend_from_slice(&[7u8; 32]); // public key at 16
        data.extend_from_slice(&[9u8; 64]); // signature at 48
        data.extend_from_slice(b"claim"); // message at 112

        let (pubkey, message) = parse_ed25519(&data).expect("well-formed instruction");
        assert_eq!(pubkey, [7u8; 32], "key must come from public_key_offset");
        assert_eq!(message, b"claim");
    }

    /// The message is `message_data_size` bytes, not "everything to the end" — a
    /// trailing blob must not be read into the signed message.
    #[test]
    fn parse_ed25519_honours_the_declared_message_size() {
        let mut data = Vec::new();
        data.extend_from_slice(&1u16.to_le_bytes());
        data.extend_from_slice(&48u16.to_le_bytes());
        data.extend_from_slice(&u16::MAX.to_le_bytes());
        data.extend_from_slice(&16u16.to_le_bytes());
        data.extend_from_slice(&u16::MAX.to_le_bytes());
        data.extend_from_slice(&112u16.to_le_bytes());
        data.extend_from_slice(&5u16.to_le_bytes());
        data.extend_from_slice(&u16::MAX.to_le_bytes());
        data.extend_from_slice(&[7u8; 32]);
        data.extend_from_slice(&[9u8; 64]);
        data.extend_from_slice(b"claim");
        data.extend_from_slice(b"TRAILING BYTES THAT MUST NOT BE READ");

        let (_pubkey, message) = parse_ed25519(&data).expect("well-formed instruction");
        assert_eq!(message, b"claim");
    }

    #[test]
    fn parse_ed25519_refuses_a_truncated_or_oversized_instruction() {
        assert!(parse_ed25519(&[]).is_err());
        assert!(parse_ed25519(&[1]).is_err());
        assert!(parse_ed25519(&[0, 0]).is_err(), "zero signatures");
        // One byte short of the 16-byte header.
        assert!(parse_ed25519(&[0u8; 15]).is_err());
        // Header claims a key past the end of the buffer.
        let mut bad = vec![0u8; 16];
        bad[0] = 1;
        bad[6..8].copy_from_slice(&1000u16.to_le_bytes());
        assert!(parse_ed25519(&bad).is_err(), "key offset out of range");
        // Message size larger than the buffer.
        let mut bad_msg = vec![0u8; 16];
        bad_msg[0] = 1;
        bad_msg[12..14].copy_from_slice(&1000u16.to_le_bytes());
        assert!(parse_ed25519(&bad_msg).is_err(), "message size out of range");
    }
}