# Forge Watch — independent runtime monitoring and evidence integrity

Status: proposed integrated subsystem. packages/agent-security and packages/forge-runner contain candidate foundations; verify exact branch/tests before reuse. Not proof that end-to-end monitoring is active.

## Purpose and claim boundary
Observe actual agent actions and preserve independent evidence. Detect suspicious behaviour, policy violations, containment failures and evidence gaps. Do not claim to prove alignment, safety, honesty or absence of deception. No alert is not proof of safety. Do not rely on chain-of-thought or self-report. Observe tools, processes, files, network/egress, credentials, delegation, retries, provider calls, context compaction and sandbox lifecycle. Agent cannot control monitor, capture, scheduler, monitor context or evidence store.

## Layers
L0 deterministic high-recall runner-owned event capture; L1 independent trajectory reviewer; L2 isolated read-only/redacted investigation; L3 optional external telemetry correlation with provenance/coverage; human triage, review, containment and closure. Reviewer cannot modify run/evidence.

## Evidence and threat model
Protect sponsor secrets, hidden tests, credentials and tenant data. Use per-run namespaces, scoped/revocable credentials, encryption, redaction, least privilege and no shared writable workspaces. Events include run/tenant/actor, sequence, type, source, timestamp, schema version, digest, redaction, provenance and hash linkage. Durable records in Postgres only after persistence ADR/migration; large encrypted artifacts in object storage; outbox before queue.

## Response boundary
Off-chain actions may stop further agent actions, revoke run-scoped credentials, isolate sandbox and preserve evidence. Audit every action. Never automatically slash bonds, change Argus verdicts, alter Alloy, rewrite settlement or freeze withdrawals. Contracts have no emergency pause or privileged settler. Off-chain kill switch blocks new runs only.

## Adversarial validation
Test sandbox escape, monitor shutdown/tampering, synthetic secret exfiltration, hidden-source recovery via errors, prompt injection in sponsor files/tool output, grader/test tampering, shared-repo covert channels, unapproved delegation, egress/DNS, deliberate underperformance, monitor-aware evasion, compaction omissions, serialization mismatch, unmonitored child runs, queue outage and investigator privilege escalation. Include benign controls and telemetry-loss states.

## Metrics and UX
Measure recall, precision, false positives, detection/containment latency, telemetry completeness, coverage/failure, evasion success, investigator agreement, queue delay and unknown gaps. Gaps remain unknown, never clean. UI: Live Watchtower, Incident Forge, Adversarial Bench, Evidence Foundry and sponsor monitoring profile in Forge Brief. Never expose hidden tests/secrets across tenants.

## API/failure behaviour
Versioned schemas and idempotency keys. Bounded exponential backoff with jitter for transient failures. Dead-letter poison messages with alert. Preserve durable evidence if review unavailable. States: pending/running/completed/failed/degraded/coverage-unknown. Monitor outage is never pass. Stop if agent controls capture, isolation is unproven, secrets leak, evidence mutable, or actions alter on-chain economics. Financial consequences need ADR, simulation and contract review.
