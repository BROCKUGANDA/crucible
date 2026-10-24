# CRUCIBLE Security Controls

**Gates 515–613** — OWASP Web Top 10, SCSVS, LLM Top 10, HTTP/runtime, ISO 27001,
AI governance, supply chain, scalability, maintainability, production cheatsheet.

These controls are enforced by CI gates, Foundry invariants, and architectural
constraints. The security white paper (`docs/security-whitepaper.md`) covers the
adapter/producer discipline (439–448), agent sandbox (489–502), frontier model
layer (503–514), data/network layer (614–623), cryptography (624–639),
monetization (640–655), and chain integrity (656–667).

---

## A. OWASP Web Top 10 → CRUCIBLE (515–524)

| Gate | Control | Enforcement |
|------|---------|-------------|
| 515 | A01 Access Control — all GET, zero privileged routes | Route authz matrix; IDOR structurally impossible (read-only API) |
| 516 | A02 Crypto Failures — standard primitives only | `packages/crypto` one-crypto-door (625); no custom crypto |
| 517 | A03 Injection — parameterized queries | No `child_process` in request path; structured JSON logs |
| 518 | A04 Insecure Design — STRIDE-lite threat model | Living doc; locked laws cited as controls |
| 519 | A05 Misconfiguration — hardened headers | CSP, HSTS, X-Content-Type-Options, same-origin CORS |
| 520 | A06 Vulnerable Components — osv-scanner + Renovate | `osv-scanner` in CI; zero known CVEs on main |
| 521 | A07 Auth Failures — tiny auth surface | Privy embedded + read-only API; per-IP rate limits |
| 522 | A08 Integrity Failures — probes.jsonl schema-validated | CI provenance for builds; `npm ci` only |
| 523 | A09 Logging Failures — security event spans | Hash-chained security log, 90-day retention |
| 524 | A10 SSRF — zero outbound fetch on user input | Adapter allowlist (491); canary proves arbitrary URLs die |

---

## B. Smart Contract Security — SCSVS/SWC (525–534)

| Gate | Control | Enforcement |
|------|---------|-------------|
| 525 | Reentrancy — checks-effects-interactions | `nonReentrant` on `postWork`/`settle`/`refund`; Slither-asserted |
| 526 | Arithmetic — checked math | `unchecked` requires inline proof + fuzz test; grep-gated |
| 527 | Access control — `onlyKeeper` on all mutating paths | Two-step ownership transfer; no upgrade keys or proxy |
| 528 | DoS & gas griefing — bounded loops | `settleBatch` bounded, skip-on-fail, never revert whole batch |
| 529 | Push-payment safety — pull pattern | Refund paths are pull-pattern where possible |
| 530 | Front-running — verdicts pure function of claimHash | No tx-order-dependent economics |
| 531 | Time dependence — `block.timestamp` only for deadlines | Scoring sees no clock (determinism law) |
| 532 | Invariants — conservation equality | Foundry stateful-fuzz campaigns nightly |
| 533 | Static analysis — Slither + aderyn | New findings = red build; suppressions need justification |
| 534 | Artifact integrity — bytecode verified vs source | Deployed addresses published with checksums |

---

## C. OWASP LLM Top 10 (2025) → Sandbox (535–544)

| Gate | Control | Enforcement |
|------|---------|-------------|
| 535 | LLM01 Prompt Injection | Fencing + instruction-detection pre-gate; Injection & Authority suite |
| 536 | LLM02 Sensitive Disclosure | Egress scrubber (506) + FS isolation (497) |
| 537 | LLM03 Supply Chain | Snapshot pinning (504); adapter cap (439); fixture checksums |
| 538 | LLM04 Data/Model Poisoning | Corpus flywheel hygiene — source:, PR-reviewed, probeHash dedup |
| 539 | LLM05 Improper Output Handling | Zod contract (494); `dangerouslySetInnerHTML` grep-banned |
| 540 | LLM06 Excessive Agency | Proposal envelope (489); zero effectors; zero agent-held keys (500) |
| 541 | LLM07 System Prompt Leakage | System prompts are public, versioned, promptHash'd |
| 542 | LLM08 Vector/Embedding Weaknesses | v1 uses no RAG; documented N/A |
| 543 | LLM09 Misinformation | Kappa + test-retest + calibration; deciding model disclosed |
| 544 | LLM10 Unbounded Consumption | Token caps, wall-clock, spend budgets, content-addressed cache |

---

## D. HTTP & Runtime Hardening (545–550)

| Gate | Control |
|------|---------|
| 545 | CSP: `default-src 'self'`, nonce-based scripts, frame-ancestors none |
| 546 | CORS: same-origin only |
| 547 | Rate limits: token bucket per IP per route class |
| 548 | Input: zod-validated query params; method allowlist at edge |
| 549 | Runtime: Node LTS pinned, non-root user, read-only FS |
| 550 | Errors: no stack traces to clients; typed error codes + correlation id |

---

## E. ISO 27001-Shaped Controls (551–562)

