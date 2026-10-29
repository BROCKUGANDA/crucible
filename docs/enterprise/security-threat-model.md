# Security threat model

**Date:** 2026-10-29 · **Baseline:** `develop` @ `9deb3f2`

A threat model for the platform as it exists, extended with the enterprise
threats the brief names. It follows the OWASP LLM/Agentic taxonomy the brief
cites, because that is the vocabulary the enterprise buyers' security teams
will arrive with.

**Scope.** The escrow protocol, the evaluation plane, the worker plane, the
read model, the API, and the product surface. Out of scope: the Solana port
(a separate threat model, per ADR-0011 and `docs/wallets.md`), and the
deployment's host and network beyond what the edge gate covers.

---

## 1. Assets

| Asset | Why it matters | Where it lives |
|---|---|---|
| **Escrowed ETH** | real money, moved by a contract | `CrucibleTrials.sol` |
| **The settlement fee** | protocol revenue | contract → treasury credit |
| **Alloy reputation** | the product's credential; soulbound, non-transferable | `AlloyRegistry.sol` |
| **The trial spec and suite** | the commitment the whole protocol rests on | content store, `bytes32` on chain |
| **The runner's key** | can sign a run | agent-side, never server-side |
| **The API session** | a wallet-signed identity | `apps/api/src/auth.ts` |
| **The evaluation manifest** | the binding that makes a score mean something | `packages/smith-sdk/src/manifest.ts` |
| **The recorded verdict** | the evidence a stranger re-derives | chain + indexer projection |

## 2. Adversaries

| Adversary | Capability | Mitigation in the tree |
|---|---|---|
| **The agent** | controls its own repo, its own prompt, its own output; wants a passing score | cannot edit the grader (`touchesTests` fails closed); suite output is treated as untrusted data; runner is a separate signer |
| **The sponsor** | writes the task, funds it; wants a cheap pass | spec and suite are `bytes32` commitments; the sponsor cannot write the suite verdict |
| **A skeptic** | wants to win a break; can spam breaks | one break slot per trial; stake ≥1% is returned to free stake; refund is permissionless |
| **A colluding set** | several wallets acting as one | **not solved by `msg.sender` checks** — see §3.1 |
| **A malicious operator** | controls the runner and the agent's keys | `packages/agent-security`'s 35 controls; the API holds no chain key (ADR-0006) |
| **A compromised dependency** | arbitrary code at build or runtime | `gitleaks`, `slither`, dependency audit with severity ceilings, SBOM (**missing**) |
| **A hostile network** | the internet, the RPC endpoint | the edge gate refuses node-control methods (§4) |
| **An insider** | writes to the repo or the deployment | fork guards in CI; audit log in `packages/agent-security/src/audit.ts` |

## 3. Threat-by-threat

### 3.1 Sybil and collusion — **the mechanism's real weakness**

**Threat.** `claimTrial` rejects `agent.operator == trial.sponsor` with
`SelfClaim`, and `fileBreak` rejects a break from the sponsor or the agent
operator with `SelfBreak`. Both are `msg.sender` checks.

**They do not stop a second wallet.** The contract spec says so plainly:
"A sponsor using a second wallet is Sybil behaviour that a `msg.sender` check
cannot solve." The same applies to a split bond, a farmed reputation, and a
cartel of operators voting together.

**Status: Partial, and the limit is documented.** The mitigation that exists
is *economic* — a bond at 20% of reward is at risk, a slash costs 25% of
Alloy, and the trial's evidence is re-derived by a committee that did not
participate. The mitigation that does **not** exist is statistical: no
adversary simulation (S3), no correlated-behaviour detection, no
operator-affiliation graph.

**This is the honest assessment of the protocol's weakest point**, and it is
why S3 (adversary simulation) precedes any pricing change.

### 3.2 Evaluator integrity — **strong, and load-bearing**

