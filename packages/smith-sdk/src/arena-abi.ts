/**
 * Arena's ABI — GENERATED, do not edit by hand.
 *
 * Source: `crucible-contracts/out/Arena.sol/Arena.json` (solc 0.8.26+commit.8a97fa7a).
 * Regenerate with `node scripts/arena-abi.mjs` after any change to `contracts/Arena.sol`.
 *
 * Generated rather than hand-written because there are 51 functions, 23 events and
 * 54 errors; a hand-typed copy of that is a transcription bug waiting for a chain to decode it
 * wrongly. `packages/smith-sdk/test/abi-drift.test.ts` still compares the EVENTS to the Solidity
 * source, which is the part whose parameter order changes topic0.
 */
export const ARENA_ABI = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "treasury_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "court_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "randomnessMode_",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "ATTEST_TYPEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "BPS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "DOMAIN",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_FILING",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "RUN_TYPEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "activeClaimsOf",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "amountsOf",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "reward",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "fee",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "bond",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "deposited",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "paidOut",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "breakAt",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "index",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "skeptic",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "stake",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "seatFee",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "revealed",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "onDocket",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "landed",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "kind",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "committedAt",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "breakCount",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "cancelTrial",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "claimTimeout",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "claimTrial",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "commitBreak",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "commitment",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "commitVote",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "commitment",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "conservationDetail",
    "inputs": [],
    "outputs": [
      {
        "name": "balanceOk",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "booksOk",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "conservationHolds",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "court",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract ArgusCourtPublic"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "credit",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "digestsOf",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "specDigest",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "suiteDigest",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "holdoutCommitment",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "holdoutDigest",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "runHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "verdictHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "replayHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "modelHarnessId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "docketSize",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "drawPanel",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "round",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "expireTrial",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "freezeDocket",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "isAttestor",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "minimumStake",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "panelDrawnAt",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "round",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "panelSeats",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "round",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "partiesOf",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "sponsor",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "agent",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "runner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "postTrial",
    "inputs": [
      {
        "name": "reward",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "specDigest",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "suiteDigest",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "holdoutCommitment",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "skepticWindow",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "openSpan",
        "type": "uint40",
        "internalType": "uint40"
      }
    ],
    "outputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "randomnessMode",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "revealBreak",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "index",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "kind",
        "type": "uint8",
        "internalType": "enum Arena.BreakKind"
      },
      {
        "name": "evidence",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "revealHoldout",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "holdoutDigest",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "revealVote",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "round",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "votes",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "replayHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "seatFeePerBreak",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setAttestor",
    "inputs": [
      {
        "name": "attestor",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "allowed",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setRunner",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "runner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "stateOf",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "status",
        "type": "uint8",
        "internalType": "enum Arena.Status"
      },
      {
        "name": "outcome",
        "type": "uint8",
        "internalType": "enum Arena.Outcome"
      },
      {
        "name": "round",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "docketFrozen",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "holdoutRevealed",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "holdoutMissed",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "submitRun",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "artifactDigest",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "verdictHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "replayHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "modelHarnessId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "nonce",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "sigDeadline",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "runnerSig",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "attestorSig",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "tally",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "totalDeposited",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "totalPending",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "totalWithdrawn",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "treasury",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "trialCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "voteOf",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "round",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "seat",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "voteVoided",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "round",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "seat",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "windowsOf",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "openedAt",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "openUntil",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "claimDeadline",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "submittedAt",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "windowEnd",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "holdoutDueBy",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "skepticWindow",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "withdraw",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "withdrawn",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "yieldTrial",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "AttestorSet",
    "inputs": [
      {
        "name": "attestor",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "allowed",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "BreakCommitted",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "index",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "skeptic",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "stake",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "seatFee",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "BreakRevealed",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "index",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "kind",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      },
      {
        "name": "evidence",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "BreakTallied",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "round",
        "type": "uint8",
        "indexed": true,
        "internalType": "uint8"
      },
      {
        "name": "breakIndex",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "upheld",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      },
      {
        "name": "rejected",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      },
      {
        "name": "landed",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Cancelled",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "sponsor",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ClaimTimedOut",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "agent",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "forfeit",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "reopened",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Credited",
    "inputs": [
      {
        "name": "to",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "DocketFrozen",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "docketSize",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ExitRecorded",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "outcome",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum Arena.Outcome"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Expired",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "sponsor",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "HoldoutMissed",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "HoldoutRevealed",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "holdoutDigest",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PanelDrawn",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "round",
        "type": "uint8",
        "indexed": true,
        "internalType": "uint8"
      },
      {
        "name": "seat0",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "seat1",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "seat2",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "devnetRandomness",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RunSubmitted",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "agent",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "runHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "verdictHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "replayHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RunnerSet",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "runner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SeatSlashed",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "round",
        "type": "uint8",
        "indexed": true,
        "internalType": "uint8"
      },
      {
        "name": "seat",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Settled",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "outcome",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum Arena.Outcome"
      },
      {
        "name": "agentCredit",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "sponsorCredit",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "treasuryCredit",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "TrialClaimed",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "agent",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "bond",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "claimDeadline",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "TrialPosted",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "sponsor",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "reward",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "fee",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "specDigest",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "skepticWindow",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "VoteCommitted",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "round",
        "type": "uint8",
        "indexed": true,
        "internalType": "uint8"
      },
      {
        "name": "seat",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "VoteRevealed",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "round",
        "type": "uint8",
        "indexed": true,
        "internalType": "uint8"
      },
      {
        "name": "seat",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "votesHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Withdrawn",
    "inputs": [
      {
        "name": "to",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Yielded",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "agent",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AlreadyClaimed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadyCommitted",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadyRevealed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadyRevealedVote",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AttestationNotPassed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadDeadline",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadDraw",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadOpenSpan",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadSigLength",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadSigner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadState",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadWindow",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BondShortfall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BreakUnknown",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ClaimWindowClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CommitClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CommitMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DigestMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DocketAlreadyFrozen",
    "inputs": []
  },
  {
    "type": "error",
    "name": "HoldoutAlreadyRevealed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "HoldoutCommitmentMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "HoldoutDeadlinePassed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "HoldoutUnknown",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoRunner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NonceReplayed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAgent",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAttestor",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotOwner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotRunner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotSeat",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotSponsor",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NothingToWithdraw",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PanelAlreadyDrawn",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PanelNotDrawn",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RandomnessNotConfigured",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RevealWindowClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RewardMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RewardTooSmall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RoundTooLate",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SeatFeeWrong",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SelfBreak",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SelfClaim",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SigExpired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SigMalleable",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StakeTooSmall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TallyOpen",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TooManyActiveClaims",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TooManyBreaks",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TooSmall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TransferFailed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "VoteLen",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WindowStillOpen",
    "inputs": []
  },
  {
    "type": "error",
    "name": "YieldCooldown",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;
