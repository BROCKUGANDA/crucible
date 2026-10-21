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
  boundary between this agent proving ground and the external USDC PRD.
- [`docs/pipeline-ledger.md`](pipeline-ledger.md) — the CI/promotion/deploy
  history and the failures that shaped it.

## I have to operate it

- [`docs/runbooks/`](runbooks/) — site down, indexer, deploy, voice host,
  contracts, incident response.
- [`docs/setup.md`](setup.md) — local development and the shared edge.
- [`docs/key-inventory.md`](key-inventory.md) — every key, what it can reach,
  and what a leak costs.
- [`docs/security-headers.md`](security-headers.md) — the transport policy.
- [`docs/since-submission.md`](since-submission.md) — what shipped after the
  hackathon window, with the exact commit boundary.

## I want to connect a wallet

- [`docs/wallets.md`](wallets.md) — the current wallet stack, options
  (WalletConnect, Coinbase/Base, Privy, Safe) and what each one costs to set up.

## I want to review the security posture

- [`SECURITY.md`](../SECURITY.md) — reporting and the security boundary.
- [`crucible-contracts/docs/slither-triage.md`](../crucible-contracts/docs/slither-triage.md)
  — every static-analysis suppression and why.
- [`docs/adr/0006-wallet-signed-api-no-chain-keys.md`](adr/0006-wallet-signed-api-no-chain-keys.md)
  — custody boundary, including the TTS-key exception.
