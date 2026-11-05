# Runbook: emergency intake control

**Purpose:** Stop new trials from being created or funded through the API, without blocking existing participants' settlement or withdrawal rights.  
**Status:** implemented at the API layer (kill switch); on-chain contracts are unchanged and cannot be paused.  
**Chain:** any — local Anvil, testnet, or mainnet. The control is off-chain and holds no keys.

---

## Why this exists

Memo §2: an off-chain emergency intake control must be able to stop new trials without blocking existing participants' settlement or withdrawal rights.

The contracts deliberately have **no pause, no upgrade, and no admin recovery** (incident-response.md §"Contract bug or stuck funds"). The owner cannot move escrowed ETH, a bond, or a break stake. So an emergency control that freezes the contracts would lock funds — that is not acceptable. The control therefore lives entirely off-chain, in the API, and it only blocks the intake path (`createTrial`, and other mutating writes). Settlement, `finalize`, `reclaimExpired`, and `withdraw` are never blocked.

---

## What is implemented

**Kill switch** (`packages/agent-security/src/kill-switch.ts`, mounted in `apps/api/src/app.ts`):

- Middleware on `app.use("*", ...)` blocks `POST`/`PUT`/`PATCH`/`DELETE` when `isBlocked("new_evaluation")` is true, returning `503 kill_switch_enabled`.
- `isBlocked(action)` explicitly returns `false` for `withdraw`, `finalize`, and `reclaim` — settlement actions are never blocked.
- State is in-memory (`globalThis`, consistent with ADR-0008). Fails closed: when the store is unavailable, new risky work is rejected; settlement never depends on the store.
- Full append-only history (`actor`, `action`, `reason`, `previous`, `next`) is kept for audit.

**What it can do:** stop the API from accepting new trial creation, claims, breaks, and other mutating off-chain work.  
**What it cannot do:** move funds, change fees, alter the conservation invariant, pause contracts, or reverse a settlement. The API holds no chain key (ADR-0006), so it cannot submit transactions on anyone's behalf regardless.

---

## When to use it

| Situation | Action |
|---|---|
| Suspected contract bug or exploit in flight | Enable the kill switch to stop new intake while you assess; settlement and withdrawal keep working. |
| Compromised deployer/owner key | Enable the kill switch, then follow incident-response.md key compromise. |
| Indexer or RPC degradation causing bad read model | Enable the kill switch to prevent new trials off stale data; re-enable when the read model is healthy. |
| Routine maintenance | Not required — enable only for an active incident. |

Do **not** use the kill switch as a routine pause for upgrades; there is no upgrade path, and a pause that outlasts the incident only blocks intake, never fixes the contract.

---

## How to enable / disable

The kill switch is controlled through `packages/agent-security/src/kill-switch.ts`:

```ts
import { enable, disable, status, history } from "@crucible/agent-security";

// Enable (operator + reason recorded)
enable("platform-operator-oncall", "suspected contract defect; see INC-2026-11-05-01");

// Read status
status(); // { enabled, enabledAt, enabledBy, reason, historyCount }

// Full audit trail
history();

// Disable (recovery; preferably the same actor or a platform operator)
disable("platform-operator-oncall", "incident resolved; contract audited and redeployed");
```

There is **no HTTP endpoint** to toggle the kill switch in this release. It is toggled by an operator with access to the API host (or a future admin sub-app). Record the actor, reason, and resulting `enabledAt` in the incident notes.

**Disable requires care:** prefer the same actor who enabled it, or a platform operator. Re-enabling intake before a contract defect is understood risks new trials on faulty code.

---

## What stays available while intake is stopped

| Path | Blocked? | Notes |
|---|---|---|
| `POST /trials/new` (`createTrial`) | Yes | New intake stopped |
| `POST /forge` (`registerAgent`, `claimTrial`) | Yes | New agent/claim activity stopped |
| `POST /trials/[id]` (`fileBreak`) | Yes | New breaks stopped |
| `GET /trials/:id`, `/hall`, `/escrow/:wallet` | No | Read-only views keep working |
| `withdraw()` on-chain | No | Participants pull their own credits |
| `finalize` / `reclaimExpired` on-chain | No | Permissionless settlement keeps working |
| Argus `commitVote` / `revealVote` | No (on-chain) | Disputes can still be adjudicated |

Existing participants can still settle and withdraw. New trials cannot be created through the API; a determined actor can still call contracts directly, but direct contract calls cannot move funds unfairly (conservation invariant, pull-only settlement).

---

## What to do after enabling

1. **Record an incident** (`packages/agent-security/src/incident.ts`): sev1 for a suspected escrow/exploit, sev2 for infra degradation. Follow incident-response.md.
2. **Preserve evidence:** transaction hashes, block numbers, `/health`/`/ready`, container logs, host crontab.
3. **Assess on-chain state:** confirm the conservation invariant holds (`invariant_balanceConservation`), check `credit[]` ledger and `VerdictFinalized` events.
4. **Decide the path forward:** contract bug → redeploy + migrate (old escrow's funds stay under old code); infra issue → restore the read model, then disable the kill switch.
5. **Publish a post-mortem:** what changed, what was observed, what remains open. Add a regression test for any code fix.

---

## What is not yet implemented (open)

| Item | Why it matters | Where it tracks |
|---|---|---|
| HTTP admin endpoint to toggle the kill switch | Operators currently need host access; a gated endpoint would be faster and auditable | `apps/api/src/app.ts` |
| Durable / multi-process kill-switch state | In-memory state resets on restart; a multi-process deployment needs a shared backing store | ADR-0008, `packages/agent-security/src/kill-switch.ts` |
| "new_trial" intake category | Currently one category (`new_evaluation`) blocks all mutating writes; a dedicated trial category is more precise | `kill-switch.ts` `isBlocked` union type |
| Timelock for privileged configuration changes | Memo §2 production architecture; no timelock contract exists yet | ADR-0020 mainnet release gate (proposed) |
| Multisig-controlled owner/treasury Safe | ADR-0020/0021 proposed, on a feature branch, not merged or audited | `docs/adr/0020-*`, `0021-*` |

---

## Related

- `docs/runbooks/incident-response.md` — key compromise, contract bug, stuck funds
- `docs/key-inventory.md` — every key and what a compromise reaches
- `docs/adr/0003-pull-payments.md` — settlement never pushes ETH
- `docs/adr/0006-wallet-signed-api-no-chain-keys.md` — API holds no chain key
- `docs/adr/0008-in-memory-indexer.md` — in-memory state rationale
