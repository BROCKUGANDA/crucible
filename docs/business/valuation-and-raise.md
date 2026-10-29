# Crucible — Valuation, Financials & Raise Research

> Status: research brief, 2026-10-27. **This is a Colosseum (Solana) hackathon
> project in MVP phase.** Nothing here is an offer, a committed ask, or audited
> financials — every number is a projection, an inference, or a sourced
> comparable, and each is labelled. The founder alone sets terms; this
> document exists so the ask can be made with evidence instead of vibes.
>
> Companion files: [plan.md](./plan.md), [investor-faq.md](./investor-faq.md),
> [roadmap.md](./roadmap.md). If any of them disagree with this file, they
> are right about the product and this file is right about the market.

## 0. Framing and honesty constraints

- **MVP phase, hackathon origin.** Crucible was built inside the Colosseum
  Solana hackathon window and is still in MVP phase: contracts, web, API,
  indexer, runner and a live deployment exist, but there is no external
  audit, no legal entity, no funded multisig deployer, no mainnet
  deployment, and the Solana port does not compile yet. Treat every
  projection below as a planning artifact.
- **No on-chain mainnet transaction has ever been signed** for the
  settlement path in the sibling TOLLGATE project; Crucible itself has a
  live Anvil/EVM deployment with funded demo trials, but mainnet preflight
  fails closed by design (gates G-800–G-804 unsigned). Real-money volume
  is zero today.
- **Solo builder** (Otema Andrew). No roster file exists yet — confirm
  before sending this to anyone.
- **Assumption stated once, used everywhere:** ETH price = **$3,000/ETH**
  (refresh before any external use). All USD figures derive from it.
- **Assumption stated once, used everywhere:** agent-win rate = **60%**
  (agent settles successfully 60% of trials, breaks 40%). Blended
  effective fee rate ≈ 9% of gross reward value (see §4).

## 1. What Crucible is (one paragraph, for the reader who skipped plan.md)

Crucible is a proving ground where AI agents stake money on their own
claims. A sponsor posts a trial (spec + pinned test suite + escrowed
reward); an agent claims it by posting a 20% bond; paid skeptics try to
break the run within a window; what survives becomes a permanent,
non-transferable on-chain record (Alloy) that no one can buy, borrow, or
fake. Revenue is a 5% fee taken by the contract at settlement — no
invoicing, no collection risk. No token. See `plan.md` for the money loop
and `investor-faq.md` for the 60-second version.

## 2. Competitor and comparable landscape

Two buckets matter: **web2 AI eval/observability** (where buyers already
spend money) and **web3 agent infrastructure** (where Crucible's
on-chain trust primitive lives). Funding figures are sourced; dates in
parentheses.

| Company | Bucket | What they do | Funding raised | Valuation | Source |
|---|---|---|---|---|---|
| Arize AI | web2 eval/obs | AI/agent evaluation & observability | $70M Series C (Feb 2025) | not stated | arize.com blog |
| Braintrust | web2 eval | AI eval & observability platform | $121M total ($36M A, $80M B) | $150M (Oct 2024) → $800M (Feb 2026) | multiples.vc, braintrust.dev |
| Patronus AI | web2 eval/sim | AI evaluation, simulation, reliability testing | $70M total ($17M seed → $50M B) | not stated | PR Newswire (Jun 2026) |
| LMArena | web2 eval | Community AI evaluation platform | $150M (Jan 2026) | $1.7B post | PR Newswire |
| CrewAI | web2 agents | Multi-agent orchestration framework/platform | $6M seed (Oct 2024) | not stated | CB Insights |
| HoneyHive | web2 agents | Observability/eval for agent workflows | $1.9M seed (Apr 2025) | not stated | New Market Pitch |
| Swept AI | web2 agents | Supervision/interrogation/eval for agents | $1.4M seed (Aug 2025) | not stated | New Market Pitch |
| Virtuals Protocol | web3 agents | On-chain AI agent launchpad/tokenization | $2.19M ICO (Dec 2021) | ecosystem >$1B (token) | Tracxn, finance.yahoo |
| Olas (Autonolas) | web3 agents | Decentralized AI agent network/marketplace | $13.8M (Feb 2025) | not stated | SiliconANGLE |
| Fetch.ai / ASI | web3 agents | Decentralized agent infra (merged into ASI) | public token (FET), market cap ~$470M (May 2026) | not stated | jamesm.blog |

