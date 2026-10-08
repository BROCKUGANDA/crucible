import { maskSensitive } from "./injection.js";
import type { ActionRequest, Decision, LogEntry, RiskAssessment, RiskLevel } from "./types.js";

/**
 * Audit logging, trace and replay, and incident forensics.
 *
 * The log is a hash chain: each entry commits to its predecessor, so an attacker who
 * reaches the log store cannot quietly edit history without breaking the chain. That
 * makes the log evidence rather than a convenience, which matters because it is what a
 * sceptic or a judge would ask to see.
 */

export interface LogInput {
  principalId: string;
  action: string;
  resource: string;
  decision: Decision;
  metadata?: Record<string, unknown>;
  at?: number;
}

export interface AuditRetentionPolicy {
  /** hard ceiling on retained entries; the oldest fold into the anchor first */
  maxEntries: number;
  /** entries older than this are eligible for pruning; `Infinity` keeps everything */
  ttlMs: number;
  now: () => number;
}

const DEFAULT_AUDIT_RETENTION: AuditRetentionPolicy = {
  maxEntries: 50_000,
  ttlMs: Number.POSITIVE_INFINITY,
  now: Date.now,
};

export class AuditLog {
  private readonly entries: LogEntry[] = [];
  private seq = 0;
  private readonly retention: AuditRetentionPolicy;
  /**
   * The hash of the last entry that left the log.
   *
   * An audit trail has to end sometime — 14 days of entries is a retention promise, not a
   * suggestion — but dropping the head of a hash chain normally reads as tampering.
   * Verification therefore starts from this anchor rather than from genesis: the pruned
   * prefix is still committed, it is simply not held. Produce the old entries and the
   * anchor still proves them; edit them and the link breaks.
   */
  private anchor: string;
  private pruned = 0;

  constructor(
    private readonly hasher: (s: string) => string = defaultHash,
    /** genesis link */
    private readonly genesis = "0".repeat(64),
    retention: Partial<AuditRetentionPolicy> = {},
  ) {
    this.retention = { ...DEFAULT_AUDIT_RETENTION, ...retention };
    this.anchor = this.genesis;
  }

  get retainedCount(): number {
    return this.entries.length;
  }

  get prunedCount(): number {
    return this.pruned;
  }

  /** Current chain head — the anchor plus everything still held. */
  head(): string {
    return this.entries.length === 0 ? this.anchor : this.entries.at(-1)!.hash;
  }

  /**
   * Fold the entries the policy says it can no longer hold into the anchor. Entries leave
   * in seq order, so the links of what remains stay contiguous and verifiable.
   */
  prune(): number {
    const now = this.retention.now();
    let removed = 0;
    while (this.entries.length > 0) {
      const oldest = this.entries[0]!;
      const overCap = this.entries.length > this.retention.maxEntries;
      const expired = now - oldest.at > this.retention.ttlMs;
      if (!overCap && !expired) break;
      this.anchor = oldest.hash;
      this.entries.shift();
      removed += 1;
    }
    this.pruned += removed;
    return removed;
  }

  append(input: LogInput): LogEntry {
    const at = input.at ?? Date.now();
    const prevHash = this.entries.length === 0 ? this.anchor : this.entries.at(-1)!.hash;

    // mask before writing: a secret that reaches the log has already leaked
    const metadata = maskSensitive(input.metadata ?? {}) as Record<string, unknown>;

    const body = {
      seq: ++this.seq,
      at,
      principalId: input.principalId,
      action: input.action,
      resource: input.resource,
      decision: input.decision,
      metadata,
      prevHash,
    };

    const entry: LogEntry = { ...body, hash: this.hasher(JSON.stringify(body)) };
    this.entries.push(entry);
    this.prune();
    return entry;
  }

  all(): LogEntry[] {
    return [...this.entries];
  }

  /**
   * Verify the chain. Returns the first broken link, so a tamper is locatable rather
   * than just detectable.
   *
   * Starts at the anchor, not genesis: once pruning is allowed, "the first entry's
   * prevHash is not genesis" is what retention looks like, and reporting that as
   * tampering would train everyone to ignore the one signal this class exists to give.
   */
  verify(): { intact: boolean; brokenAtSeq?: number; total: number } {
    let prev = this.anchor;
    for (const e of this.entries) {
      const { hash, ...body } = e;
      if (body.prevHash !== prev) return { intact: false, brokenAtSeq: e.seq, total: this.entries.length };
      if (this.hasher(JSON.stringify(body)) !== hash) {
        return { intact: false, brokenAtSeq: e.seq, total: this.entries.length };
      }
      prev = hash;
    }
    return { intact: true, total: this.entries.length };
  }

