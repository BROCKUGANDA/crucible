import { CredentialAuthority } from "./credentials.js";
import type { LogInput } from "./audit.js";
import type {
  ApprovalRequest,
  Decision,
  Permission,
  Principal,
  RiskAssessment,
  ToolPolicy,
} from "./types.js";

/**
 * The guard: one choke point every agent action must pass through.
 *
 * The design principle is that a control nobody can bypass is worth more than ten
 * controls someone can route around. Everything here is enforced by the caller
 * having no choice but to ask — the runner's `step()` receives a `GuardedToolbox`, not
 * a raw tool object, so there is no privileged path into a capability.
 */

/**
 * Tool allow-listing and plugin sandboxing.
 *
 * An agent can only call tools it declared, and each tool carries its own scope
 * requirements and hard target limits. "Hard" means the limit is checked on every
 * call, not established at registration — a policy that can drift at runtime is not a
 * sandbox.
 */
export class Toolbox {
  private readonly policies = new Map<string, ToolPolicy>();
  private readonly granted = new Map<string, Set<string>>();
  private readonly calls = new Map<string, number>();

  constructor(private readonly tools: {
    invoke(name: string, args: Record<string, unknown>): Promise<unknown>;
  }) {}

  /** Register a tool. An undeclared tool is un-callable, by construction. */
  register(policy: ToolPolicy): void {
    if (this.policies.has(policy.name)) {
      throw new Error(`tool ${policy.name} already registered`);
    }
    this.policies.set(policy.name, policy);
  }

  /** Grant an agent a tool. Narrow by default: nothing is granted implicitly. */
  grant(principalId: string, toolName: string): void {
    if (!this.policies.has(toolName)) throw new Error(`unknown tool ${toolName}`);
    const set = this.granted.get(principalId) ?? new Set<string>();
    set.add(toolName);
    this.granted.set(principalId, set);
  }

  revoke(principalId: string, toolName: string): void {
    this.granted.get(principalId)?.delete(toolName);
  }

  listFor(principalId: string): string[] {
    return [...(this.granted.get(principalId) ?? [])];
  }

  /** The registered policy for a tool, so the orchestrator can read its risk weight. */
  policyFor(name: string): ToolPolicy | undefined {
    return this.policies.get(name);
  }

