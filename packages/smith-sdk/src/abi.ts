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
      { name: "reward", type: "uint256" },
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
  /**
   * `mapping(address => bool) public isArgus` (CrucibleTrials.sol:199). A seat reads this before it
   * loops: committing from an address the constructor never granted reverts `NotArgus` on every
   * trial, so an unbounded retry is a self-inflicted DoS on a shared node.
   */
  {
    type: "function",
    name: "isArgus",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "bool" }],
  },

  {
    type: "function",
    name: "disputeVote",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "judge", type: "address" },
    ],
    outputs: [
      { name: "commit", type: "bytes32" },
      { name: "revealed", type: "bool" },
    ],
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
    name: "settleBatch",
    stateMutability: "nonpayable",
    inputs: [{ name: "trialIds", type: "uint256[]" }],
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
    name: "FEE_BPS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "BPS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "BOND_NUM",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "BOND_DEN",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "BREAK_STAKE_DEN",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "SLASH_SKEPTIC_NUM",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "MIN_BOND",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "MAX_REWARD",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "MIN_RUN_WINDOW",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "MIN_BREAK_WINDOW",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "MAX_BREAK_WINDOW",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "COMMIT_WINDOW",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "DISPUTE_TIMEOUT",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "ARGUS_THRESHOLD",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
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
    name: "AgentRegistered",
    inputs: [
      { indexed: true, name: "agentId", type: "uint256" },
      { indexed: true, name: "operator", type: "address" },
      { indexed: false, name: "runner", type: "address" },
      { indexed: false, name: "metadataURI", type: "string" },
      { indexed: false, name: "stake", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "TrialClaimed",
    inputs: [
      { indexed: true, name: "id", type: "uint256" },
      { indexed: true, name: "agentId", type: "uint256" },
      { indexed: false, name: "bond", type: "uint256" },
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
    name: "DisputeOpened",
    inputs: [{ indexed: true, name: "id", type: "uint256" }],
  },
  {
    type: "event",
    name: "VoteCommitted",
    inputs: [
      { indexed: true, name: "id", type: "uint256" },
      { indexed: true, name: "judge", type: "address" },
    ],
  },
  {
    type: "event",
    name: "VoteRevealed",
    inputs: [
      { indexed: true, name: "id", type: "uint256" },
      { indexed: true, name: "judge", type: "address" },
      { indexed: false, name: "breakWins", type: "bool" },
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
  {
    type: "event",
    name: "StakeWithdrawn",
    inputs: [
      { indexed: true, name: "agentId", type: "uint256" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "Withdrawn",
    inputs: [
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "IdentityRegistrySet",
    inputs: [{ indexed: true, name: "registry", type: "address" }],
  },
  {
    type: "event",
    name: "IdentityLinked",
    inputs: [
      { indexed: true, name: "agentId", type: "uint256" },
      { indexed: true, name: "identityAgentId", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "VerificationReceiptSet",
    inputs: [{ indexed: true, name: "receipt", type: "address" }],
  },
  {
    type: "event",
    name: "ReceiptsToggled",
    inputs: [{ indexed: false, name: "enabled", type: "bool" }],
  },
  // Three events the contract emits that this ABI did not carry. `RunnerSet` was already named in
  // the indexer's own ingest list, so that list silently matched nothing and the model's
  // `RunnerSet` case had never run against a real log; `VerificationReceiptMinted` is the receipt
  // itself, and four of them sat on the deployed chain reporting as undecodable noise.
  {
    type: "event",
    name: "RunnerSet",
    inputs: [
      { indexed: true, name: "agentId", type: "uint256" },
      { indexed: false, name: "runner", type: "address" },
    ],
  },
  {
    type: "event",
    name: "ReputationBridgeSet",
    inputs: [{ indexed: true, name: "bridge", type: "address" }],
  },
  {
    type: "event",
    name: "VerificationReceiptMinted",
    inputs: [
      { indexed: true, name: "tokenId", type: "uint256" },
      { indexed: true, name: "trialId", type: "uint256" },
      { indexed: false, name: "verdictHash", type: "bytes32" },
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
      // ADR-0012 appended these; `abi-drift.test.ts` parses `struct Record` out of the Solidity and
      // fails if this list and that one ever disagree in field, type or order.
      { name: "epoch", type: "uint32" },
      { name: "lifetimeWins", type: "uint32" },
      { name: "lifetimeSlashes", type: "uint32" },
      { name: "holder", type: "address" },
      { name: "epochStartedAt", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "epochOf",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [
      { name: "epoch", type: "uint32" },
      { name: "startedAt", type: "uint64" },
      { name: "lifetimeWins", type: "uint32" },
      { name: "lifetimeSlashes", type: "uint32" },
    ],
  },
  {
    type: "function",
    name: "holderOf",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  // The registry emitted four events and this ABI carried none of them, so no log it wrote was
  // decodable anywhere — including `TierChanged`, the only signal that a reputation token moved a
  // tier. Scribe deliberately does not tail this contract (see model.ts), which is a reason the
  // read model cannot publish a tier from logs; it was never a reason to leave the ABI empty.
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: true, name: "tokenId", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "Locked",
    inputs: [{ indexed: true, name: "tokenId", type: "uint256" }],
  },
  {
    type: "event",
    name: "TierChanged",
    inputs: [
      { indexed: true, name: "agentId", type: "uint256" },
      { name: "tier", type: "uint8" },
    ],
  },
  {
    type: "event",
    name: "ForgeSet",
    inputs: [{ indexed: true, name: "forge", type: "address" }],
  },
  // ADR-0012. The window this log closes is gone from the chain by the time anyone reads it, so the
  // prior figures are in the data rather than left to a read that can no longer answer.
  {
    type: "event",
    name: "EpochStarted",
    inputs: [
      { indexed: true, name: "agentId", type: "uint256" },
      { name: "epoch", type: "uint32" },
      { indexed: true, name: "previousHolder", type: "address" },
      { name: "newHolder", type: "address" },
      { name: "priorWins", type: "uint32" },
      { name: "priorSurvived", type: "uint32" },
      { name: "priorSlashes", type: "uint32" },
      { name: "startedAt", type: "uint64" },
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
  RewardTooLarge: "Reward too large - the ceiling is 1,000 ETH.",
  EscrowCapExceeded: "This contract's escrow ceiling is reached - settle live trials before creating more.",
  ZeroSpec: "The spec CID is empty - pin the spec before creating the trial.",
  ZeroTests: "The tests CID is empty - pin the test suite before creating the trial.",
  ZeroRunner: "Runner key cannot be the zero address.",
  ZeroRunHash: "Run hash is empty - the artifact was not hashed before submission.",
  ZeroProof: "Break proof CID is empty - attach evidence before filing a break.",
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
  SelfBreak: "You cannot break a trial you sponsored or were assigned.",
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
  CommitClosed: "The commit window closed — this seat can no longer seal its vote.",
  BadArgusSeatCount: "The Argus seat set must be exactly three addresses (2-of-3).",
  DuplicateArgusSeat: "Argus seats must be distinct — one key counted twice is not two votes.",
  ZeroArgusSeat: "Argus seats cannot be the zero address; it would silently lower the quorum.",
  NothingToWithdraw: "Nothing to withdraw yet.",
  TransferFailed: "The network refused the transfer. Nothing was lost — try again.",
  Reentrancy: "The network refused the transfer. Nothing was lost — try again.",
} as const;

export type ErrorName = keyof typeof ERROR_COPY;
