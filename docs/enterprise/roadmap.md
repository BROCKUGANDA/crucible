# Enterprise roadmap

**Date:** 2026-10-29 · **Baseline:** `develop` @ `9deb3f2`

The order of work, with the gate each slice must pass. The brief's priority
model — P0 safety and correctness, P1 enterprise usability, P2 evaluation
breadth, P3 advanced market mechanisms — is kept, but the sequence is driven
by **what blocks what**, and one slice is out of the brief's order on purpose.

---

## 1. The sequence, and why it is this one

```
P0  S1   Evaluation manifest                     ✅ shipped (ADR-0017)
P0  S1b  The runner emits one                     ← NEXT
P0  S2   Two typed schedules, one consumer API
P0  S3   Adversary simulation
P1  S4   Organisation and tenancy
P2  S5   Release evidence (SBOM, DR drill, SLOs)
P3  --   Solana, frontier tier, pricing proposal
```

**Why S1b is next rather than S2 or S4.** The manifest exists and nothing
produces one. Until the runner emits a manifest, a score in this system still
cannot be attributed to its conditions, and every statistical, eligibility and
reproducibility requirement in the brief — items 022 through 030, 041 through
050, 176, 286, and the whole of S2's schedule identity — is unreachable. S1b
is the smallest slice that turns a schema into a fact.

**Why S3 (adversary simulation) precedes S4 (tenancy).** The brief's Gate
ordering puts economic integrity before enterprise collaboration, and this
document agrees with the brief rather than against it. The reasoning is
specific: S4 introduces a multi-tenant control plane, and a multi-tenant
control plane is *itself* a collusion surface — a set of orgs that coordinate
their runs, share a benchmark, and farm reputation together is a cartel at a
different layer than the one the protocol's `msg.sender` checks address. If
the economics are unsound when S4 lands, the enterprise product inherits the
flaw and scales it.

**Why no pricing proposal appears.** The brief forbids setting financial
constants by intuition, and `game-theory.md` §6 names three equilibria the
product's claims rest on — none of which has been tested. A pricing proposal
before S3 would be exactly the intuition the brief prohibits.

## 2. The slices

### S1 — Evaluation manifest ✅ shipped

The binding that makes a score mean something: a versioned, content-addressed
description of the conditions a result was produced under.

**Delivered:** `packages/smith-sdk/src/manifest.ts` — schema, digest,
comparison rules, `manifestsComparable`. 224 tests in the workspace; nine
mutations proven and restored. ADR-0017.

**Gate passed:** tests green, `tsc --noEmit` clean, build clean.

**Not delivered, and named:** no code produces a manifest. That is S1b.

### S1b — The runner emits the manifest

`packages/forge-runner` writes an `EvalManifest` beside the artifact and
publishes its digest the way a spec digest is published. The manifest
records: the trial's spec and suite digests, the model **and its exact
version**, the scaffold, the system-prompt digest, the tool set and per-tool
permission digests, the environment image digest and its limits, the seed,
the sampling parameters, the scoring configuration with the fee **schedule**,
and the timestamps.

**Nothing on chain changes.** The manifest is content-addressed and
fetchable; `RunArtifact`, `computeRunHash` and `submitRun` are untouched.

**Gate:**
1. The runner emits a manifest for every run, and a run with no manifest is
   refused by the grader — not scored with a default.
2. A third party holding only the run's inputs recomputes the same digest.
3. The grader attaches the manifest digest to every scorecard row, so a
   leaderboard row points at the conditions that produced it.
4. Two rows with different manifests are refused by the comparator, and the
   refusal names the field that moved.

**Closes:** 022, 023, 024, 025, 026, 027, 050, 070, 176, 286 — and opens
041–049 (the statistics), 172 and 176.

### S2 — Two typed schedules, one consumer API

Not a constant. **Two typed schedules** — legacy 5% and arena 15% — each with
id, version, rate, base, rounding, payer and receiver, and a consumer API
where **the schedule is a required argument**. The rates stay where they are:
on the chain (legacy, read at runtime by `readProtocolFee`) and in
`params/crucible.params.json` (arena). The typed schedules *reference* them.

**Why not "move the fee into TypeScript":** the API reads `FEE_BPS` off the
deployed contract on purpose, so the host does not carry a copy that can
drift. A constant in TypeScript would reintroduce the drift that design
removes — and the code comments record the exact bug that motivated it: a
failed constant read once published a fee of zero and a payout of the full
reward, as though measured.

**Gate:**
1. Every fee display and every fee computation states its schedule; there is
   no overload that guesses.
2. The legacy and arena schedules cannot be confused by a caller — the types
   make the confusion a compile error.
3. The flow table gains a row per failure mode the brief names: judge outage,
   provider outage, chain reorg, underfunded vault, duplicate transaction,
   stale indexer, emergency pause.
4. The existing indexer and API tests pass **unchanged** — a refactor that
   requires editing them to fit has changed the wrong thing.
5. A property-based test asserts conservation across every outcome row.

**Closes:** 111–117, 120, 131–135, 140 — and supplies the schedule identity
S1b records.

### S3 — Adversary simulation

Agent-based simulation of the mechanism against the adversaries in
`game-theory.md` §5: Sybil identities, stake splitting, juror bribery,
sponsor–agent collusion, evaluator collusion, cartel formation, spam
challenges, benchmark leakage, score farming with cheap tasks, and wash
activity.

