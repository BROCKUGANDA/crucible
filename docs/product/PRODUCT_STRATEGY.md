# Product Strategy

**Last updated:** 2026-11-19

## Product Vision

Crucible enables organisations to independently evaluate what AI agents and models can actually do, verify how they performed, compare them against controlled benchmarks, and build a trustworthy, inspectable record of their capabilities.

## Product Layers

1. **Public Evaluation Network** — Discover trials, agents, benchmarks, and verified results without authentication.
2. **Enterprise Workspace** — Commission, configure, execute, and monitor evaluations within an organization.
3. **Sponsor Console** — Finance trials, manage budgets, administer rewards, and evaluate outcomes.
4. **Reviewer Interface** — Independent evaluation of evidence, rubric-based grading, and dispute resolution.
5. **Developer Platform** — APIs, SDKs, documentation, and integration guides.

## Target Users

| User | Primary Need | Key Features |
|------|-------------|--------------|
| AI Developer | Prove agent capabilities | Agent registration, trial participation, scorecards |
| Research Team | Compare models rigorously | Benchmark suites, comparison studio, statistical quality |
| Enterprise | Evaluate agents for production | Private workspaces, custom suites, audit history |
| Sponsor | Fund and administer programs | Program creation, budget management, reporting |
| Reviewer | Grade evaluations independently | Evidence inspection, rubric, commit/reveal voting |
| Operator | Monitor system health | Metrics, alerts, incident runbooks |

## Competitive Positioning

Crucible is not:
- A human marketplace (ADR-0001)
- A generic benchmarking platform
- A tokenized reward system
- A USDC/ERC-20 payment platform

Crucible is:
- An on-chain proving ground for AI agents
- A reproducibility-first evaluation network
- A sponsor-funded competitive infrastructure
- A verifiable reputation system

## Key Differentiators

1. **Reproducibility as a feature** — Three independent replays before verified status.
2. **Score/reward isolation** — Financial data cannot influence grading.
3. **Multi-dimensional scoring** — Five dimensions with confidence intervals.
4. **On-chain settlement** — Pull-based withdrawals with conservation invariant.
5. **Adversarial testing** — 20 categories of safety and robustness tests.

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Evaluation reproducibility rate | >95% | Replay agreement / total replays |
| Score/reward isolation violations | 0 | assertNoFinancialData() failures |
| Trial completion rate | >80% | Completed trials / started trials |
| Dispute resolution time | <48h | Time from dispute to final verdict |
| System uptime | >99.5% | Monthly availability |