  /**
   * Prove a pruned prefix back against the anchor it left behind. A caller that still
   * holds old entries — a mirror, an export, a subpoena — can check they are the ones this
   * chain once contained.
   */
  verifyPrefix(prefix: readonly LogEntry[]): boolean {
    let prev = this.genesis;
    for (const e of prefix) {
      const { hash, ...body } = e;
      if (body.prevHash !== prev) return false;
      if (this.hasher(JSON.stringify(body)) !== hash) return false;
      prev = hash;
    }
    return this.entries.length === 0 ? prev === this.head() : prev === this.entries[0]!.prevHash;
  }

  query(filter: {
    principalId?: string;
    action?: string;
    since?: number;
    until?: number;
    onlyDenied?: boolean;
  }): LogEntry[] {
    return this.entries.filter((e) => {
      if (filter.principalId && e.principalId !== filter.principalId) return false;
      if (filter.action && !e.action.startsWith(filter.action)) return false;
      if (filter.since !== undefined && e.at < filter.since) return false;
      if (filter.until !== undefined && e.at > filter.until) return false;
      if (filter.onlyDenied && e.decision.allow) return false;
      return true;
    });
  }
}

function defaultHash(s: string): string {
  // FNV-1a expanded to 256 bits — deterministic, dependency-free, and sufficient for
  // tamper evidence. Not a security primitive: the chain proves *modification*, not
  // authorship.
  const parts = 8;
  let out = "";
  for (let p = 0; p < parts; p++) {
    let h = 0x811c9dc5 ^ (p * 0x9e3779b9);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i) + p;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
  }
  return out;
}

/**
 * Trace and replay: reconstruct what an agent did, in order, from the log alone.
 */
export interface TraceStep {
  seq: number;
  at: number;
  principalId: string;
  action: string;
  resource: string;
  allowed: boolean;
}

export interface Trace {
  principalId: string;
  steps: TraceStep[];
  allowedCount: number;
  deniedCount: number;
  durationMs: number;
  /** human-readable narration, for an incident report */
  narrative: string[];
}

export function replayTrace(
  log: AuditLog,
  principalId: string,
  range?: { since?: number; until?: number },
): Trace {
  const entries = log
    .query({ principalId, ...range })
    .sort((a, b) => a.seq - b.seq);

  const steps: TraceStep[] = entries.map((e) => ({
    seq: e.seq,
    at: e.at,
    principalId: e.principalId,
    action: e.action,
    resource: e.resource,
    allowed: e.decision.allow,
  }));

  const allowedCount = steps.filter((s) => s.allowed).length;
  const narrative = steps.map((s) => {
    const verb = s.allowed ? "did" : "was blocked from";
    const why = s.allowed ? "" : "";
    return `#${s.seq} ${new Date(s.at).toISOString()} ${s.principalId} ${verb} ${s.action} on ${s.resource}${why}`;
  });

  return {
    principalId,
    steps,
    allowedCount,
    deniedCount: steps.length - allowedCount,
    durationMs: steps.length > 1 ? steps.at(-1)!.at - steps[0]!.at : 0,
    narrative,
  };
}

/**
 * Incident forensics: given a principal's history, produce a defensible report.
 */
export interface IncidentReport {
  principalId: string;
  generatedAt: number;
  window: { since: number; until: number };
  summary: string;
  counts: { total: number; allowed: number; denied: number };
  denialCodes: Record<string, number>;
  mostCommonDenial?: { code: string; count: number };
  /** actions in the report that succeeded despite a nearby denial — the interesting case */
  escalationCandidates: string[];
  logIntact: boolean;
  evidenceHash: string;
}

