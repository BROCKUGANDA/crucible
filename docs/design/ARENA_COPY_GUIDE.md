# Arena Copy Guide

**Status:** current — binding for reader-facing copy  
**Owner:** Product + Creative Director  
**Systems:** `apps/web/src/` pages/components, `docs/`, `llms*.txt`, OG images

---

## 0. Voice

Crucible speaks like an institution that has run the contest for centuries:
spare, declarative, occasionally Latin — and always plain when money or risk
is involved. Two registers:

1. **Inscriptional** — Cinzel, for display: act titles, hero, seals, numbers.
2. **Interface** — plain modern prose: sentences a first-time visitor can read
   without decoding. Every thematic term travels with its plain meaning
   ("The Codex · Docs", "The Watch · Status").

## 1. The positioning, verbatim

> **CRUCIBLE — THE ARENA OF PROOF.**
> THE ARENA DOES NOT REWARD PROMISES.
> PROOF IS EARNED. NEVER DECLARED.

Used on the hero. Do not paraphrase for the sake of variety.

## 2. Banned words

| Never | Because | Instead |
|---|---|---|
| "revolutionary", "game-changing", "next-generation" | marketing superlatives, unverifiable | describe the mechanism |
| "AI-powered analytics", "unlock the power of AI" | empty AI jargon | "Evaluate what an agent can actually do" |
| "trustless" | vague claim | "explain the actual mechanism" (commit-reveal, pinned suite, 2-of-3) |
| "decentralized" | unverifiable | "state which components are on-chain — escrow, verdicts, credential — and which are not" |
| "enterprise-grade" | unverifiable | name the control (rate limit, SIWE, CSRF, pull ledger) |
| "free" for anything Crucible pays for | settlement is never free; the protocol pays fee from the agent's payout | "costless" only for zero-cost UI paths; always name who pays |
| "audited" | nothing here is audited | "unaudited" + what that means for the deployment |
| "refresh", "guaranteed" | no settlement is guaranteed before it lands | "expected", "the chain decides" |
| "soulbound" | jargon | "non-transferable" |
| "Lost slag" (player-facing) | builder slang | "No such trial" / "No such case" |

## 3. Required precision

| Topic | Binding language |
|---|---|
| Fee | `5% · 500 bps` — deducted from the agent's payout at settlement (FEE_BPS = 500) |
| Challenter economics | "a successful break pays 30% of the bond; the rest goes to the treasury; the sponsor is refunded" |
| Settlement | "settlement never pushes ETH; the recipient calls `withdraw()`" |
| Credential | "Alloy is non-transferable. Trust should be too." |
| Deadline | "at least 1 hour out" / "the fire is out — the trial is reclaimable" |
| Hung panel | "three days after a dispute opens, the agent's pass stands" |
| Test ETH | "test ETH, worth nothing" — never "ETH" in isolation on the public demo |
| v2 arena law | mention only as "the second law" with the 1500 bps arena fee labeled as the arena's own — never as this escrow's fee |
| Demo status | "this deployment is a demonstration on a local development chain; the contracts are unaudited" |

## 4. Terminology registry

One word per mechanism, everywhere:

| Term | Means |
|---|---|
| Trial | the job: spec, tests, reward, deadline |
| Bond | the agent's stake to claim; forfeited on a broken claim |
| Break | a challenge; someone stakes to argue a reported outcome is wrong |
| Skeptic | the challenger |
| Argus | the 2-of-3 committee |
| Alloy | the non-transferable standing; tiers I–V |
| Quench | to settle; the verdict lands and the trial pays or doesn't |
| Hall | the public board of who was paid, who was caught, and what each was paid |
| The Forge | agent registration and preparation |
| The Tribunal | adjudication: breaks, verdicts, the committee's clock |
| The Arena | the board of trials; also the v2 law's surface |
| The Codex | documentation: the rules |
| The Strategium | the game-theory layer: economics, payoffs, exposure |
| The Warden | operator surfaces |

## 5. Status language

| State | Words |
|---|---|
| `open` | "Open — awaiting an agent" |
| `assigned` | "Run in progress" |
| `judging` | "Review — challenges open" |
| `challenged` | "Challenged" |
| `settled` | "Settled" |
| `paid` | "Verified" |
| `slashed` | "Broken" |
| `reclaimed` | "Reclaimed" |

## 6. Empty and error states

Every empty state names **what it means** and **what to do next** — never
"no data" alone. Every error states: what happened, whether data was saved,
what to do next, whether retry is safe.

- Empty arena: "Cold forge. No trials burning yet — a sponsor lights one."
- Filtered empty: "No {N} trials. The trials exist — they are simply elsewhere." [show me all]
- Case not found: "No such case." [Back to the queue]
- RPC down: "The chain would not answer." [Try again]

## 7. Activity feed copy

Never "10 seconds ago" fiction. Each event renders: id, type, timestamp (chain
or server clock, labeled), source, entity ref, and verification status.
Seeded demonstration data is labeled `Seed` in the event's source field.

## 8. Reader's three questions (the test for any new screen)

Before shipping copy on a new screen, write the three answers:

1. What is this?
2. What does it cost me (money, bond, stake, attention)?
3. What happens if I walk away?

If any answer takes more than one plain sentence, the copy is not done.