  /**
   * Invoke a tool through the full guard chain. This is the only path to a capability.
   */
  async call(args: {
    principal: Principal;
    credentialScopes: readonly Permission[];
    tool: string;
    input: Record<string, unknown>;
    sessionId: string;
    /** the caller's pre-computed risk assessment, if any */
    risk?: RiskAssessment;
    approval?: (r: ApprovalRequest) => Promise<boolean>;
    /**
     * The caller has already routed this action through its own approval queue.
     *
     * Without this the toolbox would raise a *second* approval under its own request
     * id, which the caller's queue has never seen — so an action a human just approved
     * would be denied by a request nobody was ever shown.
     */
    approvalAlreadySatisfied?: boolean;
    onLog?: (e: LogInput) => void;
  }): Promise<{ ok: true; output: unknown } | { ok: false; reason: string }> {
    const policy = this.policies.get(args.tool);

    if (!policy) {
      return { ok: false, reason: `tool ${args.tool} is not registered — allow-listing is deny-by-default` };
    }
    if (!this.granted.get(args.principal.id)?.has(args.tool)) {
      return { ok: false, reason: `${args.principal.id} has not been granted ${args.tool}` };
    }

    // the tool's own scope requirements are non-negotiable
    const held = new Set(args.credentialScopes);
    const missing = policy.requiredScopes.filter((s) => !held.has(s));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `credential lacks required scope(s): ${missing.join(", ")}`,
      };
    }

    // target allow-list, checked per call
    if (policy.allowedTargets) {
      const target = String(args.input.target ?? args.input.url ?? "");
      const ok = policy.allowedTargets.some((prefix) => target.startsWith(prefix));
      if (!ok) {
        return { ok: false, reason: `target "${target}" is outside this tool's allow-list` };
      }
    }

    // per-session call ceiling
    const key = `${args.sessionId}:${args.tool}`;
    const used = this.calls.get(key) ?? 0;
    if (policy.maxCallsPerSession !== undefined && used >= policy.maxCallsPerSession) {
      return {
        ok: false,
        reason: `tool ${args.tool} hit its session ceiling of ${policy.maxCallsPerSession}`,
      };
    }
    this.calls.set(key, used + 1);

    // human approval, driven by the risk score
    const risk = args.risk;
    const needsApproval = !args.approvalAlreadySatisfied &&
      (policy.alwaysNeedsApproval || Boolean(risk?.requiresHumanApproval));
    if (needsApproval && args.approval) {
      const request: ApprovalRequest = {
        id: `appr_${args.sessionId}_${args.tool}_${used}`,
        principalId: args.principal.id,
        action: `tool:${args.tool}`,
        resource: String(args.input.target ?? args.input.url ?? ""),
        risk: risk!,
        requestedAt: Date.now(),
        expiresAt: Date.now() + 300_000,
        status: "pending",
      };
      const approved = await args.approval(request);
      request.status = approved ? "approved" : "denied";
      args.onLog?.({
        principalId: args.principal.id,
        action: `tool:${args.tool}`,
        resource: request.resource,
        decision: approved
          ? { allow: true, reason: "human approved" }
          : { allow: false, reason: "human denied", code: "approval-denied" },
        metadata: { approvalId: request.id },
      });
      if (!approved) return { ok: false, reason: `human denied ${args.tool}` };
    }

    const output = await this.tools.invoke(args.tool, args.input);
    return { ok: true, output };
  }

  resetSession(sessionId: string): void {
    for (const key of [...this.calls.keys()]) {
      if (key.startsWith(`${sessionId}:`)) this.calls.delete(key);
    }
  }
}

/**
 * Action scope limiting: an agent may only do what its delegation explicitly covers,
 * checked against concrete arguments rather than intent.
 */
export class ScopeLimiter {
  constructor(
    private readonly limits: {
      maxValueWei?: number;
      allowedResources?: string[];
      maxActionsPerHour?: number;
    } = {},
  ) {}

  private readonly window = new Map<string, number[]>();

  check(args: {
    principalId: string;
    resource: string;
    valueWei?: bigint;
    now?: number;
  }): Decision {
    const now = args.now ?? Date.now();

    if (this.limits.allowedResources) {
      const ok = this.limits.allowedResources.some((p) => args.resource.startsWith(p));
      if (!ok) {
        return {
          allow: false,
          reason: `resource "${args.resource}" is outside the delegated scope`,
          code: "action-scope-exceeded",
        };
      }
    }

    if (this.limits.maxValueWei !== undefined && args.valueWei !== undefined) {
      if (args.valueWei > BigInt(this.limits.maxValueWei)) {
        return {
          allow: false,
          reason: `value ${args.valueWei} exceeds the delegated ceiling ${this.limits.maxValueWei}`,
          code: "action-scope-exceeded",
        };
      }
    }

    if (this.limits.maxActionsPerHour !== undefined) {
      const recent = (this.window.get(args.principalId) ?? []).filter(
        (t) => now - t < 3_600_000,
      );
      if (recent.length >= this.limits.maxActionsPerHour) {
        return {
          allow: false,
          reason: `hourly action ceiling of ${this.limits.maxActionsPerHour} reached`,
          code: "action-scope-exceeded",
        };
      }
      recent.push(now);
      this.window.set(args.principalId, recent);
    }

    return { allow: true, reason: "within delegated scope" };
  }
}

/** Least-privilege execution: strip a principal down to what it needs. */
export function leastPrivilegeScopes(
  role: Principal["role"],
  requested: Permission[],
): Permission[] {
  const allowed = CredentialAuthority.roleMayHold;
  return [...new Set(requested)].filter((p) => allowed(role, p));
}
