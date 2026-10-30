//! CRUCIBLE arena, Solana side (gates 734-746, 748-751, 753, 783).
//! P4 core: post_trial + claim_trial + submit_run + settle (O1, no breaks).

pub mod errors;
pub mod instructions;
pub mod params;
pub mod state;

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};
use errors::ArenaError;
use params::*;
use state::*;

declare_id!("AikvHhtXSuZ8PuKoqYG5WASJGWTEu4RQYmYbeSzoPLJV");

// --------------------------------------------------------------------------- Accounts
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
    pub trial: Account<'info, Trial>,

    #[account(
        init,
        seeds = [b"vault", trial.key().as_ref()],
        bump,
        payer = sponsor,
        token::mint = mint,
        token::authority = trial,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, constraint = sponsor_ata.mint == mint.key(), constraint = sponsor_ata.owner == sponsor.key())]
    pub sponsor_ata: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(bond: u64)]
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

    #[account(mut, constraint = agent_ata.mint == trial.mint, constraint = agent_ata.owner == agent.key())]
    pub agent_ata: Account<'info, TokenAccount>,

    #[account(mut, constraint = vault.mint == trial.mint)]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitRun<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(mut)]
    pub trial: Account<'info, Trial>,

    #[account(mut, constraint = vault.mint == trial.mint)]
    pub vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(mut)]
    pub trial: Account<'info, Trial>,

    #[account(mut, constraint = vault.mint == trial.mint)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, constraint = agent_ata.mint == trial.mint, constraint = agent_ata.owner == trial.agent)]
    pub agent_ata: Account<'info, TokenAccount>,

    #[account(mut, constraint = treasury_ata.mint == trial.mint)]
    pub treasury_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// --------------------------------------------------------------------------- Program
#[program]
pub mod crucible_arena {
    use super::*;
    use anchor_spl::token;

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
        if reward < REWARD_FLOOR_ETH_WEI as u64 {
            return err!(ArenaError::RewardTooSmall);
        }
        let fee = (reward as u128 * ARENA_FEE_BPS as u128 / 10000) as u64;
        let amount = reward.checked_add(fee).ok_or(ArenaError::Overflow)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.sponsor_ata.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.sponsor.to_account_info(),
                },
            ),
            amount,
        )?;

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
        t.mint = ctx.accounts.mint.key();
        t.nonce = nonce;
        t.claim_deadline = 0;
        t.agent = Pubkey::default();
        t.bond = 0;
        t.active_counted = false;
        Ok(())
    }

    pub fn claim_trial(ctx: Context<ClaimTrial>, bond: u64) -> Result<()> {
        use anchor_spl::token;
        let clock = Clock::get()?;
        let t = &mut ctx.accounts.trial;
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
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.agent_ata.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.agent.to_account_info(),
                },
            ),
            bond,
        )?;

        let claim_span = {
            let remaining = if t.open_until > clock.unix_timestamp {
                (t.open_until - clock.unix_timestamp) as u64
            } else { 0u64 };
            if remaining < CLAIM_DEADLINE_MIN_SECONDS { remaining }
            else if remaining < CLAIM_DEADLINE_MAX_SECONDS { remaining }
            else { CLAIM_DEADLINE_MAX_SECONDS }
        };
        let deadline = clock.unix_timestamp.checked_add(claim_span as i64).ok_or(ArenaError::Overflow)?;

        t.status = TrialStatus::Claimed;
        t.ever_claimed = true;
        t.agent = ctx.accounts.agent.key();
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
        c.runner_key = Pubkey::default();
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
        // Ed25519 introspection (Instructions sysvar) is TODO: verify runner + attestor
        // signatures per bible §9.3 before flipping to Submitted. Scaffold stores digests.
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
        let _ = &ctx.accounts.vault;
        Ok(())
    }

    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let clock = Clock::get()?;
        // Validate + compute in a scoped borrow so the CPI can borrow ctx again.
        let (agent_amount, fee, sponsor_key, nonce, bump, grace_ok) = {
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
            (agent_amount, fee, sponsor_key, nonce, bump, true)
        };
        let _ = grace_ok;

        let seeds: &[&[u8]] = &[b"trial", sponsor_key.as_ref(), &nonce.to_le_bytes(), &[bump]];
        let signer = &[seeds];
        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.agent_ata.to_account_info(),
                    authority: ctx.accounts.trial.to_account_info(),
                },
                signer,
            ),
            agent_amount,
        )?;
        if fee > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    anchor_spl::token::Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.treasury_ata.to_account_info(),
                        authority: ctx.accounts.trial.to_account_info(),
                    },
                    signer,
                ),
                fee,
            )?;
        }
        // conservation assert
        ctx.accounts.vault.reload()?;
        let vault_bal = ctx.accounts.vault.amount;
        let deposited = ctx.accounts.trial.deposited;
        let paid_out = ctx.accounts.trial.paid_out;
        let expected = deposited.checked_sub(paid_out).ok_or(ArenaError::Overflow)?;
        if vault_bal != expected {
            return err!(ArenaError::Overflow);
        }
        Ok(())
    }
}