| Attack | Defence | Evidence |
|---|---|---|
| Agent edits the hidden tests | `touchesTests` fails closed — a non-empty patch touching the suite aborts the run | `README.md`, `packages/forge-runner` |
| Agent edits the grader | same check, extended to the grader's own files; `fails closed` | " |
| Agent edits the runtime policy | the policy is host-side | " |
| Suite output is trusted | suite output is **stdout from a sandbox** — untrusted by a second route | `packages/forge-runner/src/agent.ts:183` |
| Prompt injection from the task | suite output is quarantined as data, not elevated to instructions | `packages/agent-security/src/injection.ts` |
| Rubric decides when it should not | ADR-0005: deterministic evidence outranks the rubric | `docs/adr/0005` |

**Status: Existing.** This is the strongest part of the system.

### 3.3 Sandbox and execution isolation — **strong, with one honest caveat**

| Control | Where |
|---|---|
| Sealed sandbox with a pinned image | `packages/forge-runner/src/sandbox.ts`, `resolveVerifierImage` |
| Egress allowlist; the model call is the one path out | `packages/forge-runner/src/egress.ts` |
| Import linting — CI-enforced seal | `packages/forge-runner/src/import-lint.ts` (gate 502) |
| Tier-scaled strictness — raises, never lowers, the sandbox floor | `packages/forge-runner/src/tiers.ts` (gate 901) |
| Tool capability grants and injection defence | `packages/agent-security/src/toolbox.ts`, `injection.ts` |
| Memory sealing | `packages/agent-security/src/memory-seal.ts` |

**The caveat, stated as the README states it:** the live agent path **can run
unisolated and labels its output degraded**. The labelling is the mitigation
and it is honest — but "degraded" must disqualify the run from any
high-trust reward, and that disqualification rule is not yet enforced
everywhere. Tracked as a checklist item.

### 3.4 Secret handling — **strong, with a live lesson**

- The API holds **no chain key** (ADR-0006). `apps/api/src/server.ts` uses a
  public client; every write is wallet-signed.
- The runner's key is agent-side; `packages/agent-security/src/credentials.ts`
  scopes and audits it.
- The **funded test wallet is its own service** (ADR-0015, *Proposed* — not
  shipped).
- `gitleaks` scans **full history** (`--log-opts=--all`) on every push.

**The lesson from this engagement:** the scanner is a hard gate and it
matches *shape*, not meaning. A `const STORAGE_KEY = "..."` holding a
localStorage slot reddened every branch — one published commit, every push
red, three promotions refused. Fixed in `fa90c0b` (rename the identifier,
allowlist the published literal by exact match). **Standing hazard:** the
enterprise work introduces fields literally named "environment digest" and
"evaluator key", which is exactly the shape this rule matches.

### 3.5 The RPC edge — **strong, and verified at the endpoint**

The gate refuses node-control methods (`eth_accounts`, `eth_sendTransaction`,
`anvil_impersonateAccount`, `anvil_setBalance`, …) at the deployed route, not
in the checkout. `deploy/edge/rpc-gate/probe.mjs` asks a live endpoint for
eight methods plus one batch-smuggled cheat call and accepts **only** the
gate's own refusal (403 with JSON-RPC `-32601`); a node-side `-32602` is a
**failure**, because it proves the call arrived. `npm run test:edge` — 15
tests — rides `verify:all` and CI.

**The specific near-miss worth keeping:** `provision.sh` originally copied the
edge files **without `rpc-gate/`**, so the gate was never in the path — and
the installer would have mounted an empty directory and crash-looped the gate
into a 502 for every wallet. The installer now installs the gate directory
and **recreates caddy when its config differs**, because a bind-mounted
Caddyfile is never reloaded under `admin off`. Gate 903.

### 3.6 The money read path — **strong, and the failure is on record**

`packages/indexer/src/api.ts` derives the settlement fee as the difference
between the escrowed reward and the payout in `VerdictFinalized`. It does
**not** re-derive it from `FEE_BPS`, because that needed a second chain read
and when that read failed the books published a fee of **zero** and a payout
of the **full** reward — a number the chain never charged, published as
though measured.

The rule the code now follows: **unknown is null, never zero.** A failed
constant read leaves the rate null and the settled amounts — which come from
the chain's own logs — unaffected. The API's comment names it: "Zero is not
an absent fee; it is a claim that the protocol charges nothing."

