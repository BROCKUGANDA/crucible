# Incident Response — Crucible

## Severity
- SEV1: fund movement risk, sandbox escape, auth bypass → page on-call, pause settlement/campaigns, freeze new runs.
- SEV2: tenant data exposure, Argus/indexer divergence → contain, preserve evidence.
- SEV3: degraded telemetry/RPC → fail closed for verification, degrade public reads only.

## Playbooks
1. Compromised credential → revoke sessions/API keys, rotate secret, audit `audit_events`.
2. Malicious release → rollback to signed prior build, verify SBOM/provenance.
3. Sandbox escape → kill worker fleet, rotate job credentials, review evidence.
4. Chain reorg → mark affected runs `RECONCILIATION_REQUIRED`, replay indexer, no rewards until final.
5. Contract emergency → Safe pause, timelock change, user notification.

## Owners
On-call named in `docs/mainnet/monitoring.json` (fill with real values before mainnet). Post-incident review required for SEV1/SEV2.
