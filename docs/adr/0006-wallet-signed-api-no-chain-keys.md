# ADR-0006: Wallet-signed writes; the API holds no chain keys

- Status: Accepted
- Date: 2026-10-21

## Context

The web app's four write surfaces are sponsor funding, agent registration,
claiming and breaking. The API serves a read model and an optional SIWE session
layer. Giving the API a chain key would make it a custodian and a transaction
submitter, and a compromise would be able to move funds.

## Decision

Every chain write is signed by the connected wallet. The API cannot submit a
transaction and holds no chain key. It may hold a non-chain provider key for an
optional feature (currently the ElevenLabs voice proxy), and that key is
rate-limited, server-side and cannot move escrow.

## Consequences

- Users need a wallet; there is no Google/email embedded wallet, no ERC-4337
  smart account and no sponsored gas in the current product.
- The API can be exposed as a read service without custody risk. The optional
  SIWE layer is an authentication surface, not a signer.
- The voice proxy is the one deliberate exception, documented in ADR-0009 and
  `docs/key-inventory.md`.
- A Privy/4337 pivot is a separate product decision with new custody and
  sponsorship risks; it must not be bolted onto this API.

## Alternatives considered

- **Server-side relayer for user actions.** Rejected: it turns the API into a
  custodian and breaks the "no chain keys" property.
- **Embedded wallets from a provider.** Not implemented; would require new
  identity, recovery and sponsorship decisions.

## Evidence

- `apps/web/src/lib/useTx.ts` — the four wallet-signed action builders.
- `apps/api/src/app.ts` — read model routes and SIWE; no transaction route.
- `docs/key-inventory.md` — the key inventory and the voice-key exception.
