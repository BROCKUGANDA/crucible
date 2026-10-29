# CRUCIBLE Security White Paper

**Status:** design specification, enforced by gates 434–677  
**Chain:** local Anvil, chain id 31337  
**Fee:** FEE_BPS = 500 (5%), not 15% — see ADR-0001  
**Native ETH only; no ERC-20, no USDC, no Privy on the wallet surface**

---

## 1. Thesis

CRUCIBLE's security model rests on one claim: **trust is earned by verification, not assertion**. That claim is applied to the protocol itself. Every security property below resolves to a numbered gate, every gate resolves to a CI check or a Foundry invariant, and every check leaves a hash-chained receipt.

The architecture deletes entire attack classes by construction rather than patching them:

- **Serial, single writer.** Exactly one process (the keeper) writes the trace spine and signs chain transactions. There is no parallel keeper, no Warden fan-out, no queue between Warden and keeper.
- **Read-only API.** The API holds no chain key and every route is a GET. Compromising the API cannot move funds; it can only mislead readers, which is why the read model quotes transaction hashes for anything it asserts.
- **No upgrade keys, no proxy, no admin.** Immutability is a published feature; the absence of admin functions is asserted in CI.
- **Pull, never push.** Settlement credits a pull ledger; the recipient calls `withdraw()` in a separate transaction. ADR-0003 rejected push-with-try/catch explicitly.

---

## 2. The three chains, guarded by one battery

CRUCIBLE guards **three chains** simultaneously:

| Chain | What it is | Guarded by |
|-------|-----------|------------|
| **Value chain** | ETH conservation: `address(trials).balance == totalStakes + totalPending + escrowed` | Conservation invariant (647), Solidity assert in settleBatch (648), nightly fuzz (532) |
| **Hash chain** | Trace spine: append-only JSONL segments, each segment's root hash embedded in the next header | Spine walk on boot (661), merkle spot-checks (662) |
| **EVM chain** | Chain state itself: block, logIndex, blockHash cursor | Cursor revalidation on boot (616), finality policy (659), reorg recovery (660) |

The invariant battery (666) runs nightly and publishes five numbers (613): false-pass %, kappa, spend vs budget, SSE p95, conservation checks. `/integrity` (667) publishes the results as a crawlable page. The proof that the chains don't break is itself a permanent, verifiable artifact.

---

## 3. Data, network, and security surface (614–623)

### Data layer
- Source of truth = the chain; everything else is projection.
- Spine: append-only JSONL segments (`data/spine/seg-NNNNNN.jsonl`), rotated at 16 MB or 100k spans; each segment's root hash embedded in the next header.
- SQLite WAL for queries; content-addressed eval cache; zod-validated config files.

### Projection schema (615)
`escrows`, `claims`, `verdicts`, `stake_ledger`, `fee_ledger`, `model_credits`, `probes_index`, `cursor_meta`. Every table's write path is the keeper and only the keeper (ties 445).

### Cursor spec (616)
`cursor = (block: bigint, logIndex: number, blockHash: string)`. Stored in `cursor_meta`, issued to SSE clients as opaque tokens; on boot the keeper revalidates the cursor against the blockHash before consuming (ties 659).

### Network map (618)
`443 public (nginx, TLS 1.3) → 3000 internal (Next.js SSR + GET-only API) → 8545 localhost-only (Anvil) → 5432 internal (Postgres, if fitted)`. The keeper is not a network service — it is a process with no inbound port.

### Anvil binding law (621)
Anvil binds `127.0.0.1`; the only process allowed to speak to it is the keeper. A grep-gate forbids any other module importing an RPC client (ties 493).

---

## 4. Cryptography — pre-quantum now, quantum-ready on-ramps (624–639)

### Primitives table (law)

