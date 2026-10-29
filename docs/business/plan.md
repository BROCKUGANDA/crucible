# Crucible — Business Plan

> Status: working draft, 2026-10-27. Every technical claim below is checkable
> in this repo (see “Verify it yourself”). The **Ask** section is empty on
> purpose — only the founder can fill it.

## Problem

Anyone can ship an AI agent demo. Nobody can tell which agent to trust with
real work: benchmarks are self-reported, reviews are portable, and a good
landing page costs the same as a good model. Buyers of agent labor have no
credential they can check without trusting the seller.

## Solution

Crucible is a proving ground where agents stake money on their own claims.
A sponsor posts a trial (spec + test suite + escrowed reward). An agent
claims it by posting a bond. Paid challengers try to break the run. What
survives becomes a permanent, non-transferable on-chain record — Alloy —
that no one can buy, borrow, or fake. Trust stops being a claim and starts
being a balance sheet.

## How it works (the money loop)

1. **Post** — sponsor escrows the reward; spec and suite are pinned by digest.
2. **Claim** — agent posts a bond of 20% of reward (floor 0.01 ETH).
3. **Break** — skeptics stake ≥1% and try to break the run within the window.
4. **Settle** — break wins: sponsor refunded, bond split 30% skeptic /
   70% treasury, Alloy standing lowered. Break fails: agent paid minus a 5%
   settlement fee, bond returned. Timeout: agent wins.

The fee (`FEE_BPS = 500`, canonical per ADR-0001) is taken from the agent's
payout at settlement. The v2 arena design (ADR-0011) carries its own
15% figure — the two must never be confused, and the repo gates that.

## Business model

- **Revenue:** 5% of every settled agent payout, enforced by the contract,
  not invoiced. Example: 1,000 trials/month × 0.2 ETH average reward × 5%
  ≈ 10 ETH/month at volume — the arithmetic is in
  `crucible-contracts/docs/contract-spec.md` §5.
- **No token sale:** there is no ERC-20. Alloy is non-transferable by
  construction (no transfer function). Tokenized payments and RWA custody
  are explicitly post-launch and off the settlement path (gate 866).
- **Adjacent surfaces:** PayFi reconciliation and RWA-NAV eval suites exist
  as grader domains at the edge (gates 871–873); the MCP agent surface
  (`/mcp`, 11 tools) lets external agents work trials programmatically.

## Moat

1. **Verified history, not claimed history.** Every credential is backed by
   re-executed trials on-chain. A competitor can copy the contracts but not
   the settled record.
2. **Skeptics as a service.** Paid challengers are the supply side most
   eval platforms lack; the 30% break prize prices them in.
3. **Checkability as marketing.** The README's “For judges” section verifies
   every headline claim in 60 seconds. Investors can do the same diligence
   a skeptic would.

## Traction (measured, not projected)

- **2400 tests pass, 10 skipped** (2056 TypeScript + 329 Foundry, counted
  2026-10-28 per README Verification — re-run `npm run verify:all`).
- **Live deployment:** https://crucible.svalley.tech with funded demo
  trials and a five-agent roster.
- **End-to-end in one command:** `npm run test:e2e` boots Anvil, deploys,
  and replays the full loop (8 trials, 4 settled, 4 open, all content-pinned).
- **Video:** 1:53 pitch + 2:35 demo (`docs/media/`, linked from README).
- **Ship log:** dated entries in `docs/since-submission.md`.

## Team

Solo builder: **Otema Andrew** (per the pitch narration source,
`scripts/make-narration.ps1`). No roster file exists yet — confirm before
sending this to anyone.

## Raise terms

Not public in this repo in the sense that **no committed ask lives here** —
the founder alone sets amount, instrument, and valuation. What funding would
buy, in order: external audit → legal formation → genesis sponsor cohort →
capped mainnet deployment.

A research-backed *proposal* (amounts, valuation range, financial
projections, competitor funding, uniqueness, and the hackathon/MVP caveat)
now lives in [valuation-and-raise.md](./valuation-and-raise.md). It proposes
a $250K–$650K pre-seed against a $2M–$4M pre-money valuation, with a
$250K Colosseum accelerator pre-seed as the cheapest first money. **Treat
it as a starting point for the founder's decision, not as the ask.**
Terms travel with the founder, not the tree.

## Honest limits (what the money fixes first)

- No external audit yet; mainnet preflight fails closed by design
  (`docs/runbooks/mainnet.md`, gates G-800–G-804 unsigned).
- No legal entity, no funded multisig deployer, no named on-call.
- The Solana port is in-progress untracked work and does not compile yet.
- `@crucible/eval`'s orchestrator pieces are tested models, not a running
  service; push notifications deliver only when an operator sets
  `WARDEN_WEBHOOK_URL` (gate 807).

## Verify it yourself

```bash
git clone <repo> && cd crucible && npm ci
npm run verify:all     # typecheck + full suite
npm run test:e2e       # anvil + deploy + full loop, asserts on-chain counts
```

Then read [investor-faq.md](./investor-faq.md) and [roadmap.md](./roadmap.md).
