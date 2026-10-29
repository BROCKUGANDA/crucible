# Game theory

**Date:** 2026-10-29 · **Baseline:** `develop` @ `9deb3f2`

The mechanism, written down before it is changed. The brief asks for players,
actions, information, utilities, budget constraints, timing, adversary models,
assumptions and desired equilibria — and asks for the failures to be
documented rather than a claim of security to be made.

**No equilibrium claim is made here.** There is no proof, and this document
does not pretend otherwise. What it does is state the mechanism precisely,
name the adversaries, name the attacks the current design answers and the
ones it does not, and say what would have to be simulated before a constant
moves.

---

## 1. The players

| Player | Holds | Wants | Can act |
|---|---|---|---|
| **Sponsor** | ETH, the right to write a task | a cheap, correct answer to a task it cares about | posts a trial, funds it, writes the spec |
| **Agent / operator** | ETH, a runner, a model, a scaffold | profit and reputation | registers, bonds, claims, submits a run |
| **Skeptic** | ETH | profit for finding a false claim | watches, files a break, stakes |
| **Argus seat** | ETH (a seat deposit) | be paid for a correct vote | commits a vote, reveals it |
| **Committee** (3 seats, quorum 2) | — | adjudicate | settles a dispute |
| **Treasury** | ETH | the fee | receives it |
| **Protocol** | the rules | — | — |

## 2. The mechanism (legacy escrow, as implemented)

```
sponsor ──createTrial(reward)──▶ escrow
                                  │
              agent ──claimTrial()─┤ bond = 20% of reward (floor 0.01 ETH)
                                  │
              agent ──submitRun(runHash, sig)──▶ Judging
                                  │
   skeptic ──fileBreak(proof)────┤ stake ≥ 1% of reward  (one slot)
                                  ▼
                              Challenged ──▶ 3 Argus seats commit (24h) then reveal (24h)
                                  │
                    2 agreeing reveals ──▶ _settle()
                                  │
        DISPUTE_TIMEOUT (3 days) ──▶ finalize() → agent's favour
```

**Settlement outcomes** (from `contract-spec.md` §5, all three conservation-
checked):

| Outcome | Agent | Skeptic | Treasury | Sponsor | Alloy |
|---|---|---|---|---|---|
| Paid | `reward − fee` | stake split 50/50 agent/treasury | fee | — | +win |
| Slashed | loses the bond | stake + 30% of bond | 70% of bond | full refund, no fee | **−25%** |
| Refunded | bond returned | — | — | full reward | — |

`fee = 5%`, taken from the agent's payout.

## 3. The two clocks that decide most disputes

**The commit–reveal window is 24 hours each way.** A seat that sealed on time
is never rushed: the reveal window opens only after the commit window closes.
This is not incidental — it exists so that one seat cannot disenfranchise the
other two by revealing first and watching the quorum resolve without them.

**The dispute timeout is 3 days and favours the agent.** If the committee
cannot reach a quorum, the agent wins. This is a **deliberate bias**: the
protocol prefers a false negative (a possibly-valid claim stands) over a
false positive (a valid claim is slashed on an undecidable dispute). The
cost is that a committee that simply fails to act is worth 70% of a bond to
the treasury, and the protocol is therefore exposed to a *committee
griefing* attack — three seats that never vote, collecting the slash while
the agent's claim was honest.

**This is the sharpest unmodelled attack in the mechanism, and it is
quantifiable.** The agent's expected loss from a three-seat committee that
never votes is 20% of the reward (the bond), of which 70% goes to treasury
and 30% to the third-party member of the committee. If the same three seats
run many disputes, the griefing compounds across them while the
per-dispute cost to any single agent looks like a one-off. Whether this is
profitable depends on the cost of running three seats, which is exactly the
quantity S3 must model.

**The seat bond is the intended counterweight.** `seat_fee_bps = 50` (the
per-seat fee pool is `reward × 50 bps × 3 seats`) and
`seat_bond_min_multiple_of_fees = 5` (a seat bonds 5× that, across the
maximum docket) exist to make a seat that decides dishonestly lose more than
it gains. **Whether the multiple is sufficient has never been simulated**,
and that is S3's first question.

## 4. Assumptions, stated so they can be attacked

| # | Assumption | If false |
|---|---|---|
| A1 | A rational agent prefers a passing run to a slashed one | the 20% bond is not a real cost and the protocol has no deterrence |
| A2 | A rational sponsor does not write a task its own agent can trivially pass | reputation is cheap and the corpus is worthless |
| A3 | A rational skeptic only files a break it believes will succeed | spam challenges; the one-break-slot rule bounds this but does not price it |
| A4 | Committee seats do not collude | see §5.3 |
| A5 | The bond is large enough relative to the reward to deter false claims | 20% may be too low, or too high and no one claims at all |
| A6 | Agents are heterogeneous — a second wallet is a different economic actor | Sybil splitting; the `SelfClaim` check does nothing |
| A7 | A disputed claim is genuinely uncertain | the committee is adjudicating noise, and the 3-day bias decides it by default rather than by evidence |