| Gate | Control |
|------|---------|
| 551 | Asset inventory — one YAML: asset × owner × criticality |
| 552 | Access control — keeper key single-custodian; least privilege by architecture |
| 553 | Cryptography — standard primitives only; keeper hot-wallet rotation runbook |
| 554 | Change management — PR + green CI + CODEOWNERS = change process |
| 555 | Incident management — severity matrix S1–S4; postmortems add gates |
| 556 | Business continuity — backup + restore drill; spectator cursor-replay fallback |
| 557 | Supplier security — vendor register with posture notes + exit plans |
| 558 | Disclosure — SECURITY.md with responsible-disclosure contact |
| 559 | Data classification — public/internal/restricted with handling rules |
| 560 | Log retention — spine append-only + hash-chained; security log 90 days |
| 561 | Monitoring — SSE latency, keeper inclusion, model spend baselines |
| 562 | Privacy — no accounts, no PII; wallet addresses are public chain data |

---

## F. AI Governance — NIST AI RMF, EU AI Act, SOC2-lite (563–572)

| Gate | Control |
|------|---------|
| 563 | AI RMF: Map — inventory of every AI decision with stakeholders |
| 564 | AI RMF: Measure — Arena scorecard is the measurement framework |
| 565 | AI RMF: Manage — breaker, shadow tier, dispute window as risk treatments |
| 566 | AI RMF: Govern — model change control = RFC + GraderRegistry bump |
| 567 | EU AI Act — Warden = limited-risk AI-assisted decision support |
| 568 | AI transparency — verdicts disclose "decided by {model}@{snapshot}" |
| 569 | Human oversight — any disputed verdict reaches a human before settlement |
| 570 | SOC2-lite — security, availability (SLOs + fallback), integrity (invariant + hash chain) |
| 571 | Policy pack — `/docs/policies/`, each ≤1 page, references enforcing gates |
| 572 | Compliance matrix — auto-built from gate front-matter (scripts/compliance-matrix.mjs) |

---

## G. Supply Chain Integrity (573–580)

| Gate | Control |
|------|---------|
| 573 | SLSA provenance — GitHub Actions build provenance |
| 574 | Lockfile law — committed lockfile, `npm ci` only |
| 575 | Dependency policy — direct-deps allowlist, license allowlist, osv-scanner |
| 576 | Model supply chain — snapshot + promptVersion + graderVersion pinned |
| 577 | Contract artifacts — forge-verified source↔bytecode + Slither |
| 578 | Containers & SBOM — trivy scan, syft SBOM, digest-pinned bases |
| 579 | Release integrity — tag → build → SBOM + provenance; verify page |
| 580 | CI is the only path to main — branch protection, required checks |

---

## H. Scalability Ladder (581–592)

| Gate | Control |
|------|---------|
| 581 | Scale law — reads scale horizontally, writes by batch, writers never scale |
| 582 | SSE fan-out — in-process pub/sub; load tested 5k concurrent clients |
| 583 | Projection scaling — SQLite → Postgres replicas, still one writer (keeper) |
| 584 | Static via CDN — hashed assets, immutable cache headers |
| 585 | Write benchmark — settleBatch sizing tuned to block gas ceiling |
| 586 | Backpressure — bounded queue depth; overflow = deferral + span |
| 587 | Workers vs writer — agents scale out, chain writer stays one |
| 588 | Spine rotation — hash-chained segments archived to object storage |
| 589 | Cache strategy — content-addressed, hit ratios published |
| 590 | Out of scope — multi-chain and sharded keepers are post-demo RFC |
| 591 | Degradation ladder — shadow off → cheap → stub → replay → static |
| 592 | Soak & capacity — nightly 1h at 2× peak; RSS-slope leak assert |

---

## I. Maintainability (593–602)

| Gate | Control |
|------|---------|
| 593 | Monorepo boundaries — fixed layout, dependency-cruiser in CI |
| 594 | Pure-core law — types flow down, effects flow up |
| 595 | TS strict — `any` banned, non-null assertions banned |
| 596 | Test pyramid — unit ≥90%, integration, e2e, contract fuzz nightly |
| 597 | Goldens & fixtures — snapshotted, versioned, PR-reviewed |
| 598 | RFC/ADR + CODEOWNERS — every locked law has an ADR |
| 599 | Lint tiers — errors = correctness, zero warnings on main |
| 600 | Vocabulary is code law — glossary enforced in code and docs |
| 601 | Errors & config typed — taxonomy envelope, zod at boot |
| 602 | Runbooks + delete culture — one runbook per component, dead code grep-gated |

---

## J. Production Cheatsheet (603–613)

| Gate | Control |
|------|---------|
| 603 | SLOs published — SSE p95 <2s, API p99 <150ms, keeper inclusion <3s |
| 604 | Env matrix — dev/ci/demo differ only as data |
| 605 | Secret inventory — exactly four secret classes |
| 606 | Deploy & rollback — tag → CI → demo slot; rollback = redeploy previous tag |
| 607 | First-response card — breaker first, snapshot spine tail second |
| 608 | Incident severities — S1 breaker/integrity breach to S4 cosmetic |
| 609 | Drill calendar — monthly breaker drill, monthly restore drill |
| 610 | Demo-day checklist — P0 gates green, pinned release, backup tablet |
| 611 | Judge due-diligence pack — one URL: security + model card + policies + ADRs |
| 612 | Hall of shame — grep-able never-list |
| 613 | The five numbers — false-pass %, kappa, spend vs budget, SSE p95, conservation |