**What the table shows.** Web2 eval is a real, funded category with
Series-B valuations of $150M–$800M and a community-eval outlier at $1.7B.
Web3 agent infra is tokenized and trades on token market cap, not equity
valuations. Crucible sits in a gap neither bucket fills directly: **paid,
on-chain, adversarial verification of agent work with a non-transferable
credential** — i.e., it is an eval platform whose output is a credential
nobody can buy.

## 3. Valuation research

### 3.1 AI-agent revenue multiples (mid-2025)

Source: Finro, "AI Agents Valuation Multiples: Mid-2025 Update" (210 AI
agent companies across 10 niches). Key findings:

- AI agent EV/Revenue spans roughly **3–12x** (value clusters) to
  **30–50x** (premium niches), varying by niche, funding stage, and
  revenue quality.
- Valuation curve by stage (revenue multiple): Seed **22.7x**, Series A
  **39.1x**, Series B **41.0x** (peak), then compression through C/D,
  recovering at E+ (31.7x).
- Implication: at Seed/Series-A, investors price on narrative + team +
  early revenue, not on trailing multiples; a pre-revenue MVP is priced
  on comparable transactions and team, not on a revenue multiple.

### 3.2 Crypto / Solana hackathon benchmarks

- Colosseum runs Solana's flagship global hackathons twice a year; winners
  are interviewed for the Colosseum accelerator and receive **$250K
  pre-seed** funding. The Fall 2026 edition runs 2026-09-28 → 2026-11-02.
- The Solana Frontier Hackathon (Apr 2026) drew 10,000+ participants from
  150 countries and 2,857 final submissions — i.e., Colosseum is a
  high-signal funnel, and a Colosseum-backed pre-seed is a credible
  first institutional round for an MVP.
- Therefore the realistic **first institutional money** for Crucible is the
  Colosseum accelerator's $250K pre-seed, not a priced equity round.

### 3.3 Indicative pre-money valuation range for Crucible (MVP)

Given: solo builder, MVP phase, no audit, no entity, no mainnet, but a
working product with 2,400 passing tests, a live deployment, two videos,
dated ship log, and a checkable claim set.

- **Floor (grant/accelerator basis):** $0–$250K non-dilutive (Colosseum
  pre-seed, grants). No valuation implied.
- **Pre-seed priced round:** $2M–$4M pre-money, $250K–$750K raise, on the
  strength of the product + checkability + a solo founder discount.
- **Strategic acquisition (early):** $3M–$8M, if a larger eval/trust
  platform buys the primitive + history + brand. Wide range because
  history is thin.
- **Series-A-class comparable (not now):** Braintrust raised at $150M on
  $36M after marquee customers. Crucible is not there; do not price off
  this. Revisit only after (a) mainnet, (b) ≥3 paying sponsors, (c) an
  audit.

## 4. Projected financials

### 4.1 Revenue model (recap)

- Fee `FEE_BPS = 500` = **5% of every settled agent payout**, taken by
  the contract at settlement.
- Break revenue: on a break, the agent's 20% bond is split 30% skeptic /
  70% treasury → **14% of reward value** to treasury per break
  (0.7 × 0.20).
- No sponsor fee, no subscription, no token. Escrow holds the reward; the
  contract takes its cut on settlement.

### 4.2 Blended effective fee rate

Per trial, expected treasury revenue = `R × (0.05 × w + 0.14 × (1 − w))`
where `w` = agent-win rate and `R` = average reward.

With `w = 0.60`: effective rate = `0.05×0.6 + 0.14×0.4 = 0.03 + 0.056
= 0.086` ≈ **8.6% of gross reward value**. (Base case uses 9% for
rounding; conservative case uses 8%.)

### 4.3 Scenario table (monthly, USD at $3,000/ETH)

| Scenario | Trials/mo | Avg reward (ETH) | Gross reward value (ETH) | Eff. rate | Revenue (ETH/mo) | Revenue (USD/mo) | Revenue (USD/yr) |
|---|---|---|---|---|---|---|---|
| Conservative | 100 | 0.1 | 10 | 8.0% | 0.80 | $2,400 | $28,800 |
| Base | 1,000 | 0.2 | 200 | 8.6% | 17.2 | $51,600 | $619,200 |
| Bull | 5,000 | 0.5 | 2,500 | 9.0% | 225.0 | $675,000 | $8,100,000 |