**A5 has an unexplored failure mode: the bond may be too *high*.** At 20% of
reward with a 1% minimum break stake, a low-reward trial's bond (floored at
0.01 ETH) can exceed what the work is worth, and the agent rationally
declines to claim. Nothing in the tree measures the claim rate.

## 5. The adversaries

### 5.1 Sybil splitting — **the unsolved one**

`SelfClaim` rejects `agent.operator == trial.sponsor`; `SelfBreak` rejects a
break from the sponsor or operator. Both are `msg.sender` checks. A second
wallet defeats both, and the contract spec says so: "A sponsor using a second
wallet is Sybil behaviour that a `msg.sender` check cannot solve."

**What actually defends against it is economic**, and it is worth being
precise about which part:

- The **bond** is at risk (20% of reward) — so a farmed reputation costs
  something.
- A **slash costs 25% of Alloy** — so a false claim is not free reputation.
- The **evidence is re-derived** by a committee that did not participate — so a
  farmed run cannot simply be asserted.
- The **Alloy is soulbound** — so reputation cannot be sold, rented or
  transferred, which is what makes it a credential rather than a commodity.

**What does not defend against it:** correlated behaviour. Five operators
running the same model on the same corpus produce five identical-looking
records, and nothing in the tree notices. There is no operator-affiliation
graph, no correlated-submission detector, and no simulation that asks how
much the protocol earns per unit of collusion.

### 5.2 Stake splitting

Splitting a bond across many agents is the same attack as a second wallet,
with the difference that each agent's reputation is fresh. The economics are
identical to A6. The `MAX_TOTAL_ESCROWED` cap (10,000 ETH) bounds the
*protocol's* exposure, not the *attacker's*.

**Status: unmodelled.** S3.

### 5.3 Committee collusion

Three seats, quorum 2. Two colluding seats settle any dispute in their
favour — and the third seat is decoration. The seat bond is the intended
cost, and it is computed as
`reward × SEAT_FEE_BPS × MAX_DOCKET × SEAT_BOND_MIN_MULTIPLE` (multiplied
before dividing, because the fee split truncates). So it **does** scale with
the disputed reward, and on the v2 arena a seat that decides dishonestly
risks a multiple of the fee pool rather than a fixed amount.

**What is not yet established:** that the multiple is *large enough* at either
end of the reward range. The seat fee pool is `reward × SEAT_FEE_BPS ×
ARGUS_SEATS` = 1.5% of reward at the current parameters, and the bond
multiple is 5 of that across the maximum docket — but the relation between
that bond, the disputed reward and the agent's 20% bond has never been
simulated, and `MAX_DOCKET` (8) means a seat's exposure is capped by a
*maximum* rather than by the actual number of breaks it might sit.

This is a specific, checkable hypothesis for S3: *is the seat bond sufficient
relative to the disputed reward at both ends of the range, and how does the
`MAX_DOCKET` multiplier interact with a seat that actually sits fewer
disputes than the maximum?*

### 5.4 Bribery and vote buying

A vote is `keccak256(abi.encodePacked(id, breakWins, salt))` committed, then
revealed. The salt makes the commit opaque until reveal, which prevents
buying a *specific* vote before it is cast. It does not prevent buying a
seat's *disclosure* — a party that learns the salt after the reveal window
opens cannot change a revealed vote, but a party that pays a seat to reveal
a particular way, having been paid to commit the opposite way, is
indistinguishable from honest disagreement at the protocol level.

**The committee is fixed at construction** (`argus_` is constructor-selected,
`BadArgusSeatCount` if the count is wrong), so there is no jury-selection
market to attack — but also no way to rotate out a captured seat except by
redeploying the contract.

### 5.5 Cartel formation among agents

If a set of agents agree not to compete (or to farm the same cheap tasks
together), the reputation signal degrades: the leaderboard stops ranking
capability and starts ranking cartel membership. The defences that exist are
the **difficulty band** (`targetDifficulty(r, accuracy)` in
`packages/eval/src/gates.ts`) and the **splits** — but neither detects a
cartel, and there is no diversity requirement on benchmark families.

**Status: unmodelled.** The brief's "require diverse benchmark families" is
not implemented.

### 5.6 Score farming with cheap tasks

A farmable loop is: post a trivially easy task, claim it with a cheap agent,
win, accrue Alloy. The defences that exist:

- The **difficulty band** rises with the agent's rating, so a strong agent is
  offered harder tasks (`targetDifficulty`).
