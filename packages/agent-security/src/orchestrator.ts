import { CredentialAuthority } from "./credentials.js";
import { ScopeLimiter, Toolbox } from "./toolbox.js";
import { SessionScope, scanRetrieved, wrapUntrusted } from "./injection.js";
import { checkAuthorityClaims, sanitizeInput, validateOutput, type FieldSchema } from "./validation.js";
import {
  AlertManager,
  AuditLog,
  CRUCIBLE_POLICIES,
  PolicyEngine,
  RateLimiter,
  assessRisk,
} from "./audit.js";
import type { ApprovalRequest, Decision, Permission, Principal, ToolPolicy } from "./types.js";

/**
 * Human-in-the-loop approval, rollback, and the orchestrator.
 *
 * Rollback matters more here than in most systems, because the thing being protected is
 * an agent holding a wallet. A reversible action that nobody thought to make reversible
 * is a lost bond.
 */

export class ApprovalQueue {
  private readonly pending = new Map<string, ApprovalRequest>();

  constructor(
    private readonly reviewer: (req: ApprovalRequest) => Promise<{ approved: boolean; by?: string; reason?: string }>,
    private readonly autoApproveBelow: number = 20,
  ) {}

  async request(req: Omit<ApprovalRequest, "status" | "requestedAt">): Promise<ApprovalRequest> {
    const full: ApprovalRequest = { ...req, status: "pending", requestedAt: Date.now() };

    if (full.risk.score < this.autoApproveBelow) {
      full.status = "auto-approved";
      this.pending.set(full.id, full);
      return full;
    }

    this.pending.set(full.id, full);
    if (full.expiresAt <= Date.now()) {
      full.status = "expired";
      return full;
    }

    try {
      const result = await this.reviewer(full);
      full.status = result.approved ? "approved" : "denied";
      if (result.by) full.decidedBy = result.by;
      full.decidedAt = Date.now();
      full.reason = result.reason;
    } catch {
      // a failing reviewer must fail closed, not open
      full.status = "denied";
      full.reason = "reviewer unavailable — failing closed";
    }
    return full;
  }

  get(id: string): ApprovalRequest | undefined {
    return this.pending.get(id);
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()];
  }

  isApproved(id: string): boolean {
    const r = this.pending.get(id);
    return r?.status === "approved" || r?.status === "auto-approved";
  }
}

export interface CompensatingAction {
  description: string;
  execute: () => Promise<void>;
}

/**
 * Rollback registry.
 *
 * Only *compensating* actions, never a true undo — on-chain you cannot un-send a
 * transaction. A compensation that is not itself dangerous must be registered before
 * the forward action runs, because afterwards it may be impossible to construct.
 */
export class RollbackRegistry {
  private readonly stacks = new Map<string, CompensatingAction[]>();

  push(scope: string, action: CompensatingAction): void {
    const stack = this.stacks.get(scope) ?? [];
    stack.push(action);
    this.stacks.set(scope, stack);
  }

  /** Run compensations in reverse order, LIFO — the standard unwind order. */
  async rollback(scope: string): Promise<{ executed: number; failed: string[] }> {
    const stack = this.stacks.get(scope) ?? [];
    const failed: string[] = [];
    let executed = 0;

    for (const action of stack.reverse()) {
      try {
        await action.execute();
        executed += 1;
      } catch (err) {
        failed.push(`${action.description}: ${(err as Error).message}`);
      }
    }
    this.stacks.delete(scope);
    return { executed, failed };
  }

  depth(scope: string): number {
    return this.stacks.get(scope)?.length ?? 0;
  }
}

export interface OrchestratorDeps {
  credentials: CredentialAuthority;
  toolbox: Toolbox;
  scopeLimiter: ScopeLimiter;
  sessions: SessionScope;
  audit: AuditLog;
  rateLimiter: RateLimiter;
  approvals: ApprovalQueue;
  rollbacks: RollbackRegistry;
  policy?: PolicyEngine;
  alerts?: AlertManager;
  detector?: import("./audit.js").AnomalyDetector;
  /** hook for the owner to observe decisions */
  onDecision?: (d: { principalId: string; action: string; decision: Decision }) => void;
}

export interface GuardedCall {
  principal: Principal;
  credentialId: string;
  secret: string;
  sessionId: string;
}

