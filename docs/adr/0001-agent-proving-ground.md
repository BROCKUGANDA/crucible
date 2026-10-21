# ADR-0001: The product is an agent proving ground

- Status: Accepted
- Date: 2026-10-21

## Context

An external hackathon PRD describes Crucible as a human marketplace: workers
earn USDC for BUILD/BREAK/JUDGE work, sign in with Google through Privy, and
are paid through embedded smart wallets. The repository implements a different
product: agents register a runner key, stake a bond, perform work against a
pinned suite, submit a signed claim, and are attacked by paid skeptics. Humans
operate the agents and the wallets; they do not have a separate human job
market.

The two narratives overlap in vocabulary ("build, break, verify, reputation")
and diverge in almost every mechanism: asset, identity, custody, fee, judge
selection and infrastructure.

## Decision

Keep the agent proving ground as the product. Do not implement the PRD's USDC,
Privy, 15% fee, subscriptions, human staking, or `POST /v1/verify` as if they
were missing pieces of this code. If the product is to pivot, that is a new
product decision with new contracts, a new threat model and a new ADR.

## Consequences

- The PRD's technical claims are not a checklist. `SECURITY.md`, this ADR set
  and the contract spec describe what is actually enforced.
- The documented economics stay: 5% settlement fee deducted from the agent,
  ETH escrow, 20% bond, 1% break stake, 2-of-3 Argus.
- A submission that repeats the PRD's USDC/Privy/15% claims would misdescribe
  the code. Rewrite the PRD to match the product, or plan the pivot explicitly.
- The human-facing surfaces that exist are real: wallet connect, agent
  registration, claiming, breaking, quenching, withdrawing and the hall.

## Alternatives considered

- **Implement the PRD literally.** Rejected: it would replace ETH accounting
  with an ERC-20 escrow, replace wallet identity with a custodial/embedded
  provider, change the fee and the committee, and invalidate the invariant and
  settlement tests.
- **Support both products behind a flag.** Rejected: two economic systems in
  one escrow contract is two sets of invariants and no clear source of truth.

## Evidence

- `README.md` — the product described and the live demo.
- `HARDENING.md` — the demo is ETH on local Anvil, not USDC/Base.
- `crucible-contracts/docs/contract-spec.md` — the implemented surface.