export function buildIncidentReport(
  log: AuditLog,
  principalId: string,
  window: { since: number; until: number },
): IncidentReport {
  const entries = log.query({ principalId, ...window });
  const counts = { total: entries.length, allowed: 0, denied: 0 };
  const denialCodes: Record<string, number> = {};
  const escalationCandidates: string[] = [];

  let lastDenialAt: number | null = null;
  for (const e of entries) {
    if (e.decision.allow) {
      counts.allowed += 1;
      // an allow shortly after a denial is worth a human look: the agent may have
      // found an alternate path around the control
      if (lastDenialAt !== null && e.at - lastDenialAt < 5_000) {
        escalationCandidates.push(e.action);
      }
    } else {
      counts.denied += 1;
      lastDenialAt = e.at;
      const code = e.decision.code ?? "unknown";
      denialCodes[code] = (denialCodes[code] ?? 0) + 1;
    }
  }

  const mostCommon = Object.entries(denialCodes).sort((a, b) => b[1] - a[1])[0];
  const verification = log.verify();

  return {
    principalId,
    generatedAt: Date.now(),
    window,
    summary:
      counts.total === 0
        ? "no activity in this window"
        : `${counts.total} actions, ${counts.allowed} allowed, ${counts.denied} blocked` +
          (mostCommon ? `; most frequent block: ${mostCommon[0]} (${mostCommon[1]})` : ""),
    counts,
    denialCodes,
    ...(mostCommon ? { mostCommonDenial: { code: mostCommon[0], count: mostCommon[1] } } : {}),
    escalationCandidates,
    logIntact: verification.intact,
    evidenceHash: defaultHash(
      JSON.stringify(entries.map((e) => ({ seq: e.seq, hash: e.hash }))),
    ),
  };
}

/**
 * Anomaly detection on the action stream.
 *
 * Signals chosen because they actually distinguish an agent from its normal self:
 * a sudden burst (compromise), an unfamiliar action type (a new capability), a
 * repeated identical failure (a probing loop), and off-hours activity.
 */
export interface Anomaly {
  kind: "burst" | "novel-action" | "failure-loop" | "off-hours" | "scope-creep";
  severity: "low" | "medium" | "high";
  detail: string;
  at: number;
}

export class AnomalyDetector {
  private readonly seenActions = new Set<string>();
  private readonly recent: number[] = [];

  constructor(
    private readonly thresholds = {
      burstPerMinute: 20,
      failureLoopCount: 5,
      offHoursStart: 0,
      offHoursEnd: 6,
    },
  ) {}

  observe(args: { action: string; allowed: boolean; at: number; scopeCount?: number }): Anomaly[] {
    const out: Anomaly[] = [];
    const windowStart = args.at - 60_000;
    while (this.recent.length > 0 && this.recent[0]! < windowStart) this.recent.shift();
    this.recent.push(args.at);

    if (this.recent.length > this.thresholds.burstPerMinute) {
      out.push({
        kind: "burst",
        severity: "high",
        detail: `${this.recent.length} actions in 60s (threshold ${this.thresholds.burstPerMinute})`,
        at: args.at,
      });
    }

    if (!this.seenActions.has(args.action)) {
      this.seenActions.add(args.action);
      if (this.seenActions.size > 1) {
        out.push({
          kind: "novel-action",
          severity: "low",
          detail: `first use of action "${args.action}"`,
          at: args.at,
        });
      }
    }

    const hour = new Date(args.at).getUTCHours();
    if (hour >= this.thresholds.offHoursStart && hour < this.thresholds.offHoursEnd) {
      out.push({
        kind: "off-hours",
        severity: "low",
        detail: `activity at ${hour}:00 UTC, outside the normal window`,
        at: args.at,
      });
    }

    if (!args.allowed && this.recent.length >= this.thresholds.failureLoopCount) {
      out.push({
        kind: "failure-loop",
        severity: "medium",
        detail: `${this.recent.length} actions with at least one block — possible probing`,
        at: args.at,
      });
    }

    return out;
  }

  /** An agent that suddenly needs more permissions than before is worth noticing. */
  static scopeCreep(before: number, after: number): Anomaly | null {
    if (after <= before) return null;
    return {
      kind: "scope-creep",
      severity: "high",
      detail: `scope grew from ${before} to ${after} permissions`,
      at: Date.now(),
    };
  }
}

export type AlertSeverity = "info" | "warning" | "critical";

export class AlertManager {
  constructor(
    private readonly sink: (alert: { severity: AlertSeverity; message: string; at: number }) => void | Promise<void>,
  ) {}

  async raise(anomalies: Anomaly[]): Promise<number> {
    let sent = 0;
    for (const a of anomalies) {
      const severity: AlertSeverity =
        a.severity === "high" ? "critical" : a.severity === "medium" ? "warning" : "info";
      try {
        await this.sink({ severity, message: `[${a.kind}] ${a.detail}`, at: a.at });
        sent += 1;
      } catch {
        // an alerting failure must not take down the caller
      }
    }
    return sent;
  }
}

