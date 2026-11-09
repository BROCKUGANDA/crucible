/**
 * Sponsored transaction approval webhook validation.
 *
 * The approval webhook must validate: principal, tenant, chain, target, method,
 * operation, trial state, idempotency, rate limit, budget, policy version,
 * deadline. Unknown/invalid/expired/unverifiable → deny. Fails closed.
 *
 * Pure logic: takes a request + context, returns allow/deny + reasons.
 */

export interface SponsorshipRequest {
  principal: string | null;
  tenant: string | null;
  chainId: number | null;
  target: string | null;
  method: string | null;
  operation: string | null;
  trialState: string | null;
  idempotencyKey: string | null;
  policyVersion: string | null;
  deadlineMs: number | null;
  estimatedWei: string | null;
}

export interface SponsorshipContext {
  now: number;
  allowedMethods: Set<string>;
  allowedTargets: Set<string>;
  allowedChains: Set<number>;
  budgetRemainingWei: bigint;
  rateLimitOk: boolean;
  idempotencySeen: boolean;
  trialStateAllowed: Set<string>;
  policyVersionCurrent: string;
  maxPerOpWei: bigint;
}

export interface SponsorshipDecision {
  allowed: boolean;
  reasons: string[];
}

export function evaluateSponsorship(req: SponsorshipRequest, ctx: SponsorshipContext): SponsorshipDecision {
  const reasons: string[] = [];
  if (!req.principal) reasons.push("missing principal");
  if (!req.tenant) reasons.push("missing tenant");
  if (req.chainId === null || !ctx.allowedChains.has(req.chainId)) reasons.push("chain not allowed");
  if (!req.target || !ctx.allowedTargets.has(req.target)) reasons.push("target not allowed");
  if (!req.method || !ctx.allowedMethods.has(req.method)) reasons.push("method not allowed");
  if (!req.operation) reasons.push("missing operation");
  if (!req.trialState || !ctx.trialStateAllowed.has(req.trialState)) reasons.push("trial state not allowed");
  if (!req.idempotencyKey) reasons.push("missing idempotency key");
  if (ctx.idempotencySeen) reasons.push("idempotency key already used");
  if (!ctx.rateLimitOk) reasons.push("rate limit exceeded");
  if (req.policyVersion !== ctx.policyVersionCurrent) reasons.push("policy version mismatch");
  if (req.deadlineMs === null || req.deadlineMs < ctx.now) reasons.push("expired or missing deadline");
  let est = 0n;
  try { est = req.estimatedWei ? BigInt(req.estimatedWei) : 0n; } catch { reasons.push("invalid estimated wei"); }
  if (est > ctx.maxPerOpWei) reasons.push("exceeds per-op max");
  if (est > ctx.budgetRemainingWei) reasons.push("exceeds remaining budget");
  return { allowed: reasons.length === 0, reasons };
}