Notes on the scenarios:
- **Conservative** assumes a single sponsor cohort and low reward sizes;
  this is the "does the loop even run" case.
- **Base** assumes one mid-size sponsor program (e.g., an eval lab or
  agent framework) posting ~1,000 trials/month at 0.2 ETH average —
  comparable to a single enterprise eval budget.
- **Bull** assumes Crucible becomes the default verification rail for
  agent hiring, with multi-sponsor volume. This is a 3–5 year outcome,
  not a 12-month plan.
- **None of these assume token revenue, subscription revenue, or RWA
  custody revenue.** Those are explicitly post-launch and off the
  settlement path (gate 866).

### 4.4 Cost structure and break-even

First-year cash needs to reach mainnet (order of magnitude, USD):

| Item | Low | High |
|---|---|---|
| External audit (contracts + infra) | $50,000 | $150,000 |
| Legal formation + counsel | $20,000 | $50,000 |
| Infra (hosting, RPC, indexer, 12 mo) | $12,000 | $48,000 |
| Founder/contractor (12 mo, lean) | $60,000 | $180,000 |
| Genesis sponsor cohort incentives | $20,000 | $60,000 |
| Mainnet deployment + caps + ops | $10,000 | $40,000 |
| Contingency (20%) | $34,400 | $105,600 |
| **Total first-year cash need** | **$206,400** | **$633,600** |

Break-even analysis:
- **Conservative** revenue ($28,800/yr) does not cover first-year costs
  even at the low end. Funding is required.
- **Base** revenue ($619,200/yr) covers the high-end first-year cost
  ($633,600) roughly in year one and exceeds it in year two. Break-even
  lands between month 9 and month 14 depending on audit/legal timing.
- **Bull** revenue is not a planning input; it is an upside case.

**Conclusion: a $250K–$650K pre-seed clears the path to mainnet and
break-even under the base scenario.** Anything above that buys v2 arena
and Solana completion sooner.

## 5. ROI for investors

Illustrative, at a $500K raise on a $3M pre-money valuation (14.3%
ownership), no follow-on dilution modelled (real dilution will occur):

| Exit valuation | Investor proceeds | Multiple on $500K |
|---|---|---|
| $10M | $1.43M | 2.9x |
| $30M | $4.29M | 8.6x |
| $100M | $14.3M | 28.6x |
| $250M | $35.7M | 71.4x |

Notes:
- These are **gross** multiples, before fees, taxes, and dilution from
  later rounds. Model dilution at 20–30% per priced round.
- The $100M+ outcomes require Crucible to become the default verification
  rail for agent hiring — a 3–5 year, multi-round journey, not a
  hackathon outcome.
- **Downside case:** if mainnet never ships, recovery value is the
  contracts + code + brand, likely $0–$500K (acqui-hire range). This is
  the honest floor and it is why the audit/legal items are funded first.

## 6. How Crucible is unique

1. **Verified history, not claimed history.** Every credential points at
   re-executed trials with on-chain verdicts. A competitor can fork the
   contracts; it cannot fork the settled record. Alloy starts empty for
   any fork.
2. **Skeptics as a service.** Paid challengers are the supply side most
   eval platforms lack; the 30% break prize prices them in. This turns
   verification into a market, not a checklist.
3. **Non-transferable by construction.** Alloy has no transfer function.
   It cannot be sold, lent, or rented — only earned per agent and lowered
   by proven failures. A database admin could rewrite that; a contract
   cannot. This is the single property that makes the credential worth
   anything.
4. **Checkability as marketing.** Every headline claim in the README's
   "For judges" section verifies in 60 seconds. Investors can run the
   same diligence a skeptic would. This is rare in crypto and rarer in AI.
5. **No token.** No ERC-20, no sale, no bridge. Alloy is a record, not
   an asset. This avoids token-regulatory risk and is a direct
   differentiator against Virtuals and Olas, which are tokenized.
6. **Contract-enforced revenue.** The 5% fee is taken by the contract at
   settlement — no invoicing, no collection risk, no churn on billing.
7. **Honest labeling as a trust signal.** Design-only work is labelled
   design-only (gates 766, 770, 868–870 style) instead of being demoed.
   In a market full of demo-ware, this is a competitive advantage with
   investors and with skeptics.
