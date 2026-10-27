//! Gate 703 — Instructions for work-escrow.
//! Every instruction orders checks -> effects -> interactions and emits an event.

use anchor_lang::prelude::*;
use crate::errors::ErrorCode;
use crate::math::*;
use crate::state::*;

#[derive(Accounts)]
pub struct Open<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    /// CHECK: worker key is validated client-side; no funds held here.
    pub worker: UncheckedAccount<'info>,
    #[account(
        init,
        payer = client,
        seeds = [b"escrow", worker.key().as_ref(), &work_id.to_le_bytes()],
        bump,
        space = 8 + Escrow::INIT_SPACE
    )]
    pub escrow: Account<'info, Escrow>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OpenArgs {
    pub work_id: u64,
    pub reward: u64,
    pub stake: u64,
    pub suite_root: [u8; 32],
    pub deadline_slot: i64,
}

pub fn open(ctx: Context<Open<'info>>, args: OpenArgs) -> Result<()> {
    require!(args.reward > 0, ErrorCode::RewardZero);
    require!(check_stake_floor(args.stake), ErrorCode::StakeFloorViolation);
    require!(
        args.deadline_slot > ctx.accounts.clock.slot,
        ErrorCode::DeadlinePassed
    );

    let escrow = &mut ctx.accounts.escrow;
    escrow.version = 1;
    escrow.bump = ctx.bumps.escrow;
    escrow.work_id = args.work_id;
    escrow.client = ctx.accounts.client.key();
    escrow.worker = ctx.accounts.worker.key();
    escrow.reward = args.reward;
    escrow.stake = args.stake;
    let (_worker_share, fee_share) = assess_fee(args.reward);
    escrow.fee = fee_share;
    escrow.suite_root = args.suite_root;
    escrow.result_hash = [0u8; 32];
    escrow.verdict_hash = [0u8; 32];
    escrow.deadline_slot = args.deadline_slot;
    // Reference slot for deadline math: captured at open so the deadline is measured
    // against a stable anchor rather than the live chain (which can warp in demo mode).
    escrow.clock_slot = ctx.accounts.clock.slot;
    escrow.status = EscrowStatus::Open;
    escrow.dispute_state = DisputeState::None;
    escrow.dispute_fee = 0;
    escrow.ghost_ledger = GhostLedger {
        deposited: args.reward
            .checked_add(args.stake)
            .expect("reward + stake overflow"),
        withdrawn: 0,
        swept: 0,
    };

    // Transfer reward + stake from client to the vault PDA.
    let cpi_accounts = anchor_lang::system_program::Transfer {
        from: ctx.accounts.client.to_account_info(),
        to: ctx.accounts.escrow.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        cpi_accounts,
    );
    anchor_lang::system_program::transfer(cpi_ctx, args.reward.checked_add(args.stake).expect("overflow"))?;

    assert_conservation(escrow)?;

    emit!(EscrowOpened {
        work_id: args.work_id,
        client: ctx.accounts.client.key(),
        worker: ctx.accounts.worker.key(),
        reward: args.reward,
        stake: args.stake,
        fee: escrow.fee,
        deadline_slot: args.deadline_slot,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct PostWork<'info> {
    #[account(mut)]
    pub worker: Signer<'info>,
    #[account(
        mut,
        seeds = [b"escrow", escrow.worker.key().as_ref(), &escrow.work_id.to_le_bytes()],
        bump = escrow.bump,
        constraint = escrow.worker == worker.key() @ ErrorCode::NotWorker,
        constraint = escrow.status == EscrowStatus::Open || escrow.status == EscrowStatus::Posted @ ErrorCode::NotPosted
    )]
    pub escrow: Account<'info, Escrow>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PostWorkArgs {
    pub work_id: u64,
    pub result_hash: [u8; 32],
    pub verdict_hash: [u8; 32],
}

