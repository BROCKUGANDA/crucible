# Documentation index

Start with the question you have, not the folder.

## I want to understand the product

- [`README.md`](../README.md) — what Crucible is, the demo, the contracts, the
  invariants and the live deployment.
- [`HARDENING.md`](../HARDENING.md) — what is verified, what is not, and the
  open items by severity.
- [`crucible-contracts/docs/contract-spec.md`](../crucible-contracts/docs/contract-spec.md)
  — the contract surface, state machine, economics, invariants and test map.

## I want to know why it is built this way

- [`docs/adr/`](adr/) — the architecture decisions, including the product
  boundary between this agent proving ground and the external USDC PRD, and
  [`ADR-0018`](adr/0018-speech-to-speech-and-turn-monitor.md) — the
  speech-to-speech host and the turn monitor, and why the caller's words never
  reach the synthesiser.
- [`docs/pipeline-ledger.md`](pipeline-ledger.md) — the CI/promotion/deploy
  history and the failures that shaped it.

## I want to know what it would take to make this enterprise-grade

- [`docs/enterprise/`](enterprise/) — the enterprise engagement:
  [`assessment.md`](enterprise/assessment.md) (what the tree actually is,
  measured, with a requirements-to-code matrix),
  [`roadmap.md`](enterprise/roadmap.md) (the five slices and their gates),
  [`target-architecture.md`](enterprise/target-architecture.md),
  [`evaluation-protocol.md`](enterprise/evaluation-protocol.md),
  [`economics-and-incentives.md`](enterprise/economics-and-incentives.md)
  (the two fee schedules, the flow table, and what must not change without
  an ADR),
  [`game-theory.md`](enterprise/game-theory.md) (the mechanism, the
  adversaries, and the equilibria that are still untested),
  [`security-threat-model.md`](enterprise/security-threat-model.md),
  [`collaboration-and-governance.md`](enterprise/collaboration-and-governance.md),
  and [`production-checklist-300.md`](enterprise/production-checklist-300.md)
  (all 300 requirements with a status, an owner, the evidence that decides
  it, a dependency and a release phase).

## I want the business case

- [`docs/business/plan.md`](business/plan.md) — problem, money loop, model,
  moat, traction, honest limits. The Ask section is blank for the founder.
- [`docs/business/valuation-and-raise.md`](business/valuation-and-raise.md) —
  research-backed proposal: competitor funding, valuation benchmarks,
  projected financials/ROI, proposed asking price, uniqueness, and the
  Colosseum hackathon / MVP caveat. Starting point only; founder sets terms.
- [`docs/business/roadmap.md`](business/roadmap.md) — phases, not gate
  numbers (817–875 are taken); mainnet exit criterion is a green preflight.
- [`docs/business/investor-faq.md`](business/investor-faq.md) — the
  60-second answers: why on-chain, revenue, no token, risks, how to verify.
- [`docs/business/pitch/`](business/pitch/) — the pitch deck and the
  Colosseum submission package: `pitch-deck.html` (self-contained, printable),
  the two PDF renders, the generator that produces one of them, the condensed
  contract documentation, and the submission script. The raise figure in the
  deck is the founder's ask, not a commitment; the research behind it is
  [`valuation-and-raise.md`](business/valuation-and-raise.md).

## I have to operate it

- [`docs/runbooks/`](runbooks/) — site down, indexer, deploy, voice host (both
  the one-way host and the speech-to-speech host), contracts, incident response.
- [`docs/setup.md`](setup.md) — local development and the shared edge.
- [`docs/runbooks/credentials-and-deploy.md`](runbooks/credentials-and-deploy.md) — where every credential comes from, box steps, and the mainnet checklist.
- [`docs/key-inventory.md`](key-inventory.md) — every key, what it can reach,
  and what a leak costs.
- [`docs/crucible-deploy-day-gates.pdf`](crucible-deploy-day-gates.pdf) — the
  printable one-page deploy checklist, corrected to this EVM/Anvil deployment.
  The editable source is [`crucible-deploy-day-gates.md`](crucible-deploy-day-gates.md).
- [`docs/security-headers.md`](security-headers.md) — the transport policy.
- [`docs/since-submission.md`](since-submission.md) — what shipped after the
  hackathon window, with the exact commit boundary.

## I want to connect a wallet

- [`docs/wallets.md`](wallets.md) — the current wallet stack, options
  (WalletConnect, Coinbase/Base, Privy, Safe) and what each one costs to set up.
- [`docs/runbooks/coinbase-sandbox.md`](runbooks/coinbase-sandbox.md) — the
  Coinbase CDP CLI, the separate Sandbox CLI, and the agent Sandbox profile.

## I want to review the security posture

- [`SECURITY.md`](../SECURITY.md) — reporting and the security boundary.
- [`crucible-contracts/docs/slither-triage.md`](../crucible-contracts/docs/slither-triage.md)
  — every static-analysis suppression and why.
- [`docs/adr/0006-wallet-signed-api-no-chain-keys.md`](adr/0006-wallet-signed-api-no-chain-keys.md)
  — custody boundary, including the TTS-key exception.