- The **bond** scales with the reward, so a cheap task carries a cheap bond —
  which means a farmable loop over cheap tasks accrues *cheap* reputation,
  but it accrues it *quickly*.

**What is missing is the counter the brief names:** diminishing returns for
repetitive tasks, a domain-diversity requirement, and unique-benchmark-family
requirements. Without them, reputation is a function of *volume* rather than
capability — which is precisely what the brief forbids ("promotion must be
based on quality-weighted evidence, not transaction volume").

**This is the single highest-value economic gap**, because it attacks the
credential the product sells. S3.

### 5.7 Sponsor–agent collusion

A sponsor writes a task its own agent can pass. `SelfClaim` stops the direct
case. The indirect case — two unrelated operators, one sponsor and one agent,
sharing a task and a plan — is not distinguishable from a legitimate pairing
by the protocol.

**The defence that exists is evidentiary rather than structural:** the suite
is a `bytes32` commitment published before the claim, so the agent cannot
retro-fit its run to a suite chosen after the fact. That closes *suite*
collusion. It does not close collusion over **what the suite tests** — a
sponsor who writes a trivial-but-legitimate suite and an agent who is
privately told the answer.

### 5.8 Evaluator collusion

The Argus seats are the evaluators. Their collusion is §5.3. The *grading*
of models (the grader) is a separate surface: `grader/src/eval/abstention.ts`
uses 30 unanswerable probes and 10 controls, so a scorer that always says
"FAIL" scores 75% on the unanswerable set and is caught by the control set.
That is a real defence, and it is worth noting that the abstention panel
produced an **honest disqualification** rather than a favourable score.

### 5.9 Griefing by spam challenges

One break slot per trial bounds spam per trial, and a losing skeptic's stake
is split 50/50 between the agent and the treasury — so a failed break is not
free, it costs the spammer 50% of the stake. That is a real price.

**But a spam break on a trial that would have failed anyway** is cheap
relative to the option value: the spammer learns nothing, pays 50% of a 1%
stake, and the trial's outcome is unchanged. Against a large reward that is
noise. The `max_docket` and `max_active_claims` parameters bound concurrency
but not *cost*.

### 5.10 Benchmark leakage and the "cheap task" economy

A leaked corpus makes the leaderboard worthless without breaking any
mechanism. The controls that exist are split-based (`verifyPartition`),
content-based (`lintRagDocs` with `HoldoutFingerprint`) and dataset-versioned
(`datasetId = sha256(JCS(manifest))`). **What does not exist:** canary
markers, exposure disclosure, rotation, or a retirement procedure. A leaked
holdout is therefore a *silent* failure — the leaderboard looks healthy.

## 6. The desired equilibria, stated as intentions

These are **intentions, not proven equilibria.**

1. **The honest path is the profitable path.** A well-run agent that passes
   honestly should out-earn a farming loop. *Currently unverified* — the
   farming loop's profitability has never been simulated.
2. **Breaking a false claim is profitable enough to be worth the stake.** A
   30% share of the bond, for a stake of 1% of the reward, is a 20:1 gross
   return before costs — clearly intended to be attractive.
3. **A false claim is expensive.** Losing 20% of the reward and 25% of Alloy
   should exceed the value of the claim. *Unverified at either end of the
   reward range* — the bond floor and the Alloy loss do not scale together.
4. **The committee is honest because the seat bond exceeds the value of a
   dishonest vote.** *The bond scales with the reward, but the relation
   between it, the disputed amount and the agent's bond has never been
   simulated* — see §5.3.
5. **Reputation tracks capability.** *Currently it tracks volume as much as
   capability* — see §5.6.

**Equilibria 1, 3 and 5 are the ones the product's claims rest on, and
none of them has been tested.**

## 7. What must be simulated before a constant moves

This is the brief's requirement, and it is the right one. Before any change to
a stake, a fee, a window, a multiplier or a tier:

1. **Sweep the reward range**, including the floor (0.01 ETH) and the cap
   (1,000 ETH), because the agent's bond floor and the seat bond do not
   scale together (§5.3).
2. **Model the adversaries** in §5 with varied budgets and rational
   strategies, and report the *threshold* at which each becomes profitable.
3. **Publish the assumptions** — ETH price, agent-win rate, committee
   behaviour — and mark every derived figure as an inference.
4. **State the equilibrium intuition** and the known failure cases.
5. **Do not describe the mechanism as "game-theoretically secure."** There is
   no proof, and this document is the reason that phrase is not used.

---

*Related: [`assessment.md`](assessment.md) §2.2,
[`economics-and-incentives.md`](economics-and-incentives.md),
[`security-threat-model.md`](security-threat-model.md) §3.1,
[`roadmap.md`](roadmap.md) (S3).*
