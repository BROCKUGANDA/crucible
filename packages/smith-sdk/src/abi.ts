/**
 * Minimal ABI for CrucibleTrials and AlloyRegistry.
 *
 * Hand-written rather than generated from artifacts so the SDK installs with no
 * build step against the .sol files. Kept in sync by crucible-contracts/test —
 * see test/abi-parity.test.ts.
 */

export const TRIALS_ABI = [
  {
    type: "function",
    name: "createTrial",
    stateMutability: "payable",
    inputs: [
      { name: "specCID", type: "bytes32" },
      { name: "testsCID", type: "bytes32" },
      { name: "deadline", type: "uint64" },
      { name: "breakWindow", type: "uint64" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "registerAgent",
    stateMutability: "payable",
    inputs: [
      { name: "metadataURI", type: "string" },
      { name: "runner", type: "address" },
    ],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "setRunner",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "runner", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimTrial",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "unstake",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "submitRun",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "runHash", type: "bytes32" },
      { name: "sig", type: "bytes" },
      { name: "sigDeadline", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "fileBreak",
    stateMutability: "payable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "proofCID", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "commitVote",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "commit", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revealVote",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "breakWins", type: "bool" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "finalize",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "reclaimExpired",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "bondFor",
    stateMutability: "pure",
    inputs: [{ name: "reward", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "credit",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "trialCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "agentCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "agentIdOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "escrowed",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "treasury",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "DOMAIN",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "RUN_TYPEHASH",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "deadlineOf",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function",
    name: "breakWindowOf",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function",
    name: "runAtOf",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function",
    name: "createdAtOf",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function",
    name: "getTrial",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "sponsor", type: "address" },
          { name: "specCID", type: "bytes32" },
          { name: "testsCID", type: "bytes32" },
          { name: "reward", type: "uint128" },
          { name: "bond", type: "uint128" },
          { name: "timestamps", type: "uint256" },
          { name: "agentId", type: "uint96" },
          { name: "runHash", type: "bytes32" },
          { name: "breakProofCID", type: "bytes32" },
          { name: "breakSkeptic", type: "address" },
          { name: "breakStake", type: "uint128" },
          { name: "status", type: "uint8" },
          { name: "verdict", type: "uint8" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getAgent",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "operator", type: "address" },
          { name: "runner", type: "address" },
          { name: "metadataURI", type: "string" },
          { name: "stake", type: "uint128" },
          { name: "active", type: "uint32" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "disputeOf",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "openedAt", type: "uint64" },
      { name: "revealStarted", type: "bool" },
      { name: "votesBreak", type: "uint8" },
      { name: "votesAgent", type: "uint8" },
    ],
  },
  {
    type: "event",
    name: "TrialCreated",
    inputs: [
      { indexed: true, name: "id", type: "uint256" },
      { indexed: true, name: "sponsor", type: "address" },
      { indexed: false, name: "specCID", type: "bytes32" },
      { indexed: false, name: "testsCID", type: "bytes32" },
      { indexed: false, name: "reward", type: "uint256" },
      { indexed: false, name: "bond", type: "uint256" },
      { indexed: false, name: "deadline", type: "uint64" },
      { indexed: false, name: "breakWindow", type: "uint64" },
    ],
  },
  {
    type: "event",
    name: "RunSubmitted",
    inputs: [
      { indexed: true, name: "id", type: "uint256" },
      { indexed: true, name: "agentId", type: "uint256" },
      { indexed: false, name: "runHash", type: "bytes32" },
    ],
  },
  {
    type: "event",
    name: "BreakFiled",
    inputs: [
      { indexed: true, name: "id", type: "uint256" },
      { indexed: true, name: "skeptic", type: "address" },
      { indexed: false, name: "proofCID", type: "bytes32" },
      { indexed: false, name: "stake", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "VerdictFinalized",
    inputs: [
      { indexed: true, name: "id", type: "uint256" },
      { indexed: false, name: "verdict", type: "uint8" },
      { indexed: false, name: "agentPayout", type: "uint256" },
    ],
  },
] as const;

export const ALLOY_ABI = [
  {
    type: "function",
    name: "tierOf",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "tierName",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "locked",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "records",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "wins", type: "uint32" },
      { name: "survived", type: "uint32" },
      { name: "slashes", type: "uint32" },
      { name: "tier", type: "uint8" },
    ],
  },
] as const;

/** Rust/other-tooling exports. Mirrors the enums in CrucibleTrials.sol. */
export const STATUS = {
  Open: 0,
  Assigned: 1,
  Judging: 2,
  Challenged: 3,
  Settled: 4,
} as const;

export const VERDICT = {
  None: 0,
  Paid: 1,
  Slashed: 2,
  Refunded: 3,
} as const;

export const TIER = {
  Unforged: 0,
  Iron: 1,
  Bronze: 2,
  Steel: 3,
  Damascus: 4,
} as const;

export const TIER_NAMES = ["Unforged", "Iron", "Bronze", "Steel", "Damascus"] as const;

/**
 * Every custom error in CrucibleTrials, with the user-facing copy from the
 * copy deck's error matrix. Keeps the mapping in one place so the frontend
 * decodes reverts without a second table.
 */
export const ERROR_COPY = {
  RewardTooSmall: "Reward too small — the floor is 0.01 ETH.",
  BadWindow: "Skeptic window must be between 1 hour and 7 days.",
  BadDeadline: "Deadline must be at least 1 hour out.",
  StakeTooSmallAgent: "Stake at least the bond to play this trial.",
  StakeTooSmallSkeptic: "Skeptic stake must be at least 1% of the reward.",
  AlreadyRegistered: "This wallet already runs an agent.",
  NotAnAgent: "Register an agent before claiming trials.",
  NotOpen: "Someone's already at this anvil.",
  NotAssigned: "No claim to submit against — claim the trial first.",
  NotJudging: "Nothing to challenge — no run on the table.",
  NotChallenged: "No open dispute on this trial.",
  NotFinalizable: "This trial isn't ready to quench.",
  NotReclaimable: "Only trials past deadline with no run can be reclaimed.",
  DeadlinePassed: "The fire's out — submission deadline passed.",
  DeadlineNotPassed: "Deadline hasn't arrived. Patience.",
  WindowOpen: "Skeptic window still open — quenching comes after.",
  WindowClosed: "The skeptic window closed.",
  AlreadySettled: "This trial is already quenched.",
  DisputeUnresolved:
    "A break is under review — Argus holds the tongs until verdict or timeout.",
  BadSigner: "Signature doesn't match this agent's runner key.",
  BadSig: "Malformed signature.",
  SigExpired: "Signature expired — sign again and resubmit.",
  SigMalleable: "Signature rejected (malleable form).",
  NotOperator: "Only the agent operator can do that.",
  NotArgus: "Only Argus seats can vote.",
  CommitMismatch: "Reveal doesn't match your sealed commitment.",
  AlreadyCommitted: "You already sealed a verdict for this dispute.",
  AlreadyRevealed: "You already cast your verdict.",
  RevealClosed: "Reveals have started — commits are locked.",
  NothingToWithdraw: "Nothing to withdraw yet.",
  TransferFailed: "The network refused the transfer. Nothing was lost — try again.",
  Reentrancy: "The network refused the transfer. Nothing was lost — try again.",
} as const;

export type ErrorName = keyof typeof ERROR_COPY;
