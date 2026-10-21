# ADR-0002: Native ETH escrow on the demo chain

- Status: Accepted
- Date: 2026-10-21

## Context

The contracts escrow and pay native ETH with `msg.value` and
`address.call{value:}`. The external PRD specifies USDC on Base, EIP-2612
permit funding and a Base Sepolia sandbox. None of those exist in this tree.

## Decision

Keep native ETH for the demo. Do not add a second asset, a token address, an
ERC-20 interface or a permit path to `CrucibleTrials`. A USDC deployment is a
new contract and a new threat model, not a configuration flag.

## Consequences

- The bond, break stake, settlement fee and caps are denominated in ETH.
- Funding is one payable transaction; there is no EIP-2612 one-tx permit.
- The live deployment is a local Anvil demonstration. A real-value deployment
  must decide the chain, asset, oracle/price risk, treasury custody and legal
  treatment in a new ADR.
- The UI shows ETH and a `Withdraw ⟨amount⟩ ETH` control, not a USDC balance.

## Alternatives considered

- **Dual-asset escrow (ETH + USDC).** Rejected: doubles the accounting and
  invariant surface, and the demo has no USDC liquidity.
- **USDC-only rewrite.** Rejected for this session: it is a product pivot, not
  a refactor, and would invalidate the tested settlement math.

## Evidence

- `crucible-contracts/contracts/CrucibleTrials.sol` — `createTrial` payable,
  `withdraw` ETH, `FEE_BPS` in ETH terms.
- `HARDENING.md` — "The demo is ETH on a local Anvil chain."
- `docs/adr/0001-agent-proving-ground.md`.
