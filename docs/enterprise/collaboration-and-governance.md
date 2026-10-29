# Collaboration and governance

**Date:** 2026-10-29 · **Baseline:** `develop` @ `9deb3f2`

The brief asks for organisations, workspaces, roles, invitations, shared
benchmark libraries, budgets, scoped integrations and governance. None of that
exists yet, and this document says what it should be — and, importantly, what
it must not cost the product.

---

## 1. The constraint that shapes everything

The product's credibility rests on three properties, and the enterprise
collaboration work must not erode any of them:

1. **The API holds no chain key.** Every write is wallet-signed by a
   participant (ADR-0006). An organisation's billing administrator cannot move
   a participant's ETH, because no server holds a key that could.
2. **Settlement is a pull payment.** A credit is a ledger entry; the
   recipient withdraws (ADR-0003).
3. **Alloy is non-transferable.** Reputation cannot be sold, lent or
   transferred, which is what makes it a credential rather than a commodity.

The enterprise model therefore **cannot** be an account system that holds
funds. It is an account system that holds *access, scope and evidence* — and
money moves only when a participant signs for it.

## 2. The identity model

Two identities already exist and they are different things:

| Identity | Source | Purpose |
|---|---|---|
| **Wallet principal** | SIWE-style challenge/response (`apps/api/src/auth.ts`: `issueChallenge`, `createSessionToken`, `verifySessionToken`) | the only identity that can authorise a chain write |
| **ERC-8004 identity** | `ReputationBridge.sol` + `IdentityRegistry`, **optional** | an operator's own external identity, linked at their discretion |

The brief requires "connect wallet **or** enterprise identity". The tree
already has a pattern for an *optional* external identity that must never
block the core path: **a registry failure must never block settlement**
(ADR-0007's backfill rule, and the identity link reverts rather than
half-succeeds). An enterprise identity must follow the same rule — a
corporate SSO outage cannot stop a trial from settling.

**Decision to record in S4's ADR:** an enterprise identity is an *additional*
principal bound to a wallet principal, never a replacement. The wallet stays
the thing that signs.

## 3. The role matrix

The brief names ten roles. Each maps to a wallet principal plus a role, and
**no role may act on another wallet's behalf without that wallet's
signature.** A "billing administrator" can change a budget; they cannot
withdraw a participant's funds.

| Role | Can | Cannot |
|---|---|---|
| **Org owner** | everything below; transfer ownership | move escrow (no key) |
| **Billing admin** | set budgets, cost centres, spend caps; read invoices | change roles; read run artifacts |
| **Benchmark author** | create and edit private benchmarks and datasets | publish to the public registry without review |
| **Evaluator** | register an evaluator version; run an evaluation | alter a published benchmark version |
| **Runner operator** | register runners, bind them to agents | see another org's runners |
| **Reviewer / skeptic** | file breaks, review submissions | settle (only the Argus committee settles) |
| **Auditor** | read everything in the org; export the audit bundle | write anything |
| **Read-only analyst** | read runs, comparisons, exports | write anything |
| **External collaborator** | scoped, time-limited access to named projects | access other projects, or anything after expiry |
| **Platform operator** | deploy, rotate, observe | move escrowed funds; alter a verdict |

**Separation of duties that must be enforced, not merely documented:**

- The **benchmark author** and the **reviewer who publishes** must not be the
  same principal for a benchmark that appears on a public leaderboard.
- The **runner operator** and the **evaluator** must be separable, so an
  operator cannot grade its own run.
- The **billing admin** cannot grant themselves a role.

## 4. Invitations

The brief asks for expiry, revocation, domain restriction and least-privilege
defaults. The design:

- An invitation is **time-boxed** and scoped to a **project**, not an org.
- Accepting binds an *existing wallet principal*; the invitation never
  creates a key.
- **Domain restriction** is an eligibility filter on the accepting address,
  checked at accept time, not a display hint.
- **Revocation** takes effect at the next request — permissions are read from
  the membership store per request, never cached in a long-lived token.
- Default role on accept is the **lowest** one that grants access, so an
  invitation cannot accidentally grant org ownership.

## 5. Shared benchmark libraries

The brief asks for private/public/internal visibility, immutable published
versions, access control, dataset licensing, provenance, PII handling and
deletion/retention.

**The tree already has the hard part.** `packages/datasets` gives every
dataset a **content-addressed identity**: `datasetId = sha256(JCS(manifest))`,
with `verifyDatasetId` and `verifyManifestIntegrity` proving the manifest
still hashes to its id, immutable shards, an SPDX `license`, a `provenance`
string, a `sourceHash` of the raw bytes before sharding, and a
**stake-gated** `publisher`.

**What S4 adds is the visibility and the org scope** — and the rule that
follows from them:

> **A published benchmark version is immutable.** Publishing mints its id. A
> change is a new version with a new id. There is no "edit in place" path,
> because a leaderboard entry pointing at a mutable id is not evidence.

This is the same discipline as the evaluation manifest (ADR-0017) and the
dataset registry, and it should be the *only* way a benchmark changes.

**PII, retention and deletion** are named here as requirements but **not
designed**: the tree has no PII scanner, no retention policy and no deletion
path, and the content store is addressed by digest, which makes "delete this
artifact" a question with a real answer (it cannot be un-published; it can be
un-*linked*). That distinction needs to be settled before any enterprise data
lands, because a deletion promise that the content store cannot keep is a
promise the product cannot make.

## 6. Budgets, quotas and metering