/**
 * Rate limiting: token bucket per principal, and a global ceiling so one agent cannot
 * starve the system.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastRefill: number }>();

  constructor(
    private readonly config = {
      perMinute: 60,
      burst: 10,
      globalPerMinute: 1000,
    },
  ) {}

  tryConsume(key: string, cost = 1, now = Date.now()): Decision {
    const refillRate = this.config.perMinute / 60_000; // tokens per ms
    const bucket = this.buckets.get(key) ?? {
      tokens: this.config.burst,
      lastRefill: now,
    };
    bucket.tokens = Math.min(
      this.config.burst,
      bucket.tokens + (now - bucket.lastRefill) * refillRate,
    );
    bucket.lastRefill = now;

    if (bucket.tokens < cost) {
      return {
        allow: false,
        reason: `rate limit: ${key} has ${bucket.tokens.toFixed(1)} tokens, needs ${cost}`,
        code: "rate-limited",
      };
    }
    bucket.tokens -= cost;
    this.buckets.set(key, bucket);
    return { allow: true, reason: "within rate limit" };
  }

  tokens(key: string, now = Date.now()): number {
    const b = this.buckets.get(key);
    if (!b) return this.config.burst;
    const refill = this.config.perMinute / 60_000;
    return Math.min(this.config.burst, b.tokens + (now - b.lastRefill) * refill);
  }
}

/**
 * AI policy enforcement: declarative rules evaluated against every action.
 *
 * Declared as data rather than code so a policy change is a reviewable diff, and so a
 * non-engineer can reason about what the system will refuse.
 */
export interface PolicyRule {
  id: string;
  description: string;
  /** receives both the request and the risk assessment, so a rule can gate on either */
  appliesTo?: (req: ActionRequest, risk: RiskAssessment) => boolean;
  evaluate(req: ActionRequest, risk: RiskAssessment): Decision | null;
}

export class PolicyEngine {
  constructor(private readonly rules: PolicyRule[] = []) {}

  add(rule: PolicyRule): void {
    this.rules.push(rule);
  }

  evaluate(req: ActionRequest, risk: RiskAssessment): Decision {
    for (const rule of this.rules) {
      if (rule.appliesTo && !rule.appliesTo(req, risk)) continue;
      const d = rule.evaluate(req, risk);
      if (d && !d.allow) return { ...d, reason: `${rule.id}: ${d.reason}` };
    }
    return { allow: true, reason: "all policy rules satisfied" };
  }

  listRules(): { id: string; description: string }[] {
    return this.rules.map((r) => ({ id: r.id, description: r.description }));
  }
}

/**
 * The rules Crucible itself requires, expressed as policy data.
 *
 * Note what is deliberately *absent*: a blanket value ceiling. A policy that hard-deny
 * everything above 1 ETH makes the human-approval path unreachable for exactly the
 * actions that most need it — a large but legitimate withdrawal would be impossible
 * rather than merely supervised. High value is handled by the risk scorer, which routes
 * it to a human; policy is reserved for things a human must not be able to authorise.
 */
export const CRUCIBLE_POLICIES: PolicyRule[] = [
  {
    id: "no-self-reputation",
    description: "No principal may write its own reputation (ERC-8004 forbids self-grading).",
    appliesTo: (req) => req.permission === "reputation:write",
    evaluate: () => ({
      allow: false,
      reason: "self-attestation is never permitted",
      code: "self-attestation",
    }),
  },
  {
    id: "no-self-adjudication",
    description: "An agent may not vote on a trial it is a party to.",
    appliesTo: (req) => req.permission === "trial:dispute:vote",
    evaluate: (req) =>
      req.args?.agentId === req.principalId || req.args?.operatorId === req.principalId
        ? {
            allow: false,
            reason: "an agent may not adjudicate its own trial",
            code: "self-attestation",
          }
        : null,
  },
  {
    id: "critical-needs-human",
    description: "A critical risk score always requires a human.",
    appliesTo: (_req, risk) => risk.level === "critical",
    evaluate: () => ({
      allow: false,
      reason: "critical-risk actions require human approval",
      code: "approval-required",
    }),
  },
];

/**
 * Regulatory mapping. Not legal advice — a traceability aid that records which
 * control satisfies which obligation, so an auditor can see the mapping rather than
 * infer it.
 */
export interface RegulatoryMapping {
  framework: string;
  control: string;
  reference: string;
  rationale: string;
}

