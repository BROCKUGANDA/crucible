# Agent security

Controls for running autonomous agents that hold keys. An agent that can sign for a
wallet is not a chatbot, and the security posture has to reflect that.

The organising idea: **a control nobody can bypass is worth more than ten controls
someone can route around.** Every privileged path is one call deep, in
`AgentOrchestrator.invoke()`, and the runner's `step()` receives a guarded toolbox rather
than a raw tool object. There is no back door into a capability.

## What is enforced, and how it is tested

| Control | Mechanism |
|---|---|
| Credentialing | Scoped, expiring, revocable, single-use-nonce credentials; secrets hashed at issue and never stored |
| Role-based access | RBAC with a fixed role matrix; scope checks at every call |
| Identity attestation | ERC-8004 `ReputationBridge`; the *reporter* is the contract, never the operator |
| Tool allow-listing | Deny-by-default; a tool must be registered **and** granted |
| Plugin sandboxing | Per-tool target allow-lists and per-session call ceilings, re-checked on every call |
| API rate limiting | Token bucket per principal, with a burst allowance |
| Output validation | Schema validation; malformed output is rejected, never coerced |
| Input sanitisation | Control-character stripping, CRLF normalisation, length caps, fence removal |
| Instruction boundary guard | Untrusted content wrapped in a nonced data-only region |
| Jailbreak detection | 10 pattern families: role-hijack, override, exfiltration, authority claims, encoded payloads, fence breaks |
| Indirect injection filters | Retrieved content (HTML, stdout, files) scanned; hidden HTML carriers escalated |
| Context window isolation | Per-session scoping; writes across a closed session throw |
| Memory poisoning guard | Provenance-tagged memory; inference may never overwrite a chain fact; poisoned records dropped from context |
| Session scoping | Tenant isolation; a session that never opened cannot be read or written |
| Sensitive data masking | Masked *before* anything is persisted, including free text |
| Agent-to-agent auth | Sealed envelopes with HMAC, expiry and single-use nonces |
| Trust chain verification | Delegation depth capped at 3; scopes must stay a subset of the parent at every hop |
| Orchestrator hardening | 12 ordered checks; cheap structural rejections first, crypto last |
| Delegation policy | A credential can only ever hold permissions its parent held |
| Human-in-the-loop approval | Risk-routed; **fails closed** when the reviewer errors |
| Action scope limiting | Resource prefixes, value ceilings, hourly action caps |
| Rollback and undo | Compensating actions, LIFO unwind; never a pretend undo of an on-chain tx |
| Least-privilege execution | Requested scopes intersected with what the role may hold |
| Agent action logging | Hash-chained audit log; secrets masked at write time |
| Trace and replay | Ordered narration of an agent's session, reconstructed from the log alone |
| Anomaly detection | Burst, novel-action, failure-loop, off-hours, scope-creep |
| Real-time alerting | Severity-mapped; a failing alert sink never takes down the caller |
| AI policy enforcement | Declarative rules as data, so a policy change is a reviewable diff |
| Regulatory mapping | EU AI Act / SOC 2 / GDPR / NIST AI RMF references to the control that satisfies each |
| Risk assessment | Conservative scoring; unknown values score as risky, because a false negative is a drained wallet |
| Incident forensics | Hash-chained reports with evidence digests and escalation candidates |

## The three rules that are structural, not conventional

**1. No principal can hold `reputation:write`.** Not in any baseline role, not by
grant. `FORBIDDEN_PERMISSIONS` rejects it at issuance. ERC-8004 forbids it too — "the
feedback submitter MUST NOT be the agent owner" — and an agent that grades itself makes
the verification premise worthless.

**2. Delegation cannot deepen.** `issue({ delegatedFrom })` refuses any scope the parent
did not hold. Without this, an agent with `admin:policy` could mint itself an operator
and there would be no boundary at all.

**3. The judge cannot be the judged.** `checkSeparationOfDuties` blocks the sponsor and
the assigned agent from adjudicating their own trial, and restricts voting to Argus
seats and admins. This is what keeps the 2-of-3 commit-reveal from being theatre.

## Example

```ts
const credentials = new CredentialAuthority();
credentials.registerPrincipal({ id: "agent:operator", kind: "agent", role: "operator" });
const { credential, secret } = credentials.issue({ principalId: "agent:operator" });

const orch = new AgentOrchestrator({
  credentials,
  toolbox,          // deny-by-default, with per-tool allow-lists
  scopeLimiter: new ScopeLimiter({ maxValueWei: 10n ** 18n }),
  sessions,         // per-tenant isolation
  audit: new AuditLog(),          // hash-chained
  rateLimiter: new RateLimiter(),
  approvals: new ApprovalQueue(async (r) => askHuman(r), 20),
  rollbacks: new RollbackRegistry(),
});

const out = await orch.invoke({
  guard: { principal, credentialId: credential.id, secret, sessionId },
  tool: "write_file",
  input: { target: "/work/Vault.sol" },
  permission: "trial:run",
  outputSchema: { type: "object", properties: { ok: { type: "boolean", required: true } } },
});
// out.ok === false with a reason and a DenialCode, or the tool's validated output
```

## Two design decisions worth arguing about

**Prompt-injection scanning is not the primary control.** It is broad and
high-recall, and it *will* have false positives. That is why untrusted content is also
structurally wrapped in a data-only region with a nonce the model has no reason to know,
and why the agent's output is validated and its authority claims checked. The scan is
defence in depth, not the wall. The wall is that a sponsor's spec never reaches the
system prompt.

**Policy blocks what a human must not be able to authorise; risk routes what they
should.** An earlier draft hard-denied anything over 1 ETH in the policy engine. That was
wrong: it made the human-approval path unreachable for exactly the actions that most
need it, so a large but legitimate withdrawal was impossible rather than supervised.
High value now escalates to a human; policy is reserved for self-attestation and
self-adjudication.

## Testing

```bash
npm test --workspace @crucible/agent-security    # 129 tests
```

Every control above has at least one test that proves it *refuses*, not just one that
proves the happy path. A security control with no failing test is a comment.

MIT.