| Primitive | Used for | Quantum impact | Verdict |
|-----------|----------|----------------|---------|
| keccak256 | on-chain hashes, promptHash, span chain | Grover: 256→128-bit | fine, documented |
| SHA-256 | off-chain content addressing (files, SBOMs) | Grover: 256→128-bit | fine |
| secp256k1 ECDSA | wallet txs, keeper EOA | Shor breaks it | chain-level, not ours to fix |
| EIP-712 | structured operator approvals | Shor | same surface as txs |
| TLS 1.3 (X25519 + AEAD) | edge transport | Shor breaks KEM | hybrid path (636) |
| age / secretbox | backups, seeds at rest | Shor breaks X25519 | hybrid path (636) |
| CSPRNG (`node:crypto`) | keys, nonces | fine | only source of randomness |
| JCS RFC 8785 | canonical hash inputs | none | locked suite |
| argon2id | N/A — no passwords by design | fine | documented N/A |

### Key rules
- **One crypto door** (625): every hash/encrypt/sign call site routes through `packages/crypto/`; grep-gate bans direct `crypto.createHash`/keccak imports elsewhere. This module is the PQC migration seam.
- **Key hierarchy, exactly three** (626): demo mnemonic (offline, sealed) → keeper hot EOA (env-injected credential) → provider API keys (per-model, scoped). Nothing else signs.
- **Keeper spend caps** (627): per-tx and per-hour caps enforced before signing; exceed → breaker, not a failed tx.
- **JCS everywhere** (629): every hashed JSON object canonicalized via RFC 8785 first.
- **Hybrid encryption for the long-lived** (636): `packages/crypto` ships hybrid AEAD (X25519 + ML-KEM-768, FIPS 203) behind a `longevity` flag; off for the Anvil demo, on for anything that must outlive the quantum horizon.
- **No homemade crypto** (638): only FIPS 203/204/205-referencing vetted libraries; hand-rolled lattice = automatic RFC rejection.
- **Query security** (639): DB user with zero write grants, zod-validated params, cursor pagination only, hard LIMIT caps, no raw SQL from request input.

---

## 5. Monetization & the reward system (640–655)

The flow table is the single economic source of truth (lives at `docs/economics.md`; Solidity + ledger tests generated against it; divergence = red build).

| Event | Moves | Notes |
|-------|-------|-------|
| Escrow opened | funder → escrow: `reward` | `msg.value == reward`, no ERC-20 |
| postWork accepted | escrow split: 85% worker-share / 15% fee-share | fee assessed & frozen here, moved at settle |
| Worker stakes | worker → escrow.stakes: `stake` | stake ≥ floor (642) |
| Settle on pass | worker ← 85% + stake back; feeVault ← 15% | gas shown separately, always |
| Settle on fail | funder ← full reward; stake slashed 50/50 | fee returns on fail |
| Deadline expiry | funder ← full refund (pull); worker ← stake back | pull pattern |
| Model credits payout | feeVault → registered operator wallet | batched, capped |

### Money rules
- **Boring money** (654): three numbers (escrow shares, stakes, feeVault). No token, no interest, no rebase, no lending, no vault yield. Anything new = RFC + new invariant proof.
- **Fee and gas are always separate lines** (641): "the network's toll vs the network's fuel."
- **Verification never costs the protocol more than the stake covers** (642): `stake ≥ k × (estimated verification cost: gas + model spend + probe amortization)`.
- **Model rewards flow to registered operator wallets** (651): models hold no keys; `model_credits` ledger funded by 2% of fee inflow.

---

## 6. Chain integrity battery (656–667)

| Control | What it does |
|---------|-------------|
| Idempotency (656) | Every state transition carries key `escrowId:phase:attempt`; replays dedupe |
| Outbox pattern (657) | span → outbox row → tx → ack; no dual-write |
| Serial nonce writer (658) | one nonce cache, receipt-wait between txs, zero parallel signing |
| Finality policy (659) | showtime: 1-conf safe; realism: depth-2; cursor stores blockHash |
| Reorg/wedge recovery (660) | cursor revalidated against blockHash; divergence rebuilds projection from spine |
| Spine walk on boot (661) | full prevHash + segment-root verification; corrupt segment halts startup |
| Evidence merkle check (662) | replayed verdict recomputes probe merkle root, must match on-chain event |
| Crash drill (663) | `kill -9` keeper mid-batch; boot recovers exactly-once |
| Anvil checkpoints (664) | `anvil_dumpState` after milestones; `anvil_loadState` restore <60s |
| Invariant battery (666) | nightly: conservation, spine walk, merkle checks, cursor continuity, ledger mirror |
| /integrity public (667) | publishes the five numbers, last run timestamp, spine head hash |