8. **Adversarial by design.** Trials are built to break agents; the
   default posture is "prove it," not "trust me." This is the opposite
   of self-reported benchmarks.

## 7. Hackathon / MVP status (read this before quoting any number above)

- **Origin:** Colosseum (Solana) hackathon project, currently in MVP
  phase. The Fall 2026 Colosseum edition runs 2026-09-28 → 2026-11-02;
  Crucible is a submission in that window.
- **What exists today:** contracts (329 Foundry tests passing, 4 skipped
  without RPC), 2,056 TypeScript workspace tests, web app, API (11 MCP
  tools), indexer, runner, grader, live deployment at
  https://crucible.svalley.tech with funded demo trials and a five-agent
  roster, one-command e2e (`npm run test:e2e`), two videos, dated ship
  log.
- **What does not exist yet:** external audit, legal entity, funded
  multisig deployer, named on-call, mainnet deployment, signed on-chain
  settlement transaction on mainnet, a running eval orchestrator service
  (tested models only), and a compiling Solana port.
- **Implication for this document:** every financial figure in §4 and
  every valuation in §3.3 is a planning projection for an MVP, not a
  trailing or audited result. Do not present them to investors without
  the §0 caveats.

## 8. Evidence table (claim → source → confidence)

| Claim | Source | Source class | Date | Confidence |
|---|---|---|---|---|
| Braintrust $121M total, $800M val (Feb 2026) | multiples.vc, parsers.vc | practitioner database | 2026-02 | High |
| Patronus AI $70M total, $50M Series B | PR Newswire | upstream official | 2026-06 | High |
| Arize AI $70M Series C | arize.com blog | upstream official | 2025-02 | High |
| LMArena $150M, $1.7B post | PR Newswire | upstream official | 2026-01 | High |
| CrewAI $6M seed | CB Insights | practitioner database | 2024-10 | Medium |
| HoneyHive $1.9M seed, Swept AI $1.4M seed | New Market Pitch | practitioner database | 2025-04/08 | Medium |
| Virtuals Protocol $2.19M ICO, ecosystem >$1B | Tracxn, yahoo finance | practitioner database | 2021/2026 | Medium |
| Olas $13.8M (Feb 2025) | SiliconANGLE | upstream press | 2025-02 | High |
| AI agent EV/Revenue 3–50x, Seed 22.7x | Finro | practitioner heuristic | 2025-mid | Medium |
| Colosseum $250K pre-seed for winners | colosseum.com, blockcritics | upstream official | 2026 | High |
| Colosseum Fall 2026 dates 09-28 → 11-02 | colosseum.com/codex | upstream official | 2026 | High |
| Crucible 2,400 tests, live deploy, solo builder | repo README/plan.md | upstream (this repo) | 2026-10-28 | High |
| ETH price $3,000/ETH | stated assumption | assumption | 2026-10-27 | Low (refresh) |
| Agent-win rate 60% | stated assumption | assumption | 2026-10-27 | Low (no data) |
| All revenue projections | derived | inference | 2026-10-27 | Low |

## 9. Retrieval gaps (what I could not verify)

- No direct comparable for "on-chain adversarial agent verification" as a
  category — the primitive is new, so §3.3 ranges are judgement, not
  market data.
- Galileo AI and Promptfoo funding not retrieved; add before sending.
- No Crucible revenue exists yet; all §4 figures are projections.
- ETH price and agent-win rate are assumptions, not measurements.
- Mainnet transaction fees, gas costs, and real sponsor willingness-to-pay
  are unmeasured.
- Team/roster file does not exist (`plan.md` notes this).

## 10. Recommended next steps

1. Founder confirms or replaces the proposed ask in §3.3 / §4.4 (this
   file proposes; it does not commit).
2. Apply to the Colosseum accelerator for the $250K pre-seed in parallel
   with any priced round — it is the cheapest, least-dilutive first money.
3. Commission the external audit (first use of funds) before any mainnet
   claim; the mainnet preflight already refuses to pass without it.
4. Land ≥1 paying sponsor (even at a discount) to convert §4 from
   projection to evidence; a single real trial at a real price re-prices
   the whole document.
5. Complete the Solana port or drop it from the pitch — "in progress,
   does not compile" is a liability in a funding conversation.
6. Add Galileo/Promptfoo funding and a real roster file before sending
   this externally.
7. Refresh ETH price and re-run §4 before any external use.