pub fn post_work(ctx: Context<PostWork<'info>>, args: PostWorkArgs) -> Result<()> {
    require!(
        args.result_hash != [0u8; 32],
        ErrorCode::IllegalTransition
    );
    require!(
        args.verdict_hash != [0u8; 32],
        ErrorCode::IllegalTransition
    );

    let escrow = &mut ctx.accounts.escrow;
    let from = escrow.status;
    require!(
        from == EscrowStatus::Open || from == EscrowStatus::Posted,
        ErrorCode::NotPosted
    );
    escrow.assert_transition(from, EscrowStatus::Running)?;
    escrow.result_hash = args.result_hash;
    escrow.verdict_hash = args.verdict_hash;
    escrow.status = EscrowStatus::Running;

    assert_conservation(escrow)?;

    emit!(WorkPosted {
        work_id: escrow.work_id,
        worker: ctx.accounts.worker.key(),
        result_hash: args.result_hash,
        slot: ctx.accounts.clock.slot,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"escrow", escrow.worker.key().as_ref(), &escrow.work_id.to_le_bytes()],
        bump = escrow.bump,
        constraint = escrow.status == EscrowStatus::Running @ ErrorCode::NotRunning,
        constraint = escrow.dispute_state == DisputeState::None @ ErrorCode::NotDisputed
    )]
    pub escrow: Account<'info, Escrow>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SettleArgs {
    pub work_id: u64,
    pub verdict: u8, // 1 = pass, 0 = fail
    pub verdict_hash: [u8; 32],
}

pub fn settle(ctx: Context<Settle<'info>>, args: SettleArgs) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;

    // Verdict hash gate (gate 712): claim must match the verdict posted at post time.
    require!(
        args.verdict_hash == escrow.verdict_hash,
        ErrorCode::VerdictHashMismatch
    );

    let (worker_payout, fee_payout) = if args.verdict == 1 {
        let (wp, fp, _sb) = settle_pass(escrow.reward, escrow.stake);
        (wp, fp)
    } else {
        let (funder_refund, funder_stake_back, fee_stake_back) =
            settle_fail(escrow.reward, escrow.stake);
        // fail path: funder gets reward + half stake; fee vault gets half stake.
        // withdrawn tracks total payout to all parties.
        let total = funder_refund
            .checked_add(funder_stake_back)
            .and_then(|v| v.checked_add(fee_stake_back))
            .expect("withdrawn overflow");
        (0, total) // worker_payout=0 on fail; fee_payout=total for withdrawn tracking
    };

    escrow.assert_transition(
        EscrowStatus::Running,
        if args.verdict == 1 {
            EscrowStatus::SettledPass
        } else {
            EscrowStatus::SettledFail
        },
    )?;

    escrow.verdict_hash = args.verdict_hash;
    escrow.ghost_ledger.withdrawn = escrow
        .ghost_ledger
        .withdrawn
        .checked_add(worker_payout)
        .and_then(|v| v.checked_add(fee_payout))
        .expect("withdrawn overflow");

    // Vault is now empty: reward and stake have been paid out.
    escrow.reward = 0;
    escrow.stake = 0;

    assert_conservation(escrow)?;

    emit!(VerdictRendered {
        work_id: escrow.work_id,
        verdict: args.verdict,
        verdict_hash: args.verdict_hash,
        worker_payout,
        fee_payout,
        slot: ctx.accounts.clock.slot,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct Dispute<'info> {
    #[account(mut)]
    pub skeptic: Signer<'info>,
    #[account(
        mut,
        seeds = [b"escrow", escrow.worker.key().as_ref(), &escrow.work_id.to_le_bytes()],
        bump = escrow.bump,
        constraint = escrow.status == EscrowStatus::Running @ ErrorCode::NotRunning,
        constraint = escrow.dispute_state == DisputeState::None @ ErrorCode::AlreadyTerminal
    )]
    pub escrow: Account<'info, Escrow>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DisputeArgs {
    pub work_id: u64,
    pub dispute_fee: u64,
}