The brief asks for org budgets, concurrency quotas, model/provider
allowlists, per-org cost centres, invoice export, usage metering and a credit
ledger.

**The credit ledger must be conservation-preserving and must not create
value.** The rule the indexer already follows applies directly: a credit is
derived from the chain's own events, and a number nobody can verify is
**absent, not zero**. A database row must never create or destroy on-chain
value.

**The metering dimensions** the brief names are separable and should be metered
separately: compute, model API use, storage, egress, and human review. The
reason is the double-charging hazard the brief calls out — passing compute
through at cost while also charging a platform fee on the same run charges the
customer twice for one thing.

**Gas is not a protocol fee.** It is the network's toll, paid by whoever sends
the transaction, and it must never appear in a protocol revenue line. The
product already draws this line: the landing HUD publishes the fee **rate**
(`5% · 500 bps`) rather than the treasury's balance.

## 7. Scoped integrations

| Requirement | Design | Status |
|---|---|---|
| **Versioned API** | the read model is versioned by the indexer's cursor semantics (ADR-0010); the write API is wallet-signed | **Partial** — no explicit API version surface |
| **Scoped API keys** | a key is bound to an org, a role and a set of read paths; it cannot authorise a write | **Missing** |
| **Service accounts** | a non-human principal for CI and integrations, with no wallet behind it — so it can only read | **Missing** |
| **Signed webhooks** | HMAC over a timestamped body, with a replay window and a delivery log | **Missing** |
| **Event subscriptions** | over the same event source the indexer consumes, so a subscriber sees what the books saw | **Missing** |
| **SDK / CLI parity** | the SDK and the CLI must expose the same validated protocol as the web UI, not a weaker path | **Existing** — `packages/smith-sdk` is the SDK; `scripts/grade-arena.mjs` is the CLI; both read the same schemas |

## 8. Governance of the platform itself

The brief asks who may change fees, parameters, tiers and evaluator policies;
it asks for timelocks and multisig approval; it asks for prospective-only
changes; it asks for an append-only decision record; and it asks for a
conflict-of-interest register.

**What exists:** `params/crucible.params.json` is the single source for every
v2 number, generated artifacts are committed, and CI fails on drift (gate
732). A parameter change is therefore already a **visible diff** rather than
an edit to a contract.

**What does not exist, and is the governance gap:**

| Requirement | Status | Note |
|---|---|---|
| A named body that may change parameters | **Missing** | today it is whoever merges to `develop` |
| Timelock / multisig for a parameter change | **Missing** | the contract has no owner-driven parameter path |
| Changes apply prospectively only | **Partial** | a parameter change alters *new* trials, because the fee is frozen at post (`Arena.sol:329`) — but the legacy escrow has no frozen schedule version, so a legacy constant change would be retroactive in effect |
| Append-only governance record | **Partial** | the ADRs and `docs/since-submission.md` are append-only in practice; there is no machine-checked decision log |
| Conflict-of-interest register for operators and jurors | **Missing** | `SelfClaim`/`SelfBreak` prevent the *direct* case only |

**The conflict-of-interest point deserves care.** The protocol's own answer
today is a `msg.sender` check, which is the weakest possible form: it catches
the same address, not an affiliated one. An enterprise deployment will have
operators who share an employer, a model provider, or a cloud account. **A
COI register is therefore not a documentation nicety — it is the mechanism's
next defence after the bond**, and it belongs in S4 alongside the identity
model.

## 9. Reproducible collaboration

The brief asks for controlled A/B runs, blinded pairwise comparison,
independent reviewer assignment, reproducible reports, consensus with
uncertainty and signed approval receipts.

**Blinded pairwise comparison is possible today** and is not hard: the grader
already runs candidates against a shared corpus, the manifest makes the
conditions explicit (ADR-0017), and `compareManifests` says whether two
results may be compared at all. **What is missing is the blinding** — a
comparison that shows the model identity to the reviewer is not blind — and
the **statistical machinery** (paired differences, bootstrap intervals), which
S3 or a companion slice must add.

**Reproducible reports** follow from the manifest: a report that carries the
manifest digest can be re-derived by a third party from the same inputs. This
is the single clearest payoff of S1 and it is one slice away.

**Signed approval receipts** already have a shape: `VerificationReceipt.sol`
is the settlement proof, and `packages/smith-sdk`'s EIP-712 path signs a run
artifact. A *review* approval — a human signing off a benchmark version — has
no equivalent yet.

## 10. What this costs the product, honestly

| Risk | Assessment |
|---|---|
| A multi-tenant control plane becomes a new attack surface | Real. The single-wallet model has no IDOR surface because there are no ids to be unauthorised for. S4's gate must prove isolation with two orgs, at every layer. |
| The in-memory indexer becomes a single-tenant assumption | Real. ADR-0008's per-process rate limiter and nonces stop being global the moment there are two instances. |
| Enterprise identity adds a dependency that can fail at the worst moment | Real, and the tree's precedent is clear: a registry failure must never block settlement. |
| The org model implies tiers of access that map onto tiers of *reward* | Must not. An org's billing tier is not an agent's Alloy tier, and conflating them would let a purchased org tier become a purchased reputation tier — the thing the brief forbids. |

---

*Related: [`assessment.md`](assessment.md) §2.5,
[`target-architecture.md`](target-architecture.md) (S4),
[`security-threat-model.md`](security-threat-model.md) §5.1,
[`game-theory.md`](game-theory.md) §5.7.*
