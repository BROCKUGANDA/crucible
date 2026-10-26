# 0016 — The faucet sizes by risk; absence of evidence is not denial

Status: Accepted · 2026-10-26

## Context

A roadmap for the Sybil-risk scorer proposed wiring its decision layer into the faucet: the
funder checks risk before dispensing, and anything the scorer calls `deny` gets nothing.

The scorer is real — a Bayesian logistic model over Alloy tier, identity linkage, settled-trial
history and slashes (`apps/api/src/identity.ts`), published at `/identity/risk`. Its base rate is
0.10 for a wallet with no evidence, and `decide()` maps anything under 0.40 to `deny`.

That is correct for the surface it was written for and wrong for a faucet. A faucet exists to
fund the wallet that arrives with nothing; that wallet has no Crucible history, scores the base
rate, and would be denied on arrival. The first thing it would do — create the history that
scores it — becomes impossible. The gate would refuse precisely the population it serves.

The funder also dispenses on a different chain (Base Sepolia USDC) from the one the evidence
comes from (Crucible on Anvil), so a score is a statement about a wallet, not about a network.
That is coherent; the identity is the wallet.

## Decision

The funder reads the score and uses it to **size** an allocation, not to admit or exclude:

| Evidence | Factor | Why |
|---|---|---|
| a slash on record | 0 — refuse | The one fact that says no. Conduct, not absence. |
| `p ≥ 0.70` | 1.0 | Chain history supports the wallet. |
| `0.40 ≤ p < 0.70` | 0.5 | Partial history. |
| otherwise (including base rate) | 0.25 | A newcomer's first drip is smaller, not zero. |

The mapping lives in `apps/funder/src/risk.ts`, independent of `decide()`'s action strings: the
funder is a different payer, and inheriting a string written for another surface is how two
policies drift into disagreeing while both look intentional.

An unreachable identity service falls back to the 0.25 factor and records
`risk.available: false`; it is never reported as a clean score. The caps in `cap.ts` bound the
fallback, so an outage costs at most one small drip per wallet per day.

## Consequences

- The faucet's first step keeps working for a brand-new wallet, and a wallet with a slash is
  refused with the reason on the allocation record.
- The funder takes a dependency on the API for every allocation. On the VPS the API is not
  published to the host (`compose.vps.yaml` resets its ports), so `IDENTITY_API_URL` points at
  the public `/api` edge, or the funder moves onto the compose network with the key it already
  holds. Both are deployment choices; neither changes this policy.
- The score's coefficients remain hand-tuned. Phase 3 (`scripts/fit-identity.mjs`) fits a
  posterior from a labelled corpus and refuses to run without one; promoting fitted values into
  the scorer is a reviewed code change, not a deploy.