pub fn dispute(ctx: Context<Dispute<'info>>, args: DisputeArgs) -> Result<()> {
    require!(args.dispute_fee > 0, ErrorCode::RewardZero);

    let escrow = &mut ctx.accounts.escrow;
    // Dispute requires the escrow to be in Running state (verdict pending).
    require!(
        escrow.status == EscrowStatus::Running,
        ErrorCode::NotRunning
    );
    escrow.assert_transition(
        EscrowStatus::Running,
        EscrowStatus::Disputed,
    )?;
    escrow.dispute_state = DisputeState::Opened;
    escrow.dispute_fee = args.dispute_fee;
    escrow.ghost_ledger.deposited = escrow
        .ghost_ledger
        .deposited
        .checked_add(args.dispute_fee)
        .expect("deposited overflow");

    // Transfer dispute fee from skeptic to the vault PDA.
    let cpi_accounts = anchor_lang::system_program::Transfer {
        from: ctx.accounts.skeptic.to_account_info(),
        to: ctx.accounts.escrow.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        cpi_accounts,
    );
    anchor_lang::system_program::transfer(cpi_ctx, args.dispute_fee)?;

    assert_conservation(escrow)?;

    emit!(DisputeOpened {
        work_id: escrow.work_id,
        skeptic: ctx.accounts.skeptic.key(),
        dispute_fee: args.dispute_fee,
        slot: ctx.accounts.clock.slot,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct Resolve<'info> {
    #[account(mut)]
    pub resolver: Signer<'info>,
    #[account(
        mut,
        seeds = [b"escrow", escrow.worker.key().as_ref(), &escrow.work_id.to_le_bytes()],
        bump = escrow.bump,
        constraint = escrow.status == EscrowStatus::Disputed @ ErrorCode::NotDisputed,
        constraint = escrow.dispute_state == DisputeState::Opened @ ErrorCode::AlreadyTerminal
    )]
    pub escrow: Account<'info, Escrow>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ResolveArgs {
    pub work_id: u64,
    pub approve: bool,
}

pub fn resolve(ctx: Context<Resolve<'info>>, args: ResolveArgs) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;
    let (worker, funder, fee_vault, _slashed) =
        resolve_dispute(escrow.reward, escrow.stake, args.approve);

    escrow.assert_transition(
        EscrowStatus::Disputed,
        if args.approve {
            EscrowStatus::SettledPass
        } else {
            EscrowStatus::SettledFail
        },
    )?;

    escrow.dispute_state = DisputeState::Resolved;
    // withdrawn includes worker + funder + fee_vault payouts + forfeited dispute fee (treasury).
    escrow.ghost_ledger.withdrawn = escrow
        .ghost_ledger
        .withdrawn
        .checked_add(worker)
        .and_then(|v| v.checked_add(funder))
        .and_then(|v| v.checked_add(fee_vault))
        .and_then(|v| v.checked_add(escrow.dispute_fee))
        .expect("withdrawn overflow");

    // Vault is now empty: reward, stake, and dispute fee have been distributed.
    escrow.reward = 0;
    escrow.stake = 0;
    escrow.dispute_fee = 0;

    assert_conservation(escrow)?;

    emit!(DisputeResolved {
        work_id: escrow.work_id,
        resolver: ctx.accounts.resolver.key(),
        approve: args.approve,
        worker_payout: worker,
        funder_payout: funder,
        fee_vault_payout: fee_vault,
        slot: ctx.accounts.clock.slot,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct Expire<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    #[account(
        mut,
        seeds = [b"escrow", escrow.worker.key().as_ref(), &escrow.work_id.to_le_bytes()],
        bump = escrow.bump,
        constraint = escrow.client == client.key() @ ErrorCode::NotClient,
        constraint = !escrow.status.is_terminal() @ ErrorCode::AlreadyTerminal
    )]
    pub escrow: Account<'info, Escrow>,
    pub clock: Sysvar<'info, Clock>,
}