/**
 * The orchestrator.
 *
 * Every privileged path in an agent system should be exactly one call deep, here, and
 * the order of the checks matters: cheap structural rejections first, expensive
 * cryptographic ones last, and the audit entry written *before* the action so that a
 * crash mid-action still leaves a record.
 */
export class AgentOrchestrator {
  private readonly policy: PolicyEngine;

  constructor(private readonly deps: OrchestratorDeps) {
    this.policy = deps.policy ?? new PolicyEngine(CRUCIBLE_POLICIES);
  }

  /** The complete gate. Returns the tool output or an explicit refusal. */
  async invoke(args: {
    guard: GuardedCall;
    tool: string;
    input: Record<string, unknown>;
    permission: Permission;
    valueWei?: bigint;
    outputSchema?: FieldSchema;
    reversible?: boolean;
  }): Promise<{ ok: true; output: unknown } | { ok: false; reason: string; code?: string }> {
    const { principal, sessionId } = args.guard;
    const log = (decision: Decision, action = `tool:${args.tool}`, metadata: Record<string, unknown> = {}) => {
      this.deps.audit.append({
        principalId: principal.id,
        action,
        resource: String(args.input.target ?? args.input.url ?? sessionId),
        decision,
        metadata,
      });
      this.deps.onDecision?.({ principalId: principal.id, action, decision });
    };

    const deny = (decision: Decision & { allow: false }): { ok: false; reason: string; code?: string } => {
      log(decision);
      this.deps.detector?.observe({ action: `tool:${args.tool}`, allowed: false, at: Date.now() });
      void this.deps.alerts?.raise(
        this.deps.detector?.observe({ action: `tool:${args.tool}`, allowed: false, at: Date.now() }) ?? [],
      );
      return { ok: false, reason: decision.reason, code: decision.code };
    };

    // 1. session must be open — no cross-tenant bleed
    const sessionCheck = this.deps.sessions.check(sessionId);
    if (!sessionCheck.allow) {
      return deny({ allow: false, reason: sessionCheck.reason, code: "session-scope" });
    }

    // 2. rate limit, before any crypto
    const rate = this.deps.rateLimiter.tryConsume(principal.id);
    if (!rate.allow) return deny(rate);

    // 3. credential: secret, expiry, revocation, replay
    const auth = this.deps.credentials.verify({
      credentialId: args.guard.credentialId,
      secret: args.guard.secret,
      consumeNonce: true,
    });
    if (!auth.allow) return deny(auth);

    const credential = this.deps.credentials
      .listCredentials(principal.id)
      .find((c) => c.id === args.guard.credentialId);
    if (!credential) return deny({ allow: false, reason: "credential not found", code: "no-credential" });

    // 4. the credential must actually hold the requested permission
    if (!credential.scopes.includes(args.permission)) {
      return deny({
        allow: false,
        reason: `credential lacks ${args.permission}`,
        code: "wrong-scope",
      });
    }

    // 5. delegation chain intact
    const chain = this.deps.credentials.checkDelegationChain(args.guard.credentialId);
    if (!chain.allow) return deny(chain);

    // 6. separation of duties
    const sod = CredentialAuthority.checkSeparationOfDuties({
      principal,
      permission: args.permission,
      resourceOwnerId: args.input.sponsorId as string | undefined,
      resourceOperatorId: args.input.operatorId as string | undefined,
    });
    if (!sod.allow) return deny(sod);

    // 7. action scope, against concrete arguments
    const scope = this.deps.scopeLimiter.check({
      principalId: principal.id,
      resource: String(args.input.target ?? args.input.resource ?? sessionId),
      valueWei: args.valueWei,
    });
    if (!scope.allow) return deny(scope);

    // 8. risk, then policy
    const toolPolicy = this.deps.toolbox.policyFor(args.tool);
    const risk = assessRisk({
      permission: args.permission,
      valueWei: args.valueWei,
      toolRiskWeight: toolPolicy?.riskWeight,
      isReversible: args.reversible,
      touchesExternalSystem: Boolean(args.input.url),
      historyDenied: this.deps.audit.query({ principalId: principal.id, onlyDenied: true }).length,
    });

    const policy = this.policy.evaluate(
      {
        principalId: principal.id,
        permission: args.permission,
        resource: String(args.input.target ?? sessionId),
        args: { ...args.input, valueWei: args.valueWei?.toString() },
        at: Date.now(),
      },
      risk,
    );
    if (!policy.allow) return deny(policy);

    // 9. human approval
    if (risk.requiresHumanApproval) {
      const request = await this.deps.approvals.request({
        id: `appr_${sessionId}_${args.tool}_${Date.now()}`,
        principalId: principal.id,
        action: `tool:${args.tool}`,
        resource: String(args.input.target ?? ""),
        risk,
        expiresAt: Date.now() + 300_000,
      });
      if (request.status !== "approved" && request.status !== "auto-approved") {
        log(
          { allow: false, reason: `human ${request.status}`, code: "approval-denied" },
          `tool:${args.tool}`,
          { approvalId: request.id, riskScore: risk.score },
        );
        return { ok: false, reason: `human ${request.status}`, code: "approval-denied" };
      }
    }

    // 10. the tool call itself, through the toolbox's own allow-lists
    const result = await this.deps.toolbox.call({
      principal,
      credentialScopes: credential.scopes,
      tool: args.tool,
      input: args.input,
      sessionId,
      risk,
      // the approval step above already ran (or was not required)
      approvalAlreadySatisfied: true,
      approval: async (r) => this.deps.approvals.isApproved(r.id),
    });
    if (!result.ok) {
      return deny({ allow: false, reason: result.reason, code: "blocked-tool" });
    }

    // 11. output validation — the agent cannot return junk
    if (args.outputSchema) {
      const validation = validateOutput(result.output, args.outputSchema);
      if (!validation.valid) {
        return deny({
          allow: false,
          reason: `output rejected: ${validation.issues[0]?.message}`,
          code: "output-rejected",
        });
      }
    }

    // 12. the agent may not claim authority it was never given
    const claim = checkAuthorityClaims({
      claimed: (result.output as { claimed?: { scopes?: Permission[]; targets?: string[] } } | undefined)?.claimed ?? {},
      granted: { scopes: credential.scopes, targets: [] },
    });
    if (!claim.allow) return deny(claim);

    log({ allow: true, reason: "all controls passed" }, `tool:${args.tool}`, {
      riskScore: risk.score,
      riskLevel: risk.level,
    });

    return { ok: true, output: result.output };
  }

