# ADR-0026: Optional Web3Auth EOA and draft-only Safe Protocol Kit

- **Status:** Accepted (limited application integration scope; 2026-11-19)
- **Depends on:** ADR-0006 (wallet-signed writes and no API chain keys), ADR-0020 (company Treasury Safe and mainnet release gates)
- **Does not:** enable mainnet treasury use, change contracts, add a relayer, create a Safe, collect Safe signatures, submit transactions, or execute transactions

## Context

Crucible currently uses wagmi v2 and RainbowKit for user-controlled wallet connections. Its optional SIWE session proves an address to the API; it does not authorize the API to sign. The user requested Web3Auth and Safe Protocol Kit integration.

ADR-0020 remains proposed and the mainnet preflight has unresolved audit, legal, Safe, deployment, RPC, and operations evidence. Safe transaction construction must therefore be separated from approval and execution, and no integration may be interpreted as mainnet release approval.

## Decision

1. Add Web3Auth's browser modal as an **optional wagmi connector**. It is available only when `NEXT_PUBLIC_WEB3AUTH_CLIENT_ID` is configured, and the EVM chains and login methods must also be configured in the Web3Auth dashboard. The public client id is not a secret.
2. The connected Web3Auth account is an EOA provider for the existing wallet flows. Crucible does not call private-key export methods. A Web3Auth connection alone does not create an API session; existing SIWE authentication remains separate.
3. Use Safe Protocol Kit in the browser to inspect the exact Safe address returned by the deployed escrow's `treasury()` getter, verify that it is deployed on the configured chain, check the connected EOA against the on-chain owner list, read the threshold, and locally construct/hash the escrow's fixed `withdraw()` call.
4. The Safe draft is unsigned and local to the page. Crucible does not sign it, send it to a Safe Transaction Service, broadcast it, or execute it. The target and calldata are fixed to the configured escrow and `withdraw()`; no recipient input is added. A Safe owner's EOA cannot withdraw by itself.
5. Mainnet Safe draft creation remains hard-disabled. Re-enabling it requires a separate reviewed code change after every ADR-0020 release gate has been accepted and independently verified; this ADR does not accept ADR-0020 or authorize a deployment.

This changes only ADR-0006's current-product consequence that email/social embedded wallets are absent. ADR-0006's no-chain-key API boundary, user-approved wallet signing, and separation of SIWE from transaction authority remain in force.

## Consequences

- A configured Web3Auth login can produce an EOA without browser extensions; use of that account still depends on Web3Auth's authentication, recovery, availability and privacy policies.
- The web client and API do not receive an exported private key, and the API gains no transaction route or chain key.
- Safe owner information and treasury credit are public chain data. The UI's owner check is a presentation gate, not a privacy or on-chain authorization boundary.
- Safe Protocol Kit's draft hash is not an approval, proposal, or execution receipt. Users must independently review the target, chain, Safe configuration, current credit and threshold in the Safe interface before any separately authorized action.
- Production activation requires a real Web3Auth project configuration and provider policy review. Real-value treasury actions remain blocked by ADR-0020.

## Alternatives considered

- **Keep extension-only wallets:** preserves the current onboarding path but does not provide the requested email/social EOA option.
- **Use a server signer, relayer, or Safe Transaction Service submission:** rejected for this integration because it introduces transaction authority or off-page proposal side effects and conflicts with the no-chain-key boundary.
- **Sign or execute Safe transactions in Crucible:** rejected for this scope; it would require a distinct approval, signing UX, transaction review, operational rehearsal, and the still-incomplete mainnet release evidence.

## Evidence

- `apps/web/src/lib/web3auth-connector.ts` — optional wagmi v2 Web3Auth connector.
- `apps/web/src/lib/safe-withdrawal.ts` — owner verification and draft-only Protocol Kit interface.
- `apps/web/src/app/treasury/page.tsx` — owner-gated UI and mainnet refusal.
- `apps/web/test/web3auth-connector.test.ts` and `apps/web/test/safe-withdrawal.test.ts` — offline lifecycle and fail-closed regression tests.
- [Web3Auth Signer guide](https://docs.safe.global/sdk/signers/web3auth) and [Safe Protocol Kit](https://docs.safe.global/sdk/protocol-kit).