**The simulation runs against the real constants** — read from
`params/crucible.params.json` and the chain's `FEE_BPS` — so a change to a
constant changes the outcome. A simulation with its own copies of the numbers
proves nothing.

**Gate:**
1. Every adversary is implemented with a budget and a strategy, and the
   threshold at which it becomes profitable is reported.
2. The reward range is swept end to end, including the 0.01 ETH floor and the
   1,000 ETH cap, because the agent's bond floor and the seat bond do not
   scale together.
3. The three untested equilibria (the honest path beats farming; a false claim
   is expensive; reputation tracks capability) are each reported as
   supported or not supported, with the evidence.
4. The assumptions are published, and every derived figure is labelled an
   inference.
5. **No claim of game-theoretic security.** The output is a set of
   thresholds and a documented equilibrium intuition.

**Closes:** 081–090, 136, 137, 138, 218 (the "publish the mechanism's
assumptions" item).

### S4 — Organisation and tenancy

Orgs, workspaces, memberships, the ten-role permission matrix, invitations with
expiry and revocation, per-org budgets and quotas, per-org dataset visibility,
audit export, scoped API keys and signed webhooks.

**Gate:**
1. **Tenant isolation proven at every layer** — API, storage, artifact and
   queue — by tests using two orgs and asserting one cannot see the other.
2. A client-supplied org id is never trusted: it is a filter over what the
   session already proves.
3. The rate limiter and auth nonces are global across instances, not
   process-local (ADR-0008's own caveat).
4. An enterprise identity outage cannot block a settlement.
5. A COI register exists and the Argus seat selection honours it.
6. The API's no-chain-key property is re-proven by a test, not by inspection.

**Closes:** 141–160, 161–170, 271–275, 281–288 — and requires its own ADR,
because it changes the deployment's failure modes.

### S5 — Release evidence

SBOM per release, a backup/restore drill with measured RPO and RTO,
operational SLO dashboards, an incident severity taxonomy with an escalation
path and an on-call rotation, and an off-chain kill switch for new runs that
leaves in-flight settlement untouched.

**Gate:**
1. A drill that **actually restores**, with the measured numbers written down.
2. An SBOM per release, retained.
3. The SLOs are **measured**, not promised — the brief is explicit that no SLA
   may be claimed before it is measured.
4. The kill switch stops new runs without touching a settlement in flight, and
   a test proves it.
5. The severity taxonomy names a responder and an escalation path.

**Closes:** 20, 202, 211–220, 226, 230 — and the operational half of 28.

## 3. Explicitly deferred

| Item | Why | Revisit |
|---|---|---|
| **Solana on mainnet** | never SBF-compiled; the toolchain is not on the build host; a separate application with its own ADR and threat model | P3, behind an independent audit and an explicit product decision |
| **The frontier / council tier** | granting a tier changes what a run must satisfy — stronger isolation, higher review gates, enhanced audit | after S3, with its own ADR |
| **A pricing proposal** | three load-bearing equilibria are untested (`game-theory.md` §6) | after S3 |
| **Replacing the in-memory indexer** | ADR-0008's choice; nothing in the evidence says scale is binding | only if S4's tenancy demands it, and then by a new ADR with a migration plan |
| **A token** | ADR-0001 and ADR-0002: native ETH, no ERC-20, no sale, no bridge. The deck names "No token" as a moat | not on the roadmap |
| **Unifying the 5% and 15% schedules** | they are two products' economics | never without an ADR |

## 4. The release gates

| Gate | Contents | Exit evidence |
|---|---|---|
| **0 — Baseline and containment** | ✅ this engagement | gitleaks red on `develop` fixed and green; the Cargo.lock staleness fixed; the Money Trees chip actually mounted; test counts measured and recorded; the enterprise assessment written against the tree |
| **1 — Economic integrity** | S2 | two typed schedules; every fee display states its schedule; conservation property-tested across every outcome row |
| **2 — Evaluation integrity** | S1b, S3 | the runner emits manifests; the grader attaches them; paired statistics; adversary thresholds published |
| **3 — Enterprise collaboration** | S4 | tenant isolation proven at every layer; RBAC; audit export; budget controls; scoped integrations |
| **4 — Incentive integrity** | a pricing proposal | published assumptions; independent security / legal / economic review; **no** claim of formal proof |
| **5 — Frontier launch** | S5 + audits | independent contract and infrastructure audits; a DR drill; SLO evidence; an incident exercise; explicit approval for real-value exposure |

## 5. The next three milestones

1. **S1b — the runner emits a manifest.** The smallest slice that turns a
   schema into a fact, and the precondition for every statistical and
   eligibility requirement in the brief.
2. **S2 — two typed schedules.** The economics made explicit without moving
   a single constant, so the brief's "never silently harmonise" becomes
   structural rather than documentary.
3. **S3 — adversary simulation.** The three untested equilibria tested,
   before any constant moves.

**The enterprise product (S4) is deliberately fourth.** It is the largest
slice, it introduces the largest new attack surface, and it is worth doing
*after* the economics are known to hold — not before.

---

*Related: [`assessment.md`](assessment.md),
[`target-architecture.md`](target-architecture.md),
[`evaluation-protocol.md`](evaluation-protocol.md),
[`economics-and-incentives.md`](economics-and-incentives.md),
[`game-theory.md`](game-theory.md),
[`security-threat-model.md`](security-threat-model.md),
[`collaboration-and-governance.md`](collaboration-and-governance.md),
[`production-checklist-300.md`](production-checklist-300.md).*