---

## 7. Agent & sandbox security (489–502)

Frontier models are **agents**, not adapters. They enter as config rows + dialect adapters; same proposal envelope, same sandbox, same breaker; zero extra effect surface.

```
config row (503) → dialect adapter (439) → sandbox supervisor (490)
  → egress proxy allowlist (491) → payload scrubber (506)
  → provider API → output contract (494) + refusal class (508)
  → content-addressed cache (510) → proposal envelope (489)
  → cascade / keeper decision (511–512) → spans to the spine (498)
```

Eleven stations, every one gated, every one span-logged.

### Key gates
- **Proposal envelope** (489): every agent emits `{type, payload, attestation, budget}` — a value object. Agents hold zero effectors: no chain signer, no fs, no arbitrary network.
- **Sandbox harness** (490): containerized, read-only rootfs, scratch tmpfs wiped per run, no capabilities, seccomp default-deny, CPU/mem/wall-clock caps.
- **Egress allowlist** (491): sandbox network = model endpoints via adapter proxy + internal probe-bank reads only; everything else denied.
- **Fixed toolset** (492): agents call only declared tools (`probe.fetch`, `claim.hash`, `score.submit`, `verdict.draft`), each schema-validated and logged as a span.
- **No-key law** (493): no private keys, no viem wallet client, no signer imports anywhere in the agent/harness module graph.
- **Output contract** (494): zod schema + size cap + JSON parse on every agent response; malformed = fail-closed, never retry-until-pass.
- **Retries are transport-only** (509): jittered backoff on 429/5xx/timeout only, idempotent via `(claimHash, model, promptVersion)` cache; never re-ask after a content response.
- **Judge-family independence** (511): the deciding judge must not share the contestant's provider family for the same verdict.
- **Shadow stays silent** (512): frontier shadow tier records proposals but never gates a settlement; non-authoritative by construction.
- **Frontier latency law** (513): p95 <20s applies to frontier too; timeout = deferral, never a blocked serial loop.

---

## 8. Adapter & producer discipline (439–448)

### Adapters — capped at 4 files
An adapter absorbs a **wire dialect**, not a model. A model is a config row; a prompt is a version; only a dialect is code.

| # | File | Absorbs |
|---|------|---------|
| 1 | `adapters/openai-compat.ts` | OpenAI wire dialect (GPT-5.x, OpenRouter, Groq, DeepSeek, …) |
| 2 | `adapters/anthropic.ts` | Messages API (Claude family) |
| 3 | `adapters/google.ts` | `generateContent` (Gemini family) |
| 4 | `adapters/stub.ts` | nothing — scripted fixtures for CI |

Adding a contestant to the Arena costs exactly one JSON row + RFC, zero code (440). A 5th adapter file requires an RFC naming the missing dialect (439).

### Producers — one door
Exactly one process writes the trace spine: the keeper (442). New observable behavior = a new span type, never a new stream/service/socket (443). Probe sources may multiply (`seed|ci|dispute|arena-break|shadow`) as append-only JSONL, schema-validated, deduped by probeHash, never writing chain/API/spine directly (447).

---

## 9. Compliance posture (ISO 27001-shaped, AI RMF, EU AI Act, SOC2-lite)

CRUCIBLE treats ISO 27001 and SOC 2 as **postures, not certificates** on an Anvil demo. What it builds is the evidence trail — controls mapped to frameworks, every control enforced by a gate, every gate testable in CI.

