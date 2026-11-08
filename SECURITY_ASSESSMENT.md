# Crucible Security Assessment (CRU-BASE → REL-001)

**Date:** 2026-11-08 · **Branch:** develop · **Scope:** 500-pt blueprint + hardening prompt

## Summary
Code-level core (sandbox, SIWE, Argus) was sound; integration wiring had critical gaps. This cycle fixed the forged-cookie, sequence collision, outbox, Argus fetch, and entitlement trust holes. Remaining: PG persistence for orgs/entitlements is library-only (ADR-0023), no SBOM/signing yet, mainnet signoffs are placeholders.

## Confirmed fixes (evidence)
| # | Finding | File(s) | Test |
|---|---|---|---|
| F1 | `forge.ts` decoded session cookie without HMAC — forged cookie = any org member | `apps/api/src/forge.ts` → `sessionPrincipal()` | Typecheck passes; new test: forged cookie → 401 |
| F2 | `org-authz.ts` same flaw | `packages/agent-security/src/org-authz.ts` → fail-closed stub | — |
| F3 | `cookieOf` accepted bare `crucible_session` in prod (cookie tossing) | `apps/api/src/auth.ts` | Prod requires `__Host-` |
| F4 | Session never revoked (logout = clear cookie) | `auth.ts` revocation set | Logout → token rejected |
| F5 | Nonce store silently fell back to memory in prod | `nonce-store.ts` fail-closed | — |
| F6 | `POST /trials` orgId unchecked; `/transition` used unauthenticated header | `apps/api/src/app.ts` | isMemberOf check; header removed |
| F7 | Cross-tenant api-key revoke | `org-api-key.ts` scope guard | — |
| F8 | Runner+agent both emitted sequence 1 → first event lost; collector trusted producer seq | `forge-watch/collector.ts` claimNext, `runner.ts`/`agent.ts` placeholder 0 | Unit: two emitters → contiguous 1,2 |
| F9 | No transactional outbox; `listUndispatched` had no consumer | `pg-store.ts:appendWithOutbox` + `0003_runtime_and_rewards.sql` | — |
| F10 | L0 was `l0-scaffold` no-op | `forge-watch-workers.ts` real probes | — |
| F11 | Indexer never called `watch()` — `indexedTo=0` forever | `packages/indexer/src/server.ts` | — |
| F12 | Argus never called `fetchArtifact`; missing sig = break-wins fraud; fingerprint pass-only | `packages/argus/src/argus.ts` | — |
| F13 | `/engrams/evaluate` accepted any session's `verified:true` | `apps/api/src/engrams.ts` → keeper bearer only | — |
| F14 | `EngramLocker` took/returned no tokens (strand risk) | `EngramLocker.sol` real custody | forge contract tests |
| F15 | `stats.byRun` always empty; no hash chain | `collector.ts` coverage + SHA-256 chain | — |

## IP / server-side
Evaluator rules, hidden tests, and settlement logic stay server-side/contract-side. Browser bundles contain no secret-bearing evaluator logic (verified by grep for `NEXT_PUBLIC_*` secrets). Source maps not published in prod.

## Sandbox
`packages/forge-runner/src/sandbox.ts`: `--network=none --read-only --cap-drop=ALL --pids-limit=128 --memory=1g --user=1000:1000` ephemeral. Fail-closed. Prod service containers still run as root — remediation in backlog.

## Tenant isolation
`isMemberOf` now enforced on `/trials`, `/orgs/*`, `/forge/*` (via verified session). PG RLS exists in `0002_organisations.sql`; org store itself is still in-memory — migration to PG is the next major step (ADR-0023 0003-0011).

## Supply chain
Gitleaks + Trivy + audit-gate in CI. No SBOM/cosign yet — added to backlog; release is unsigned git tag today.

## Mainnet gate
`docs/mainnet/*.json` are placeholders (treasury `0x000…0`, timelock pending). No real-money launch until: Safe verified on-chain, withdrawal rehearsal, independent audit, `monitoring.json` real values. This cycle does NOT claim production readiness.

## Next steps
1. PG migration of org/entitlement stores + worker entrypoint for outbox dispatcher.
2. SBOM (CycloneDX) + cosign provenance; pin `node:22` by digest; `USER 1000` on prod images.
3. E2E spine test (cheat-sheet §18) in CI.
4. Fill `docs/mainnet/monitoring.json` with real on-call/dashboards; run audit.
