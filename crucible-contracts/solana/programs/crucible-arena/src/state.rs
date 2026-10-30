//! Account state stubs (§9.1). Fields are minimal placeholders; full layouts land with handlers.

use anchor_lang::prelude::*;

#[account]
#[derive(Default, InitSpace)]
pub struct Config {
    pub bump: u8,
    pub paused: bool,
}

#[account]
#[derive(Default)]
pub struct Trial {
    pub bump: u8,
    pub sponsor: Pubkey,
    pub state: u8,
}

#[account]
#[derive(Default)]
pub struct Vault {
    pub bump: u8,
}

#[account]
#[derive(Default)]
pub struct Claim {
    pub bump: u8,
}

#[account]
#[derive(Default)]
pub struct Break {
    pub bump: u8,
}

#[account]
#[derive(Default)]
pub struct SeatPool {
    pub bump: u8,
}

#[account]
#[derive(Default)]
pub struct Seat {
    pub bump: u8,
    pub operator: Pubkey,
}

#[account]
#[derive(Default)]
pub struct Panel {
    pub bump: u8,
}

#[account]
#[derive(Default)]
pub struct Standing {
    pub bump: u8,
}

#[account]
#[derive(Default)]
pub struct Credential {
    pub bump: u8,
}

#[account]
#[derive(Default)]
pub struct Runner {
    pub bump: u8,
    pub agent_identity: Pubkey,
}