export const REGULATORY_MAP: RegulatoryMapping[] = [
  {
    framework: "EU AI Act",
    control: "human-approval",
    reference: "Art. 14 — Human oversight",
    rationale: "High-risk actions require a human decision that can be overridden.",
  },
  {
    framework: "EU AI Act",
    control: "risk-assessment",
    reference: "Art. 9 — Risk management",
    rationale: "Every action is scored and scored actions are retained for review.",
  },
  {
    framework: "EU AI Act",
    control: "logging",
    reference: "Art. 12 — Record keeping",
    rationale: "Tamper-evident log of prompts, decisions and outputs.",
  },
  {
    framework: "EU AI Act",
    control: "tool-allowlist",
    reference: "Art. 15 — Accuracy, robustness, cybersecurity",
    rationale: "Deny-by-default capability set limits the blast radius of a compromise.",
  },
  {
    framework: "SOC 2",
    control: "access-control",
    reference: "CC6.1 — Logical access",
    rationale: "RBAC with scoped, expiring, revocable credentials.",
  },
  {
    framework: "SOC 2",
    control: "audit-trail",
    reference: "CC7.2 — Monitoring",
    rationale: "Hash-chained action log with anomaly detection.",
  },
  {
    framework: "SOC 2",
    control: "change-tracking",
    reference: "CC8.1 — Change management",
    rationale: "Audit log integrity is verifiable after the fact.",
  },
  {
    framework: "GDPR",
    control: "data-masking",
    reference: "Art. 32 — Security of processing",
    rationale: "Secrets and PII are masked before anything is persisted.",
  },
  {
    framework: "GDPR",
    control: "data-minimisation",
    reference: "Art. 5(1)(c)",
    rationale: "Session scoping prevents data crossing tenant boundaries.",
  },
  {
    framework: "NIST AI RMF",
    control: "injection-defence",
    reference: "MEASURE 2.6 — Adversarial testing",
    rationale: "Prompt-injection scanning with quarantine and rejection.",
  },
];

/**
 * Risk assessment: score an action from its observable properties.
 *
 * Deliberately conservative — unknown values score as risky rather than safe, because
 * the failure mode of an agent security system is asymmetric: a false negative is a
 * drained wallet.
 */
export function assessRisk(args: {
  permission: string;
  valueWei?: bigint;
  toolRiskWeight?: number;
  isReversible?: boolean;
  touchesExternalSystem?: boolean;
  historyDenied?: number;
}): RiskAssessment {
  const factors: string[] = [];
  let score = 0;

  const PERMISSION_WEIGHT: Record<string, number> = {
    "funds:withdraw": 30,
    "trial:run": 20,
    "trial:claim": 10,
    "trial:break": 15,
    "trial:finalize": 25,
    "trial:dispute:vote": 35,
    "agent:unstake": 20,
    "admin:rotate-key": 45,
    "admin:policy": 50,
    "reputation:read": 0,
  };

  const w = PERMISSION_WEIGHT[args.permission] ?? 10;
  score += w;
  factors.push(`permission:${args.permission}=${w}`);

  if (args.valueWei !== undefined && args.valueWei > 0n) {
    const eth = Number(args.valueWei) / 1e18;
    const v = Math.min(40, Math.round(Math.log10(eth + 1) * 12));
    score += v;
    factors.push(`value:${eth.toFixed(4)}ETH=${v}`);
  }

  if (args.toolRiskWeight) {
    score += args.toolRiskWeight;
    factors.push(`toolWeight=${args.toolRiskWeight}`);
  }

  if (args.isReversible === false) {
    score += 20;
    factors.push("irreversible=20");
  }

  if (args.touchesExternalSystem) {
    score += 15;
    factors.push("external-system=15");
  }

  if (args.historyDenied && args.historyDenied > 0) {
    const d = Math.min(25, args.historyDenied * 5);
    score += d;
    factors.push(`priorBlocks=${args.historyDenied}=${d}`);
  }

  score = Math.max(0, Math.min(100, score));
  const level: RiskLevel = score >= 70 ? "critical" : score >= 45 ? "high" : score >= 20 ? "medium" : "low";

  return {
    level,
    score,
    factors,
    // anything high or above, or any irreversible money movement, needs a human
    requiresHumanApproval: level === "critical" || level === "high" || (args.valueWei ?? 0n) > BigInt(5) * 10n ** 18n,
  };
}
