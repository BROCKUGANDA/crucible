# ADR-0025 — Forge Watch: Runtime Monitoring, Misalignment Detection and Incident Response

**Status:** Accepted (architecture) — implementation in progress per WFW-001..WFW-012  
**Date:** 2026-11-06  
**Branch:** `develop`

## Context

Crucible runs autonomous agents against bountied trials. The existing `packages/agent-security` package enforces a synchronous policy gate (tool allow-lists, RBAC, scope limits, audit log) and `packages/forge-runner` manages execution. Neither provides an independent, asynchronous detection and investigation pipeline over what the agent actually did during a run, nor incident response with run-level containment that is separate from settlement.

The external spec (Forge Watch master engineering specification) requires a provider-independent monitoring subsystem that:

- Collects canonical telemetry outside the agent's execution boundary.
- Runs fast probes (L0), an independent model reviewer (L1), investigative agents (L2) and cross-source correlation (L3).
- Supports severity-graded human incident response with run-level containment.
- Never touches on-chain financial outcomes (no slashing, no payout changes, no verdict changes).
- Persists to PostgreSQL + Redis/BullMQ + object storage (ADR-0023).

## Decision

Introduce **Forge Watch** as a new subsystem extending `packages/agent-security` and `packages/forge-runner`, not replacing them. No second permission engine, audit log, session manager, policy store, incident manager or kill-switch.

### Responsibilities

1. **Synchronous Policy Gate** (existing, in `AgentOrchestrator.invoke()`): mandatory permission boundary before privileged actions. Unchanged.
2. **Asynchronous Forge Watch** (new): independent detection and investigation pipeline. Reviews recorded activity, identifies suspicious patterns, reconstructs incidents, recommends or initiates permitted run-level containment. Does not grant permissions; a favourable monitor response cannot override the Policy Gate.

### Event contract (canonical envelope)

A versioned, strictly validated event schema with fields: `eventId`, `schemaVersion`, `timestamp`, `runId`, `trialId`, `agentId`, `tenantId`, `parentRunId`, `sequence`, `eventType`, `source`, `providerId`, `modelId`, `toolId`, `permission`, `authorizationDecision`, `environmentId`, `payloadDigest`, `policyDigest`, `contextDigest`, `correlationId`. Only applicable fields populated; missing data remains explicitly missing. Sequence numbers monotonic per run; gaps/malformed events are telemetry-integrity findings.

### Intervention authority

- Forge Watch containment is run-level only: stop new tool execution, revoke scoped credentials, quarantine container, preserve evidence, notify on-call, open incident record, prevent silent restart.
- A monitor flag must never directly slash a bond, withhold payment, reduce Alloy, change a trial verdict, modify an acceptance score, or reassign a task. A verified violation can become evidence for an applicable precommitted trial requirement via the existing challenge/adjudication process.
- No new on-chain pause, withdrawal block, or privileged settlement path.

### Privacy

Secret redaction before persistence/display, encryption for sensitive evidence, tenant-scoped access, sponsor-controlled retention, explicit access audit, data minimisation, redacted investigator interfaces. No raw API keys, private keys, seed phrases or unredacted secrets stored. Third-party model monitor integrations respect sponsor data-processing permissions.

### Failure semantics

- Monitoring gaps and failures are visible and actionable (coverage accounting).
- A tool path that bypasses the collector, an agent that can alter its monitor/telemetry, or a silently dropped critical event is a stop condition requiring report.

## Consequences

- Extends ADR-0023 infrastructure (PostgreSQL, Redis/BullMQ, R2) for monitoring events, findings, incidents, investigations.
- Adds L0/L1/L2/L3 job queues with bounded exponential backoff, jitter, retry budgets, dead-letter handling.
- Requires adversarial benchmark suite (WFW-009) with mutation-proof coverage.
- No change to smart-contract economics, ABI, or digest-pinned fixtures.

## Related

- `ADR-0001` — Agent proving ground (product identity)
- `ADR-0003` — Pull-based settlement
- `ADR-0006` — API holds no chain key
- `ADR-0008` — In-memory indexer (demo default)
- `ADR-0023` — Production infrastructure (PostgreSQL/Redis/BullMQ/R2)
- `packages/agent-security/README.md` — existing controls
- `HARDENING.md` — security findings register