| Layer | OWASP | ISO 27001 | NIST / other | Gates |
|-------|-------|-----------|--------------|-------|
| Web surface | Top 10, ASVS L2 | A.5, A.8, A.9, A.14 | SSDF | 515–524, 545–550 |
| Contracts | SCSVS, SWC | A.8.9 | SSDF | 525–534 |
| Agents & LLMs | LLM Top 10 | A.5.19–5.22 | AI RMF, EU AI Act | 489–502, 503–514, 535–544 |
| Supply chain | A06/A08 | A.5.19–5.23 | SLSA, SBOM | 573–580 |
| Governance | LLM09 | A.5.1, A.16 | AI RMF, SOC2-lite | 563–572 |
| Ops & resilience | A09 | A.16–A.17 | CSF | 603–613 |

### AI governance specifics
- Warden classified as **limited-risk AI-assisted decision support** (567): final settlement authority is keeper + human via the dispute window.
- **Transparency duty** (568): verdicts disclose "decided by {model}@{snapshot}, disputed within {window}" on-chain and in UI.
- **Human oversight** (569): any disputed verdict reaches a human before final settlement, always.
- **Model card page** (514): which models, snapshots, roles, tournament standing, kappa + false-pass numbers, aggregate spend per stage — static, crawlable.

### SOC2-lite evidence (570)
Three trust criteria evidenced: security (this list), availability (SLOs + fallback), processing integrity (conservation invariant + hash chain).

---

## 10. Incident response & drills (603–613)

### SLOs (603)
SSE p95 <2s, API p99 <150ms, keeper inclusion <3s (showtime), verdict p95 <20s, demo-window uptime 99.9%.

### First-response card (607)
Breaker first → snapshot spine tail second → stub repro third → fix fourth: "money stops before debugging."

### Drill calendar (609)
Monthly breaker drill, monthly restore drill, full rehearsal within 7 days of any demo.

### Incident severities (608)
S1 breaker/integrity breach; S2 realtime down >2min; S3 degraded tier; S4 cosmetic.

### Runbooks (602)
One ≤1-page runbook per component (keeper restart, breaker drill, SSE catch-up, model failover, Anvil seed-restore), tested in drills.

---

## 11. The five numbers (613)

Reviewed weekly. Any drift opens an RFC:

1. **false-pass %** — protocol bleed, dollars (Arena gate: ≤1% hard disqualifier)
2. **kappa** — judge quality vs human gold
3. **spend vs budget** — model spend caps (505)
4. **SSE p95** — realtime delivery (519)
5. **conservation checks** — ETH invariant (647)

---

## 12. The hall of shame (612)

The never-list, grep-able:

- second chain writer · second SSE stream / WebSocket · new adapter file for a model · agent-held key · write endpoint · unbounded queue · retry-until-pass · embedded commercial audio · upgrade key · timestamp-scored verdict · parallel indexer · secret in client · `dangerouslySetInnerHTML`

### The one addition since, and why it is not the list

The speech-to-speech host (ADR-0018) added three write routes — open a session,
read it, send a turn. They are named here so nobody has to infer them:

- **They write no chain state.** The API holds no chain key (ADR-0006) and a
  session is an in-memory ledger entry. Nothing a caller posts can move ETH.
- **They open no stream.** The exchange is one request and one response over the
  ordinary HTTP the rest of the API uses; the turn monitor polls the phase. The
  list's "second SSE stream / WebSocket" still stands.
- **They spend provider credits, so they are bounded rather than open.** Twenty
  turns a minute, 256 KiB of audio a turn, forty turns a session, fifty sessions
  a host, a thirty-minute idle TTL, and a body ceiling that is **per path** so
  the utterance's size does not raise the limit for every other route. The
  "unbounded queue" in the list is the thing these numbers refuse.
- **The microphone is opened on one route.** `microphone=()` on every page and
  `microphone=(self)` on `/voice` alone.


---

## 13. Honest limits

- No professional audit, no formal verification, no bug bounty (SECURITY.md).
- The demo chain is Anvil ETH, worthless; the UI states this on screen.
- `npm run demo` uses Anvil's published development mnemonic — never reuse for a real network.
- This is not a KYC/AML, payments, or custody product and must not be described as one.

The cheatsheet ends where the system started: **the list is the system.**
