# Pasted-ledger reconciliation (G-817–877)

Date: 2026-10-27. A pasted roadmap claimed gates G-817–877 with
“next free gate = 878”. Every id in that range was already taken, and its
`FEE_BPS=1500` contradicts the live `FEE_BPS=500`. This file records what was
done with each pasted section instead of renumbering by hand and hoping.

## Rule applied

- Pasted substance already in the register (same topic, honest caveats) →
  **absorbed**, no new gate.
- Pasted substance with no register coverage → new gate at **881+**,
  marked design-only where unbuilt, shipped where verified.
- Pasted claims contradicting the tree → **refused**, with the reason.
- The conversation history below the ledger (Bun monorepo, Solana-first
  sessions, gates 439–816 in other numberings) is **context, not a work
  order**. The repo absorbed 678–730 where it matched; repo 731–816 are this
  project's own evolution (EVM-first) and are not reconciled here.

## Section map

| Pasted | Topic | Verdict |
|---|---|---|
| A 817–821 | Session lifecycle & teardown | **New 881–885.** No lease machine, no session-token resume, no teardown orchestrator, no zombie sweeper, no per-principal session caps anywhere in the tree. Auth session tokens exist (`apps/api/src/auth.ts`) but no trial-work resume binds to them. |
| B 822–824 | Oracle, denomination, floor caps | **New 886–888 (design-only proposals).** Zero oracle/USD-denomination coverage. Note the doctrine tension: economics are wei-native today; USD terms need an ADR before code. |
| B 825–828 | Ceiling caps, gas, commission, breakers | **Absorbed.** Repo 825/826/828 match topics with caveats. Pasted 827 (`FEE_BPS=1500` canonical) is **refused**: repo 827 records `FEE_BPS=500` canonical per ADR-0001; 1500 lives only as v2 `ARENA_FEE_BPS` per ADR-0011. |
| C 829–834 | Unique XP engine | **Absorbed.** Repo 829–832/834 match with caveats (design-only where unbuilt). Pasted 833 (anti-fingerprinting) has no direct gate; the stance survives in spirit at 839 (no phone/WhatsApp collection). |
| D 835–840 | Fund flow & custody | **Absorbed.** All six match with caveats. |
| E 841–847 | AGI trial tiers | **Absorbed.** All seven match with caveats. |
| F 848–854 | Multi-agent orchestration | **Absorbed.** All seven match with caveats. |
| G 855–860 | Skill tree | **Absorbed.** All six match with caveats. |
| H 861–866 | Privacy rail / Clean SDK | **Split.** Personhood feed (862), SDK isolation (863), evidence rules (864) absorbed at repo 862–864. Scope boundary, screening gates, SIWE handshake had no gates → **new 889–891** (891 ships: `apps/api/src/auth.ts` is EIP-4361 with stored nonces and session tokens). |
| I 867–872 | Wallet layer / Bitget | **New 892–894 (design-only + conflict).** Zero EIP-6963/adapter-registry coverage, and the pasted pluggable-connector direction **conflicts with the one-wallet law** (wallet surface stays Privy embedded). Recorded as proposal-gated-by-RFC, not as plan. |
| J 873–877 | Showcase suites & fairness | **New 895–897.** Pilot protocol, suite minting, repro pages, expert funnel are unbuilt (895–896). Fairness (897) ships in part: `falseFail` tracked in `grader/src/eval/scorer.ts` with tests; JCS + dataset canonicalization exist; no per-grader false-fail regression suite in CI. |

## Corrections folded in with this pass

- G-692 claimed `probes.jsonl` as the bank format. The bank ships as the
  TypeScript `CHECKERS` map in `grader/src/eval/probes.ts`; no JSONL file
  exists. Title reworded in the file's caveat style; `/compliance`
  regenerated (479 gates).
- The pasted “next free gate = 878” was wrong when pasted (876–880 were
  already taken) and is now 898.

## What was deliberately NOT registered

- The 439–816 conversation gates (adapters, SEO, crypto, Frenchy, STAMP,
  French-voice pools): other sessions' numbering, partially absorbed under
  this repo's own ids (e.g. 868 Adaption, 869 Polymath, 800 timelock,
  805 gateway, 809 money state). Re-registering them would fork the ledger.
- `weights.ts`: the pasted module map names it, but scoring lives in
  `grader/src/eval/scorer.ts` (+ `packages/eval/src/gates.ts`). No gate
  asserts a `weights.ts` file, so nothing points at a missing module.
- Solana gates 701–720: already absorbed under their original numbers;
  the committed program (`crucible-contracts/solana`) carries all six
  instructions. The untracked `contracts/solana` rewrite is in-progress
  work that does not compile (Anchor lifetime/ID errors outside the fee
  module) and is not gated until it does.
