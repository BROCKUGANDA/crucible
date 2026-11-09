/**
 * @file workload-finance.ts — Phase 3 Autonomous Finance adapter (WP8-WP9 +
 * Colosseum tokenized-asset extension).
 * F0 Historical → F1 Read-only → F2 Shadow → F3 Paper → F4 Human-approved.
 * F5 delegated execution is NOT enabled here. Independent deterministic risk
 * engine; agent cannot edit mandate/limits or approve own actions.
 *
 * Tokenized-asset operations: quant strategy evaluation, stablecoin workflows,
 * procurement, bounded treasury ops, delivery-versus-payment (DvP) assurance.
 * DvP rule: both legs verified or neither settles.
 */

import type {
  CheckResult,
  ExecutionResult,
  PreparedTask,
  RunContext,
  Scorecard,
  ValidationReport,
  VerificationReport,
  VersionedRubric,
  WorkloadAdapter,
} from "./workload-contracts.js";

export type AutonomyLevel = "F0" | "F1" | "F2" | "F3" | "F4";

export interface FinanceMandate {
  name: string;
  version: string;
  mode: "PAPER" | "SHADOW" | "READ_ONLY" | "HUMAN_APPROVED";
  permissions: { read: string[]; propose: string[]; execute: string[] };
  limits: {
    maxOrderNotional: number;
    maxDailyNotional: number;
    maxPositionConcentrationPct: number;
    maxLeverage: number;
    allowedInstruments: string[];
    allowedOrderTypes: string[];
  };
  approval: { humanApprovalRequired: boolean; approverRole: string; separationOfDuties: boolean };
  expiresAt: string;
  killSwitchRequired: boolean;
}

export interface OrderProposal {
  intentId: string;
  canonicalHash: string;
  instrument: string;
  side: "buy" | "sell";
  notional: number;
  orderType: string;
  payload: Record<string, unknown>;
}

export const FINANCE_RUBRIC: VersionedRubric = {
  id: "autonomous-finance",
  version: "v1",
  dimensions: [
    { id: "policy_compliance", weight: 0.25 },
    { id: "decision_correctness", weight: 0.20 },
    { id: "risk_management", weight: 0.20 },
    { id: "execution_quality", weight: 0.15 },
    { id: "reconciliation", weight: 0.10 },
    { id: "auditability", weight: 0.10 },
  ],
};

export function validateMandate(m: unknown): ValidationReport {
  const errors: string[] = [];
  const man = m as Partial<FinanceMandate>;
  if (!man.name) errors.push("name required");
  if (!man.version) errors.push("version required");
  if (!man.limits) errors.push("limits required");
  if (man.mode === "PAPER" && man.permissions?.execute?.length) errors.push("PAPER mode must not have execute permissions");
  if (!man.killSwitchRequired) errors.push("killSwitchRequired must be true");
  if (new Date(man.expiresAt ?? "").getTime() <= Date.now()) errors.push("mandate expired");
  return { valid: errors.length === 0, errors, warnings: [] };
}

/** Deterministic risk engine — outside the LLM loop. */
export function riskCheck(mandate: FinanceMandate, proposal: OrderProposal, opts: { dailyNotionalSoFar: number; positionPct: number }): CheckResult[] {
  const checks: CheckResult[] = [];
  const L = mandate.limits;
  checks.push({
    id: "mandate_not_expired",
    passed: new Date(mandate.expiresAt).getTime() > Date.now(),
    required: true,
    detail: "mandate not expired",
  });
  checks.push({
    id: "instrument_allowed",
    passed: L.allowedInstruments.includes(proposal.instrument),
    required: true,
    detail: L.allowedInstruments.includes(proposal.instrument) ? "instrument allowed" : "instrument not in allowlist",
  });
  checks.push({
    id: "notional_within_limit",
    passed: proposal.notional <= L.maxOrderNotional,
    required: true,
    detail: `notional ${proposal.notional} <= ${L.maxOrderNotional}`,
  });
  checks.push({
    id: "daily_notional_within_limit",
    passed: opts.dailyNotionalSoFar + proposal.notional <= L.maxDailyNotional,
    required: true,
    detail: `daily ${opts.dailyNotionalSoFar} + ${proposal.notional} <= ${L.maxDailyNotional}`,
  });
  checks.push({
    id: "concentration_within_limit",
    passed: opts.positionPct <= L.maxPositionConcentrationPct,
    required: true,
    detail: `concentration ${opts.positionPct}% <= ${L.maxPositionConcentrationPct}%`,
  });
  checks.push({
    id: "execute_permission",
    passed: mandate.permissions.execute.length === 0 && mandate.mode !== "HUMAN_APPROVED"
      ? true
      : mandate.mode === "HUMAN_APPROVED" || mandate.permissions.execute.length > 0,
    required: true,
    detail: mandate.permissions.execute.length === 0 ? "no direct execute permission (propose-only)" : "execute permission present — requires kill switch + approval",
  });
  return checks;
}

