# Secrets & Key Management — Crucible

## Inventory (owners, rotation — no values)
- `AUTH_SECRET` — API owner, rotate 90d, KMS/HSM in prod.
- `KEEPER_PRIVATE_KEY` / `JUROR_SEAT_PRIVATE_KEY` — keeper/juror services, separate per env, never in repo/images/logs.
- `ALCHEMY_*`, `REDIS_URL`, `DATABASE_URL` — infra owner, per-env projects.
- `KEEPER_API_KEY` — trusted worker bearer for `/engrams/evaluate`.

## Rules
- Managed secret store (KMS); env-specific identities; access logged.
- No secrets in `NEXT_PUBLIC_*`, bundles, URLs, or committed `.env`.
- Public RPC client keys restricted by domain/method/IP where provider supports.
- API holds no chain private key (ADR-0006); user txs wallet-signed; treasury via Safe multisig.
- Compromise → rotate, verify revocation, search downstream consumers.
