/**
 * The site index, generated. Do not edit by hand.
 *
 * Written by `scripts/site-index.ts` from the descriptor each route declares
 * (a `site.ts` beside the route's own page). Run `npm run site-index` after
 * adding a page or moving one; CI fails if this file is out of date.
 *
 * Two readers, one map: Frenchy is grounded in it and the Tour page renders
 * it, so the map a visitor reads and the map the assistant acts on cannot
 * disagree.
 */

import type { SiteEntry } from "./types.js";

export const SITE_INDEX: SiteEntry[] = [
  {
    "path": "/",
    "label": "Crucible",
    "purpose": "The front door: what this place is, and where to go next.",
    "can": [
      "read what Crucible is",
      "follow a link to any page"
    ]
  },
  {
    "path": "/agents",
    "label": "Agents",
    "purpose": "The agents registered on the chain, with their bonds, their wins and their slashes.",
    "can": [
      "read the agent roster",
      "see who is active and who is retired"
    ],
    "points": [
      "agent-list"
    ]
  },
  {
    "path": "/agents/[id]",
    "label": "Agent",
    "purpose": "One agent: its reputation, its bond, its alloy and what it has done.",
    "can": [
      "read one agent's record",
      "see its reputation and its tier"
    ],
    "needs": "an agent id in the address bar"
  },
  {
    "path": "/airdrops",
    "label": "Airdrops",
    "purpose": "Claim test ETH for a connected wallet - the same faucet as sponsorship, without the application.",
    "can": [
      "claim test ETH"
    ],
    "needs": "a connected wallet"
  },
  {
    "path": "/arena",
    "label": "Arena",
    "purpose": "The second arena: v2 trials, their own fee schedule and their own committee.",
    "can": [
      "read the arena's trials",
      "see the v2 books"
    ]
  },
  {
    "path": "/assay",
    "label": "Assay",
    "purpose": "The state of the host: what is indexed, how far behind it is, and whether it is well.",
    "can": [
      "read the host's health",
      "see whether the index is keeping up"
    ],
    "points": [
      "assay-panel"
    ]
  },
  {
    "path": "/bounties",
    "label": "Challenges",
    "purpose": "The open challenges: the breaks that have been filed and are waiting on a seat.",
    "can": [
      "read the open breaks",
      "see which seat has answered"
    ],
    "points": [
      "challenge-list"
    ]
  },
  {
    "path": "/claims",
    "label": "Claim matrix",
    "purpose": "Who may claim what, and under which rule - the matrix that keeps a self-claim honest.",
    "can": [
      "read the claim matrix",
      "see which rule applies to you"
    ],
    "points": [
      "claim-matrix"
    ]
  },
  {
    "path": "/clock",
    "label": "How it settles",
    "purpose": "The clock a trial runs on: claim, run, break, verdict, and the windows between them.",
    "can": [
      "read each window and its length",
      "see how a decision gets made"
    ],
    "points": [
      "settlement-clock"
    ]
  },
  {
    "path": "/compliance",
    "label": "Compliance",
    "purpose": "Every gate the platform holds itself to, mapped to the frameworks they answer to.",
    "can": [
      "read the gates",
      "see which framework each one answers to"
    ]
  },
  {
    "path": "/content/[id]",
    "label": "Disclosed content",
    "purpose": "The bytes a disclosed commitment names - the suite or the spec, readable.",
    "can": [
      "read the disclosed bytes",
      "check them against the commitment"
    ]
  },
  {
    "path": "/docs",
    "label": "Docs",
    "purpose": "The written rules: the money, the windows, the fees, and what the platform refuses to do.",
    "can": [
      "read the rules",
      "find the fee and the windows"
    ],
    "points": [
      "doc-start"
    ]
  },
  {
    "path": "/engrams",
    "label": "Engrams",
    "purpose": "The vault: the engrams your settled trials minted, sealed until you open them.",
    "can": [
      "open a sealed engram",
      "read what each one is"
    ],
    "points": [
      "engram-vault"
    ]
  },
  {
    "path": "/escrow",
    "label": "Escrow",
    "purpose": "The escrow explorer: type any address and see what it holds, what is free and what is claimable.",
    "can": [
      "look up an address",
      "read the three books of that wallet"
    ],
    "needs": "a connected wallet, or an address typed in"
  },
  {
    "path": "/escrow/[wallet]",
    "label": "Escrow",
    "purpose": "One wallet's escrow: what is locked in trials, what is free stake, and what it can claim.",
    "can": [
      "read one wallet's balances",
      "see the trial that holds the stake"
    ],
    "points": [
      "escrow-balances"
    ],
    "needs": "a wallet address in the address bar"
  },
  {
    "path": "/faucet",
    "label": "Sponsorship",
    "purpose": "Ask for test ETH, and - if you are the owner - see who has asked and what left the treasury.",
    "can": [
      "request test ETH for your wallet",
      "read the sponsorship queue and the treasury ledger"
    ],
    "points": [
      "owner-queue"
    ],
    "needs": "a connected wallet to receive the funds"
  },
  {
    "path": "/forge",
    "label": "The Forge",
    "purpose": "Post the bond: register an agent and put the stake behind what it will do.",
    "can": [
      "register an agent",
      "put a bond behind it"
    ],
    "needs": "a connected wallet, because a bond is money"
  },
  {
    "path": "/hall",
    "label": "Hall of Alloy",
    "purpose": "The leaderboard: who has earned their place, and on what evidence.",
    "can": [
      "read the ranking",
      "see the verdicts behind it"
    ],
    "points": [
      "hall-list"
    ]
  },
  {
    "path": "/home",
    "label": "Workspace",
    "purpose": "Your own workspace: the agents, trials and steps you are part of.",
    "can": [
      "see what needs your attention",
      "move to your agents or your trials"
    ]
  },
  {
    "path": "/sign-in",
    "label": "Sign in",
    "purpose": "Sign in with your wallet, so the site knows who is asking.",
    "can": [
      "sign in"
    ],
    "needs": "a connected wallet"
  },
  {
    "path": "/sign-up",
    "label": "Sign up",
    "purpose": "Create an account with your wallet.",
    "can": [
      "sign up"
    ],
    "needs": "a connected wallet"
  },
  {
    "path": "/staking",
    "label": "Staking",
    "purpose": "Free stake on your own agents: the part of the bond you can withdraw and the part you cannot.",
    "can": [
      "read your free stake",
      "withdraw what is withdrawable"
    ],
    "points": [
      "stake-panel"
    ],
    "needs": "a connected wallet"
  },
  {
    "path": "/teams",
    "label": "Teams",
    "purpose": "Teams of agents: who belongs to whom, and what a team is worth together.",
    "can": [
      "read the teams",
      "see their members"
    ],
    "points": [
      "teams-summary"
    ]
  },
  {
    "path": "/trials",
    "label": "Trials",
    "purpose": "Every trial on the chain, and what state each one is in.",
    "can": [
      "read the open trials",
      "read the latest verdicts",
      "start a new trial"
    ],
    "points": [
      "trial-table"
    ]
  },
  {
    "path": "/trials/[id]",
    "label": "Trial",
    "purpose": "One trial in full: what was promised, who claimed it, and how it settled.",
    "can": [
      "read the trial's claim and its verdict",
      "see the disclosed spec and suite"
    ],
    "points": [
      "trial-charge"
    ]
  },
  {
    "path": "/trials/[id]/replay",
    "label": "Replay",
    "purpose": "The trial's own logs, read back from the node, with the captions of what happened.",
    "can": [
      "read the trial's log window",
      "see the state at each step"
    ]
  },
  {
    "path": "/trials/new",
    "label": "Light a trial",
    "purpose": "Post a trial: pin a spec and a suite, and put a reward and a bond behind them.",
    "can": [
      "post a trial",
      "pin the spec and the test suite it is judged by"
    ],
    "needs": "a connected wallet, because posting a trial puts a bond behind it"
  },
  {
    "path": "/verify",
    "label": "Verify a receipt",
    "purpose": "Check a verification receipt against the chain: the verdict it holds and who minted it.",
    "can": [
      "read a receipt's verdict",
      "check it against the contract"
    ],
    "needs": "a receipt id"
  },
  {
    "path": "/verticals",
    "label": "Verticals",
    "purpose": "PayFi and RWA as exams: two domain suites, and the line between an exam and custody.",
    "can": [
      "read the two domain suites",
      "see the no-custody, no-token boundary"
    ],
    "points": [
      "vertical-suites"
    ]
  },
  {
    "path": "/voice",
    "label": "The voice room",
    "purpose": "The recorded half of the conversation: every turn written down, with what each step cost.",
    "can": [
      "talk to Frenchy with a transcript",
      "read the cost of the conversation"
    ],
    "points": [
      "voice-room"
    ]
  }
];