**Status: Existing.** This is the model the enterprise billing work must copy:
the ledger is derived from the chain's own events, and a number nobody can
verify is absent rather than zero.

### 3.7 Replay and duplication

| Threat | Control |
|---|---|
| Signature replay | `SIG_DEADLINE_TTL_SECONDS = 600`; `apps/api/src/replay.ts` |
| Duplicate submission | chain reverts on state (`submitRun` requires `Assigned`; settlement paths require terminal state) |
| Request replay against the API | `apps/api/src/replay.ts` + `rate-limit.ts` |
| Content substitution | CIDs and `bytes32` commitments; the disclosure log ties a keccak digest to the CID naming the same content |

### 3.8 Supply chain — **partial**

Present: `gitleaks` over full history; `slither` with every suppression
justified in `docs/slither-triage.md`; a dependency audit that fails only on
advisories outside a documented set (`scripts/audit-gate.mjs`); digest-pinned
tool installs (`scripts/install-tool.sh`); fork guards so a fork never
executes on the self-hosted runner.

**Missing: an SBOM per release.** Tracked as a checklist item (S5).

### 3.9 The enterprise threats, honestly

The brief names a set of threats that **cannot be assessed against this tree**,
because the tree has no multi-tenant surface to threaten:

| Threat | Status | Why |
|---|---|---|
| Tenant isolation (IDOR/BOLA across orgs) | **Not applicable yet** | there is one principal — a wallet. It becomes a live threat the moment S4 lands, and S4's gate requires proving isolation with two orgs. |
| Org-scoped API keys, service accounts | **Missing** | — |
| Signed webhooks with replay protection | **Missing** | — |
| Budget exhaustion / cost-center abuse | **Missing** | no metering to abuse |
| Data residency, retention, legal hold, PII scanning | **Missing** | — |
| Breach notification and customer escalation | **Missing** | — |
| Multi-instance rate limiting | **Partial** | ADR-0008: the rate limiter and auth nonces are **process-local**; neither is a global control behind multiple instances |
| RPO / RTO, backup and restore | **Missing** | the indexer is rebuildable from the chain (a restart replays it), so the *index* needs no backup — but the deployment, its secrets and its content store do, and no drill exists |

## 4. Security controls that must not be weakened

Named so a later change cannot quietly remove them:

1. **The API holds no chain key** (ADR-0006).
2. **Settlement never pushes ETH** (ADR-0003) — `withdraw()` is the only
   `{value:}` call.
3. **The conservation invariant is exact** — `address(trials).balance ==
   totalStakes + totalPending + escrowed`.
4. **The grader fails closed** — `touchesTests` aborts rather than warns.
5. **The RPC edge refuses node-control methods**, verified at the endpoint.
6. **Unknown is null, never zero** — in the books and in every display.
7. **No fork executes on the self-hosted runner.**
8. **The secrets scan covers full history**, and its allowlist names exact
   literals with a reason.

## 5. The enterprise threat model, when S4 lands

This section is a **specification for a slice that has not been built**, and
it is written now so S4 cannot ship without it.

### 5.1 Tenant isolation — required layers

| Layer | Requirement | Test |
|---|---|---|
| API | every route derives the org from the session, never from the request body | a request naming another org's id returns 404, not the other org's data |
| Storage | content-addressed artifacts carry an org scope | an artifact id from org A is not fetchable by org B |
| Queue | jobs carry the org scope; a worker cannot read across it | two orgs' jobs interleave without crossing |
| Database | (if S4 introduces one) every query is org-scoped | a cross-org query returns nothing |

**The rule that makes this testable: a client-supplied org id is never
trusted.** It is a filter over what the session already proves.

### 5.2 The agentic threat taxonomy

Mapped to OWASP LLM Top 10 and the Agentic Threats and Mitigations list, with
the controls that exist and the ones that do not:

