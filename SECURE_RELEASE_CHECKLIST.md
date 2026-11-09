# Secure Release Checklist — Crucible

- [ ] G1 Identity: SIWE negative tests pass, forged cookie rejected, session revocation works.
- [ ] G2 Authorization: cross-tenant tests pass for every resource.
- [ ] G3 Runtime: telemetry coverage complete, outbox durable, worker replay idempotent.
- [ ] G4 Verification: Argus round trip, report lineage, chain canonicality.
- [ ] G5 Rewards: entitlement idempotency, claim tests, no client-granted entitlements.
- [ ] G6 Treasury: funded campaign, Safe approval, reconciliation matches.
- [ ] G7 Staking/collateral: no yield language, unstake→credit→withdraw tested.
- [ ] G8 Ops: on-call named, dashboards live, backup restore drilled, RPO/RTO measured.
- [ ] SBOM generated, image digest pinned, release signed.
- [ ] Mainnet: Safe verified on-chain, audit complete, withdrawal rehearsed.
