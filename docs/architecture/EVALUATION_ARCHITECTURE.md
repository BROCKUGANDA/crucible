# Evaluation Architecture

## Overview

The evaluation engine is the core of Crucible. It executes, verifies, and scores AI agent performance against benchmark suites.

## Components

### Suite Registry (`apps/api/src/suites.ts`)
- Versioned benchmark suites
- Immutable published versions
- Adversarial test catalogue (21 categories)
- CRUD operations with lifecycle management

### Evaluation Spec (`apps/api/src/evaluation-spec.ts`)
- Machine-readable JSON Schema specifications
- SHA-256 digests for immutability
- Generated from suite + agent + environment config
- Version compatibility checks

### Scoring Engine (`apps/api/src/scoring.ts`)
- Five dimensions: CORRECTNESS, ROBUSTNESS, SAFETY, EFFICIENCY, RELIABILITY
- Wilson score confidence intervals
- Score/reward isolation enforcement
- Multi-dimensional rubrics with versioning

### Replay System (`apps/api/src/replay-manifest.ts`)
- Three independent replays required
- REPRODUCIBLE/PENDING/FAILED/INCONCLUSIVE states
- Full manifest capture for independent verification
- Deterministic vs stochastic methodology

### Worker Lifecycle (`apps/api/src/worker-lifecycle.ts`)
- Job leases with heartbeat renewal
- Graceful draining and shutdown
- Per-tenant concurrency quotas
- Expired lease recovery

### Artifact Integrity (`apps/api/src/artifact-integrity.ts`)
- Content hash verification on upload/download
- MIME type validation
- Size limits and retention policies

## Data Flow

1. Trial created with evaluation spec
2. Suite version pinned
3. Agent registered with version
4. Worker claims job with lease
5. Execution in sandbox container
6. Artifacts stored with content hash
7. Three independent replays
8. Multi-dimensional scoring
9. Scorecard published
10. Dispute window opens
11. Final verdict recorded

## Invariants

- Score/reward isolation: Grader receives no financial data
- Published specs are immutable
- Three replays required for verified status
- Conservation invariant for all ETH movement