  /** Untrusted text entering the system: sanitise, scan, wrap. */
  ingestUntrusted(source: string, content: string): { text: string; blocked: boolean; findings: number } {
    const sanitized = sanitizeInput(content);
    const scan = scanRetrieved({ source, content: sanitized });
    const wrapped = wrapUntrusted({ source, content: sanitized });
    this.deps.audit.append({
      principalId: "system",
      action: "ingest:untrusted",
      resource: source,
      decision:
        wrapped.scan.clean
          ? { allow: true, reason: "untrusted content wrapped" }
          : { allow: false, reason: "injection pattern detected", code: "injection-detected" },
      metadata: { findings: wrapped.scan.findings.length, action_taken: wrapped.scan.action },
    });
    return {
      text: wrapped.text,
      blocked: wrapped.scan.action === "reject",
      findings: wrapped.scan.findings.length,
    };
  }
}

export function defaultToolPolicies(): ToolPolicy[] {
  return [
    {
      name: "read_file",
      requiredScopes: ["trial:run"],
      allowedTargets: ["/work/", "./"],
      riskWeight: 2,
    },
    {
      name: "write_file",
      requiredScopes: ["trial:run"],
      allowedTargets: ["/work/", "./"],
      maxCallsPerSession: 200,
      riskWeight: 5,
    },
    {
      name: "run_suite",
      requiredScopes: ["trial:run"],
      maxCallsPerSession: 20,
      riskWeight: 8,
    },
    {
      name: "fetch_ipfs",
      requiredScopes: ["trial:run"],
      allowedTargets: ["ipfs://", "https://gateway."],
      maxCallsPerSession: 20,
      riskWeight: 6,
    },
    {
      name: "submit_run",
      requiredScopes: ["trial:run"],
      riskWeight: 25,
      alwaysNeedsApproval: true,
    },
    {
      name: "call_external_api",
      requiredScopes: ["trial:run"],
      riskWeight: 20,
      alwaysNeedsApproval: true,
    },
  ];
}
