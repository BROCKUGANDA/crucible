# Transaction Threat Model

## Threats

- Wallet connection treated as authentication (mitigation: SIWE verified server-side,
  durable single-use nonces).
- Client-supplied chain IDs / tx states trusted (mitigation: server-side chain ID
  validation against authoritative RPC; verify bytecode vs manifest).
- Replay of idempotency keys across principals (mitigation: scope by principal).
- Sponsored-gas abuse (mitigation: per-sender/per-op limits, allowlists, approval
  webhook fail-closed, emergency disable).
- Ambiguous submission retried blindly (mitigation: reconcile before retry).
- In-memory state as source of truth (mitigation: Postgres; in-memory only for
  demo).
- Secret leakage to frontend (mitigation: server-side only; env separation).
- Reviewer collusion / premature reveal (mitigation: commit-reveal, independent
  verdicts before cross-visibility).

## Controls not yet implemented

- Durable idempotency store (currently in-memory, ADR-0008).
- Alchemy Gas Manager policy + approval webhook.
- Solana program native-SOL escrow rewrite.
- Hardware signer / Safe configuration.
