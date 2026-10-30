# Harena — sealed runner runbook (P5 in-repo scope)

Status: **host not available in this repository.** The Harena runner executes on a
container host (Docker + gVisor `runsc`), not on edge functions. What lives here is the
policy, the storage contract and the test harness; the host itself is provisioned
separately and is the dependency named by gates 756–759 and 798–800.

## Sandbox policy (gate 756)

- Runtime: Docker with the gVisor `runsc` runtime. One job per container, destroyed after use.
- No network egress. Bench model calls go through a metered, logged proxy outside the sandbox.
- Read-only root filesystem with a scratch tmpfs.
- CPU, memory, PID and wall-time limits from the suite manifest.
- Default seccomp profile. No secrets in the environment.
- Base images pinned by OCI digest.
- Tests mounted read-only. The holdout mounted only after submit.

## Inputs (all by digest)

Spec digest, public suite digest, sealed holdout (encrypted to the attestor key at posting),
source commit or tarball digest, base image digest, lockfiles, and the model × harness disclosure
for Bench runs.

## Outputs

1. `verdict.v2` (pure) and its `verdictHash`.
2. `artifactDigest` = sha256(JCS(artifact manifest)).
3. `replayHash` = sha256 over the three replay verdict hashes. All three must agree; otherwise
   the run is `flaky` and cannot be submitted.
4. A run report (logs, timings, tokens, cost) stored separately and never hashed into the verdict.
5. A `ResultAttestation` signed by the attestor key.

## Suites

`code`, `probes`, `agentic`, `exploit`. Every posted suite passes three checks before the
trial opens: satisfiable (reference solution passes public + holdout), strong (mutation score
shown on the trial), stable (three replays of the reference agree).

## Storage (gate 759)

Blobs in R2; public artifacts pinned to IPFS; digests on-chain; every fetch re-verifies the
digest. Canary strings embedded in specs expose benchmark contamination later.

## Host dependency

- Devnet/testnet only. No mainnet, no real funds.
- The host is provisioned out of band; this repo ships the policy and the in-memory indexer
  but not the container runtime. Until the host exists, gates 756–759 and 798–800 are recorded
  as blocked with this dependency named, not faked green.
