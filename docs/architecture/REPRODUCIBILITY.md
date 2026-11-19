# Reproducibility

**Last updated:** 2026-11-19

## Overview

Reproducibility is a first-class feature of Crucible, not a marketing claim. Every run captures a reproducibility manifest containing all inputs, configurations, and outputs required for independent verification. Three independent replays are required before a result achieves verified status.

## Reproducibility Manifest

Every run produces a manifest (`replay_manifests` table) containing:

| Field | Description |
|-------|-------------|
| trial_revision_hash | Hash of the trial revision |
| suite_version | Suite version identifier |
| input_hashes | SHA-256 digests of all input fixtures |
| agent_identifier | Agent identity |
| agent_build | Agent build/version |
| model_identifier | Model identifier |
| prompt_template_version | Prompt/template version |
| tool_versions | Tool version map |
| runtime_image_digest | Container image digest |
| execution_config | Runtime configuration |
| judge_version | Judge configuration version |
| dependency_versions | Dependency version map |
| randomness_seed | Randomness seed (deterministic mode) |
| randomness_provenance | VRF proof (production mode) |
| environment_fingerprint | Environment hash |
| artifact_hashes | SHA-256 digests of output artifacts |
| start_timestamp | Execution start time |
| finish_timestamp | Execution end time |
| worker_identity | Worker that executed the run |
| execution_trace_refs | References to execution traces |
| manifest_digest | SHA-256 of the canonical manifest |

## Three-Replay System

### Replay Records

Each manifest has up to three independent replay records (`replay_records` table):

| Field | Description |
|-------|-------------|
| replay_number | 1, 2, or 3 |
| worker_identity | Independent worker |
| output_hash | SHA-256 of the output |
| status | PENDING, RUNNING, COMPLETED, FAILED, SKIPPED |
| error_detail | Error information if failed |

### Agreement Check

For deterministic evaluations:
- All three replays must produce identical output hashes
- Agreement = `output_hash_1 == output_hash_2 == output_hash_3`

For stochastic evaluations:
- Pre-registered statistical acceptance criteria apply
- Tolerances and confidence measures define agreement
- Token-identical output is not required

## Reproducibility States

| State | Description |
|-------|-------------|
| PENDING | Replays not yet executed |
| REPRODUCIBLE | Three independent replays agree |
| FAILED | Replays disagree or failed |
| INCONCLUSIVE | Insufficient evidence for agreement |
| REVIEW_REQUIRED | Manual review needed |

## Deterministic vs Stochastic

| Aspect | Deterministic | Stochastic |
|--------|---------------|------------|
| Output comparison | Exact hash match | Statistical acceptance |
| Replays required | 3 | 3 |
| Agreement criterion | Token-identical | Within tolerance |
| Methodology | `evaluation_protocol = 'deterministic'` | `evaluation_protocol = 'stochastic'` |

## Replay Coordination

The Argus package coordinates three independent replays:

1. **Replay 1:** Original execution worker
2. **Replay 2:** Independent worker, same manifest
3. **Replay 3:** Independent worker, same manifest

Each replay:
- Uses the same manifest (inputs, configuration, environment)
- Runs on an independent worker
- Produces an independent output hash
- Records its execution trace

## Verification Process

1. **Manifest creation:** Post-execution, capture all inputs and outputs
2. **Replay scheduling:** Argus schedules three independent replays
3. **Replay execution:** Each replay runs independently
4. **Agreement check:** Compare output hashes or statistical criteria
5. **Status update:** Set `replay_status` based on agreement
6. **Score verification:** Update aggregate score status to VERIFIED if reproducible

## Evidence Integrity

- All artifacts are content-addressed (SHA-256)
- Manifest digest ensures manifest integrity
- Input hashes ensure input integrity
- Output hashes ensure output integrity
- Execution traces provide full audit trail

## Limitations

- Stochastic evaluations cannot guarantee token-identical output
- Model-based judging introduces additional variance
- Environment differences may affect reproducibility
- Network-dependent tasks may have timing variations