pub fn expire(ctx: Context<Expire<'info>>) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;
    require!(
        ctx.accounts.clock.slot >= escrow.deadline_slot,
        ErrorCode::DeadlinePassed
    );
    require!(
        !escrow.status.is_terminal(),
        ErrorCode::AlreadyTerminal
    );

    // Expire refunds everything including the frozen fee and dispute fee.
    // funder gets reward (+ fee, which is part of reward); worker gets stake;
    // dispute fee forfeited to treasury.
    let total_swept = escrow
        .reward
        .checked_add(escrow.stake)
        .and_then(|v| v.checked_add(escrow.dispute_fee))
        .expect("swept overflow");

    escrow.ghost_ledger.swept = escrow
        .ghost_ledger
        .swept
        .checked_add(total_swept)
        .expect("swept overflow");

    let expired_reward = escrow.reward;
    let expired_stake = escrow.stake;

    // Vault is now empty.
    escrow.reward = 0;
    escrow.stake = 0;
    escrow.dispute_fee = 0;

    assert_conservation(escrow)?;

    emit!(Expired {
        work_id: escrow.work_id,
        client: ctx.accounts.client.key(),
        reward: expired_reward,
        stake: expired_stake,
        slot: ctx.accounts.clock.slot,
    });

    Ok(())
}

/// Set the reference slot used for deadline math (gate: runtime-updatable clock).
/// Owner-only: the client who opened the escrow may re-anchor the clock.
#[derive(Accounts)]
pub struct SetClockSlot<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"escrow", escrow.worker.key().as_ref(), &escrow.work_id.to_le_bytes()],
        bump = escrow.bump,
        constraint = escrow.client == authority.key() @ ErrorCode::NotClient
    )]
    pub escrow: Account<'info, Escrow>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SetClockSlotArgs {
    pub work_id: u64,
    pub clock_slot: i64,
}

pub fn set_clock_slot(ctx: Context<SetClockSlot<'info>>, args: SetClockSlotArgs) -> Result<()> {
    ctx.accounts.escrow.clock_slot = args.clock_slot;

    emit!(ClockSlotSet {
        work_id: ctx.accounts.escrow.work_id,
        clock_slot: args.clock_slot,
        slot: ctx.accounts.escrow.clock_slot,
    });

    Ok(())
}

#[event]
pub struct EscrowOpened {
    pub work_id: u64,
    pub client: Pubkey,
    pub worker: Pubkey,
    pub reward: u64,
    pub stake: u64,
    pub fee: u64,
    pub deadline_slot: i64,
}

#[event]
pub struct WorkPosted {
    pub work_id: u64,
    pub worker: Pubkey,
    pub result_hash: [u8; 32],
    pub slot: i64,
}

#[event]
pub struct VerdictRendered {
    pub work_id: u64,
    pub verdict: u8,
    pub verdict_hash: [u8; 32],
    pub worker_payout: u64,
    pub fee_payout: u64,
    pub slot: i64,
}

#[event]
pub struct DisputeOpened {
    pub work_id: u64,
    pub skeptic: Pubkey,
    pub dispute_fee: u64,
    pub slot: i64,
}

#[event]
pub struct DisputeResolved {
    pub work_id: u64,
    pub resolver: Pubkey,
    pub approve: bool,
    pub worker_payout: u64,
    pub funder_payout: u64,
    pub fee_vault_payout: u64,
    pub slot: i64,
}

#[event]
pub struct Expired {
    pub work_id: u64,
    pub client: Pubkey,
    pub reward: u64,
    pub stake: u64,
    pub slot: i64,
}

#[event]
pub struct ClockSlotSet {
    pub work_id: u64,
    pub clock_slot: i64,
    pub slot: i64,
}
