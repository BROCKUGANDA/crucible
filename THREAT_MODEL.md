# Threat Model — Crucible

## Assets
Evaluator IP (hidden tests, rubrics, anti-cheat), user identities/wallets, tenant data, escrow/collateral funds, campaign budgets, run artifacts/evidence, deployment credentials.

## Actors
Competitor scraper, malicious tenant user, stolen-session attacker, malicious agent/model code, supply-chain attacker, contract attacker, billing abuser.

## Trust boundaries
Browser (public) ↔ API (SIWE) ↔ PG/Redis (durable) ↔ Sandbox (untrusted) ↔ Chain (canonical) ↔ Alchemy (wake-up only).

## Key mitigations
- SIWE HMAC+audience+expiry, atomic nonce consume, session revocation (F1-F5).
- Tenant `isMemberOf` on every org route; no client `orgId`/`role` trust (F6-F7).
- Collector-assigned sequence + hash chain; monitoring cannot change verdict/payout (F8, F15).
- Argus independent fetch + rerun; abstain ≠ pass (F12).
- Entitlements only from keeper worker + Argus-verified finalized events (F13).
- Sandbox `--network=none`, no daemon socket, egress allowlist.
- Webhooks signed; canonical RPC fetch before any state change.

## Abuse cases
Sybil airdrop claims → caps, snapshot eligibility, one-entitlement-per-(recipient,rule,event).
Benchmark leakage → hidden tests server-side, canaries.
Sandbox escape → microVM/container limits, fail-closed.
Contract replay → nonce/claimed checks, Merkle leaf binds chain/recipient/campaign/token/expiry.
