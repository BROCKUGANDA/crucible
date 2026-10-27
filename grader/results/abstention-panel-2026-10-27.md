# Abstention panel — live leaderboard

Sorted by the failure this exam is about: confident guessing first, then false abstention, then
Brier. `n=30` means the model was asked only the probes whose gold is VOID; the 10 controls are
reported separately because abstaining on those is the opposite failure. Disqualification by
p95 is shown next to the score; it does not erase the measurement.

| Rank | Model | Confident guesses | False abstention | Unanswerable abstention | Brier | Accuracy | p95 | Gate |
|---:|---|---|---|---|---:|---:|---:|---|
1 | `cohere-command-a-plus-05-2026` | 0/30 0.0% (95% CI 0.0%–11.4%) | 0/10 0.0% (95% CI 0.0%–27.8%) | 30/30 100.0% (95% CI 88.6%–100.0%) | 0.008 | 100.0% | 2970ms | survived |
2 | `hetzner-qwen3.8-27b` | 0/30 0.0% (95% CI 0.0%–11.4%) | 1/10 10.0% (95% CI 1.8%–40.4%) | 30/30 100.0% (95% CI 88.6%–100.0%) | 0.025 | 97.5% | 42804ms | disqualified: p95 latency 42804ms > 20000ms |
3 | `ollama-gemma4-31b-cloud` | 0/30 0.0% (95% CI 0.0%–11.4%) | 10/10 100.0% (95% CI 72.2%–100.0%) | 30/30 100.0% (95% CI 88.6%–100.0%) | 0.250 | 75.0% | 1617ms | survived |

## Provenance

| Model | Seed | Draw hash | Suite epoch | Corpus epoch | Digest |
|---|---|---|---|---|---|
`cohere-command-a-plus-05-2026` | `panel-2026-10-27` | `3e70416796c8522c…` | `2c294a89366ac000…` | `62ec8494244ad78a…` | `0x47104b02b0e895…` |
`hetzner-qwen3.8-27b` | `panel-2026-10-27` | `3e70416796c8522c…` | `2c294a89366ac000…` | `62ec8494244ad78a…` | `0xcaddab99baefae…` |
`ollama-gemma4-31b-cloud` | `panel-2026-10-27` | `3e70416796c8522c…` | `2c294a89366ac000…` | `62ec8494244ad78a…` | `0x97bf6f65a50992…` |