| Threat | Control today | Gap |
|---|---|---|
| Prompt / goal hijack | `packages/agent-security/src/injection.ts`; suite output quarantined as data | — |
| Tool misuse | `toolbox.ts` capability grants; `tool-guard.ts` | per-tool approval for destructive operations |
| Identity and privilege abuse | `credentials.ts` scoping | org-scoped identities (S4) |
| Supply-chain poisoning | `import-lint.ts`; digest-pinned tools | SBOM (S5) |
| Unexpected code execution | sandbox seal, egress allowlist | attested isolation mode, not just labelled |
| Memory / context poisoning | `memory-seal.ts` | — |
| Insecure inter-agent communication | — | multi-agent benchmarks do not exist |
| Cascading failures | `packages/warden` notices a closed window and queues a permissionless `finalize`; one bad trial never stops the others | multi-instance coordination |
| Human trust exploitation | the "degraded" label on unisolated runs | disqualification enforced in every reward path |
| Rogue behaviour | — | adversary simulation (S3) |

### 5.3 Operational resilience the brief names

| Control | Status |
|---|---|
| Structured logs with request / run / trial / tenant ids | **Partial** — run and trial ids are carried; **tenant id does not exist** (S4) |
| Redaction of credentials and sensitive prompts | **Partial** — `gitleaks` covers the repo; runtime log redaction is per-service |
| Queue depth, run duration, evaluator error and provider health metrics | **Missing** |
| Alerting on unusual payout, dispute, promotion and reputation patterns | **Missing** — and this is the natural home of S3's simulation outputs |
| Kill switch for new runs, separate from settlement | **Missing, and deliberately so at the contract level** — `docs/runbooks/incident-response.md` states it plainly: "There is **no pause, no upgrade and no admin recovery**. The owner cannot move escrowed ETH, a bond or a break stake." That is the *right* default for a custody contract: an admin recovery path is a privileged role the design deleted on purpose. What is missing is the **off-chain** half — a way to stop *new* runs from starting while leaving in-flight settlement untouched, which needs no contract change. |
| Incident severity, triage, escalation and communication roles | **Partial** — `docs/runbooks/incident-response.md` exists and covers key compromise, a contract bug or stuck funds, and a provider/infrastructure incident, with a role table. It has **no severity taxonomy, no escalation path and no on-call rotation**. |
| Evidence preservation and chain of custody | **Partial** — the content store's disclosure log is a chain of custody for *content* |
| Backup restore and DR drill | **Missing** |
| RPO / RTO, defined and measured | **Missing** |
| Status updates for material incidents | **Missing** — no status page or runbook |

## 6. The highest-severity items, ranked

| # | Item | Severity | Why | Closes in |
|---|---|---|---|---|
| 1 | **Sybil / collusion is unsolved** | **High** | a second wallet defeats every self-dealing check; this is the protocol's core economic attack | S3 |
| 2 | **SBOM per release missing** | Medium | supply-chain posture has no per-release artifact | S5 |
| 3 | **Degraded runs not disqualified everywhere** | Medium | a degraded run must not earn a high-trust reward | S2/S3 |
| 4 | **Multi-instance rate limiting and nonces are process-local** | Medium | ADR-0008's own note; two instances defeat both | S4 |
| 5 | **No alerting on payout / dispute / promotion anomalies** | Medium | the anomaly signals S3 needs are not collected | S3 |
| 6 | **No incident severity taxonomy, escalation path or on-call rotation** | Medium | `docs/runbooks/incident-response.md` covers the scenarios; an incident has no documented *routing* | S5 |
| 7 | **No DR drill, RPO or RTO** | Medium | the deployment is single-instance and the drill is unproven | S5 |
| 8 | **Enterprise threats not assessable (tenancy, budgets, residency)** | **Deferred** | the surface does not exist yet | S4 |

**Items 1 and 8 are the two that matter most, and they point in opposite
directions.** S1–S3 make the *evaluation* trustworthy; S4 makes the
*business* reachable. The brief's Gate ordering puts economic integrity
first, and this document agrees.

---

*Related: [`assessment.md`](assessment.md) §2.6,
[`target-architecture.md`](target-architecture.md),
[`game-theory.md`](game-theory.md),
[`production-checklist-300.md`](production-checklist-300.md).*
