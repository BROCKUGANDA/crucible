# ADR-0029: Chain environments and the off-chain conversion path

**Date:** 2026-11-20  
**Status:** Accepted (EVM target decided; Solana target split)  
**Related:** ADR-0002 (Native ETH Escrow), ADR-0006 (API Holds No Chain Key), ADR-0011 (Adversarial Escrow), ADR-0023 (Production Infrastructure), ADR-0025 (Forge Watch Runtime Monitoring)

## Context

The tree has never approved a mainnet. Every deployment runs against local
Anvil (chain id 31337); Base Sepolia appears as a *test* path; `scripts/mainnet-preflight.mjs`
refuses to certify a deployment because it cannot check a chain that was never
chosen. The chain decision was the largest open question in the flagship
assessment, and it blocks: the VRF consumer (a coordinator address is
chain-specific), the treasury multisig, the withdrawal rehearsal, the RPC
provider, and the sponsor funding verification (an escrow address is
chain-specific).

Two related questions came with it:

- **The Solana side.** Crucible has a Solana program (`packages/stamp-solana`,
  `stamp-solana.sol`) that is currently a scaffold. "Solana Sepolia" does not
  exist — Solana's networks are mainnet, devnet and testnet. The decision
  therefore has to state which one, and whether it is a separate release or
  the same one.
- **1inch.** 1inch is a DEX aggregator and intent router. It was named in the
  same breath as the chains. It is not a chain, and using it as one would
  mean bolting an ERC-20 into the escrow — the change ADR-0001 rejected.

## Decision

### 1. The EVM target is Ethereum mainnet (chain id 1)

The Arena, the escrow and the trial contracts deploy to **Ethereum mainnet**.

**Rationale:**
- The arena's fee, the bond floors and the reward floor all assume finality
  in hours, not minutes: a trial's dispute window, an agent's claim deadline
  and a sponsor's cancellation window are all wall-clock periods. A chain
  whose reorganisation depth is measured in minutes turns "the trial expired"
  into "the trial expired, unless the chain disagrees". Ethereum's
  finality is the strongest of the candidates and it is the one the sponsor
  pilot's own dates assume.
- The V2 arena is unproven on any public chain. The first public deployment
  should be on the chain with the deepest liquidity of any, because the
  failure mode being insured against — a dispute nobody can afford to settle
  because the ETH is illiquid — is cheapest to avoid on the deepest chain.
- One EVM chain, one escrow, one fee. Two EVM mainnets would mean two
  escrow deployments and two settlement stories for one product.

**Consequences, accepted:**
- Gas costs are real: `postTrial` plus a claim plus a submission on Ethereum
  mainnet costs materially more than on a testnet. This is a per-trial cost
  borne by the sponsor, and it is disclosed in the sponsor's pricing, not
  hidden.
- The chain is EVM-only for the EVM track. **The Solana track does not use
  these contracts, does not use this escrow, and does not settle in this
  escrow.** See §2.

### 2. The Solana track is Devnet first, and it is a SEPARATE release

The Solana program deploys to **Solana Devnet** for its own pilot, and to
Solana mainnet only after the Devnet pilot produces evidence and an
independent review.

**Rationale:**
- Devnet is Solana's test network. There is no "Sepolia" on Solana, and
  naming a network that does not exist in a configuration file is the kind of
  error that survives until the day someone funds a subscription against it.
- The two chains have different escape hatches, different finality models
  and different fee markets. Sharing a release would mean one program's
  results are governed by whichever chain happened to be slower that week.
  Separate releases mean separate evidence, separate reconciliation and
  separate failure modes — and a sponsor can be told which one they bought.
- Devnet tokens are worthless, and the whole point of the pilot is to learn
  whether the money flows. The Devnet pilot exercises everything EXCEPT the
  money; the money is exercised on the Ethereum track with real ETH, in a
  capped pilot, after the VRF consumer and the multisig exist.

**Consequences, accepted:**
- A trial on one chain is not comparable with a trial on the other. The
  product says so explicitly rather than implying one ledger.
- Two deployments, two indexers, two sets of runbooks. This is the cost of
  not pretending a Solana deployment is an EVM one.

### 3. 1inch is an off-chain conversion path, never an escrow asset or a settlement rail

A sponsor who holds USDC (or any token) can convert to native ETH through a
1inch intent **before** funding, and the funded escrow is still native ETH.

**Rationale:**
- ADR-0002 keeps the arena native-ETH. The conservation invariant
  (`test/Invariants.t.sol:170`) is stated in wei, and adding a token to the
  escrow means a second accounting, a second price oracle, a second rounding
  rule and a second failure mode inside the money path. The directive this
  session follows says so directly: a USDC arena requires a new ADR and a
  new contract review, not a feature request.
- 1inch is an aggregator over many venues. Depending on it for a *settle-
  ment* path would mean the settlement's amount depends on a third party's
  routing at the moment of execution — which is a different product with a
  different risk profile, not a feature of this one.
- As an ON-RAMP it adds nothing to the money path at all: the sponsor's
  tokens become ETH in their own wallet, and the escrow sees exactly what it
  saw before — native ETH from a sponsor address.

**Consequences, accepted:**
- The conversion is the SPONSOR's business. Crucible shows the fiat/token
  price separately and never names it as the funding amount.
- The receipt of a conversion is the sponsor's, not Crucible's. Crucible's
  receipt is the escrow deposit, and it is denominated in ETH, always.
- If a future sponsor wants to fund in a stablecoin directly, that is a new
  ADR and a new contract review. It is explicitly out of scope here.

### 4. The chain fact for a sponsor's funding is the ARENA's escrow, read over RPC

A sponsor's funding is verified by reading the arena's own views
(`amountsOf`, `partiesOf`, `stateOf`) over a public RPC. The API holds no key
(ADR-0006): verification is a read, never a signature.

**Rationale:**
- The escrow is where the sponsor's money actually is. A sponsor's program
  budget is a claim about the escrow, and the escrow is the thing that can
  be wrong.
- The sponsor's escrowed amount is `reward + fee`, NOT `deposited`:
  `deposited` also holds the agent's bond and the skeptics' stakes, so
  reporting it as the sponsor's money would overstate every sponsor's
  funding by the bonds in the arena.

### 5. The randomness decision is unchanged by this ADR and remains a blocker

Mode 0 (deterministic seed) is a demo configuration and is not acceptable on
Ethereum mainnet. The VRF consumer is a separate piece of work with its own
review, and the preflight still refuses to certify an unsigned deployment.

## Consequences

- The chain configuration gains an explicit registry: Ethereum mainnet
  (chain id 1) for the EVM track, Solana Devnet for the Solana track, with
  the environment chosen by `CHAIN_ENV` and never by a silent default.
- `CHAIN_ENV=mainnet` now means a specific chain rather than "some chain
  somebody configured".
- The API gains a chain reader over public RPC and a funding-verification
  path built on it.
- Every mainnet deployment needs: a funded VRF subscription on Ethereum
  mainnet, a multisig treasury, a withdrawal rehearsal, reconciliation
  between chain truth and the commercial ledger, and independent review.
  None of those are supplied by this ADR.
- Solana devnet deployment needs its own RPC, its own indexer and its own
  runbook, because "Sepolia" had never been a real place to deploy to.
