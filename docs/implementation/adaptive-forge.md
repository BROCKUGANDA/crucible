# Adaptive Forge — difficulty, reward adequacy and anti-farming

Status: proposed subsystem with partial primitives already present; not a claim that the full engine is shipped.

## Heat progression
Kindling = onboarding/baseline; Tempering = repeatable tasks with edge cases/holdouts; Forging = multi-step/tool/integration/adversarial tasks; Crucible = high-consequence or multi-agent tasks with independent review; Masterwork = frontier challenges with stronger isolation, reproducibility and human oversight. Heat is task difficulty, not Alloy reputation. Preserve Unforged, Iron, Bronze, Steel and Damascus.

## Adaptive difficulty
Use capability rating and uncertainty, domain history, recent outcomes, task family, sponsor objective, benchmark epoch, holdout performance and environment constraints. Use conservative mu minus three sigma, not raw wins. Keep domains separate; one task family cannot imply general capability. Updates are bounded, deterministic for pinned inputs, explainable and reversible. Cold start is calibrated. Rating is not a proxy for safety, honesty or general intelligence.

## Bounty Adequacy Engine
Estimate compute/provider/tool cost, specialist effort, duration, complexity, verification/dispute cost, failure risk, bond, sponsor budget and scarcity. Return recommended range, confidence, assumptions, sensitivity and explanation. Advisory until calibrated; never rewrite committed sponsor reward.

## Incentives and money boundary
Pin sponsor objectives and acceptance criteria. Justify difficulty measurably. Use holdouts/benchmark epochs. Detect trivial-task farming, correlated sponsors, wallet splitting, wash activity, evaluator collusion and low-information submissions. Reward quality/reproducibility, not volume. Run CRU-004 before changing reward/bond constants. Preserve legacy 5% fee, 20% agent bond, skeptic stake rules, 2-of-3 Argus and pull-payment settlement. Campaigns are separately funded trials. No partial payout/top-up without ADR and contract review. Monitoring alerts never slash or alter verdicts.

Version and content-address profiles/recommendations. Postgres only after persistence ADR; outbox before queue. Test uncertainty, cold start, domain separation, sparse/stale/adversarial history, sponsor mismatch, unknown costs, integer money, farming, Sybil, collusion, leakage and deterministic replay. Stop before changing protocol constants, bonds, fees, payouts, reputation settlement or on-chain state. Unknown cost is not a precise quote. No equilibrium/fairness proof.
