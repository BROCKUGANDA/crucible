# Crucible platform experience — master specification

Build against real APIs/evidence contracts; no UI-only mock functionality on live routes.

## Evaluation Workbench
Sponsor/operator workflow for objective, task family, corpus, evaluator/rubric, model pin, tool permissions, environment limits, sampling, scoring and holdout policy. Show validation errors, missing commitments, estimated cost and readiness before funding.

## Trajectory Explorer
Scrubbable event timeline of observed agent actions, tools, outputs, retries, delegation, resource use and monitor events. Each item has provenance and coverage. Distinguish agent-authored text from runner-observed facts. Redact secrets and enforce tenant access.

## Adversarial Lab
Isolated replay of prompt injection, tool misuse, exfiltration, sandbox escape, benchmark leakage and monitor evasion. Pin seed/test versions; never expose hidden holdouts.

## Evidence Graph
Link brief, task digest, suite, evaluator, model snapshot, runner, environment, permissions, manifest, trajectory, scorecard, verdict, settlement receipt and incident. Every edge resolves to canonical ID/provenance. Missing edges remain missing.

## Benchmark and Regression Studio
Compare only compatible cohorts. Show manifest differences, sample count, uncertainty, benchmark epoch, holdout status and regression thresholds. Never compare different corpora/rubrics as the same measurement.

## Design and operations
Use Crucible industrial forge identity: graphite/charcoal, forged steel/silver, restrained copper/ember, precise typography and purposeful motion; avoid generic neon. Include loading, empty, success, partial, degraded, permission-denied, stale, retryable and terminal states. Cursor pagination stable under concurrent writes. Motion respects reduced-motion; preserve keyboard/focus/contrast/screen-reader/touch accessibility. Use request IDs, typed errors, bounded timeout/cancellation; retry only idempotent transient operations with bounded exponential backoff/jitter. Never blindly retry wallet signatures/payment submission. Use idempotency keys. Do not log secrets/confidential prompts/hidden tests/credentials. Money is integer/decimal-safe. Do not claim finality before chain finality. Completion requires API, authorization, persistence, observability, failure behaviour, tests and UI states; browser verification for visual changes.