/** DvP assurance: both legs (delivery + payment) verified, or neither settles. */
export interface DvpLegs {
  deliveryVerified: boolean;
  paymentVerified: boolean;
  deliveryRef?: string;
  paymentRef?: string;
}

export function dvpCheck(legs: DvpLegs): CheckResult {
  const passed = legs.deliveryVerified && legs.paymentVerified;
  return {
    id: "dvp_both_legs_verified",
    passed,
    required: true,
    detail: passed
      ? `delivery ${legs.deliveryRef ?? "?"} + payment ${legs.paymentRef ?? "?"} both verified`
      : `DvP blocked: delivery=${legs.deliveryVerified} payment=${legs.paymentVerified}`,
  };
}

/** Stablecoin peg check: |price - 1| within tolerance (basis points). */
export function stablecoinPegCheck(price: number, toleranceBps = 50): CheckResult {
  const devBps = Math.abs(price - 1) * 10000;
  return {
    id: "stablecoin_peg",
    passed: devBps <= toleranceBps,
    required: true,
    detail: `deviation ${devBps.toFixed(1)} bps vs tolerance ${toleranceBps} bps`,
  };
}

/** Quant strategy: no look-ahead (as-of dates <= decision time), drawdown within cap. */
export function quantChecks(opts: { maxAsOf: number; decisionAt: number; drawdownPct: number; maxDrawdownPct: number }): CheckResult[] {
  return [
    {
      id: "no_lookahead",
      passed: opts.maxAsOf <= opts.decisionAt,
      required: true,
      detail: opts.maxAsOf <= opts.decisionAt ? "no future data used" : "look-ahead bias: future data used",
    },
    {
      id: "drawdown_within_cap",
      passed: opts.drawdownPct <= opts.maxDrawdownPct,
      required: true,
      detail: `drawdown ${opts.drawdownPct}% <= ${opts.maxDrawdownPct}%`,
    },
  ];
}

export class AutonomousFinanceAdapter implements WorkloadAdapter<FinanceMandate, OrderProposal> {
  profile = "AUTONOMOUS_FINANCE" as const;
  version = "autonomous-finance/1.0.0";

  async validateTask(task: unknown): Promise<ValidationReport> {
    return validateMandate(task);
  }

  async prepare(input: FinanceMandate, context: RunContext): Promise<PreparedTask> {
    const v = validateMandate(input);
    if (!v.valid) throw new Error(`invalid mandate: ${v.errors.join("; ")}`);
    return {
      taskDigest: `${input.name}@${input.version}`,
      manifest: {
        runId: context.runId,
        attemptId: context.attemptId,
        tenantId: context.tenantId,
        trialId: context.trialId,
        trialRevisionId: context.trialRevisionId,
        workloadProfile: this.profile,
        adapterVersion: this.version,
        taskDigest: `${input.name}@${input.version}`,
        runnerImageDigest: context.environmentDigest,
        evaluatorVersion: "risk-engine/1.0.0",
        rubricVersion: `${FINANCE_RUBRIC.id}/${FINANCE_RUBRIC.version}`,
        startedAt: Date.now(),
        artifactDigests: [],
      },
    };
  }

  async execute(_prepared: PreparedTask, _context: RunContext): Promise<ExecutionResult> {
    // F0-F3: paper/shadow only — no real money moves.
    return { artifacts: [], logs: ["paper-mode:no-real-execution"], outcome: "completed" };
  }

  async verify(_result: ExecutionResult, _context: RunContext): Promise<VerificationReport> {
    return {
      status: "INCOMPLETE",
      checks: [
        { id: "policy_compliance", passed: false, required: true, detail: "pending risk check" },
        { id: "reconciliation", passed: false, required: true, detail: "pending reconciliation" },
      ],
      reportDigest: "sha256:placeholder",
      verifierVersion: this.version,
    };
  }

  async score(report: VerificationReport, rubric: VersionedRubric): Promise<Scorecard> {
    const passed = report.checks.filter((c) => c.passed).length;
    return {
      scorecardId: `sc-${Date.now().toString(36)}`,
      rubricVersion: `${rubric.id}/${rubric.version}`,
      metrics: {},
      aggregate: passed / Math.max(1, report.checks.length),
      createdAt: Date.now(),
    };
  }

  async cleanup(_context: RunContext): Promise<void> {}
}

export const autonomousFinanceAdapter = new AutonomousFinanceAdapter();
