import type { Artifact, ModelAdapter, ModelVerdict } from "./types.js";

/**
 * Gates 503–507, 510: the frontier layer.
 *
 * Everything here exists because the arena had the shape of a frontier harness without the
 * obligations. `arena.ts` published `avgCostUsd` as a literal `0`; no module recorded which
 * provider snapshot a verdict came from; and an artifact's payload reached an adapter with no
 * inspection between the two, so "a frontier model never sees a key" was a sentence rather than
 * a serializer.
 *
 * Three parts, deliberately in one file because they are one subject — what a paid third-party
 * call is allowed to carry, cost, and be attributed to:
 *
 *   ModelCard       — snapshot pin + retention posture + budgets. No defaults: an unreviewed
 *                     retention field is a refusal, because a card that quietly means "unknown"
 *                     is how a model gets used for training data nobody signed up for.
 *   SpendLedger     — day and stage totals per model, and a guard that refuses *before* the
 *                     call. A ledger that only reports after the invoice is a report, not a cap.
 *   scrubEgress     — the one egress path. Secret shapes and host paths are redacted, and the
 *                     categories found are returned so the span can name them.
 */

// ────────────────────────── the card ──────────────────────────

export interface RetentionPosture {
  /** What the provider keeps. `unknown` is not a legal value; omitting the card is worse. */
  retention: "zero-retention-api" | "api-logs-retained" | "training-use-allowed" | "unknown";
  /** ISO date the posture was checked against the provider's terms, not the day it was written. */
  reviewedAt: string;
  /** Where that answer came from. A posture with no citation is a guess. */
  source: string;
}

export interface ModelCard {
  id: string;
  dialect: "openai-compat" | "anthropic" | "google" | "stub";
  /** Exact provider snapshot. Models drift; a `latest` alias makes yesterday's kappa unrepeatable. */
  snapshot: string;
  pinnedAt: string;
  roles: Array<"contestant" | "judge" | "attacker">;
  retention: RetentionPosture;
  budgetUsd: { stage: number; day: number };
  costPerCallUsd: number;
  /** p95 latency budget in ms (gate 513). */
  latencyP95Ms: number;
}

export class ModelCardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelCardError";
  }
}

export function validateModelCard(card: ModelCard): void {
  if (card.snapshot.trim().length === 0) {
    throw new ModelCardError(`model ${card.id}: snapshot must be an exact pin, not empty`);
  }
  // The alias case is the one that actually ships by accident.
  if (/(^|[:\-])(latest|live|default)$/i.test(card.snapshot)) {
    throw new ModelCardError(
      `model ${card.id}: snapshot "${card.snapshot}" is a moving alias. Gate 504 pins an exact release.`,
    );
  }
  if (card.retention.retention === "unknown") {
    throw new ModelCardError(
      `model ${card.id}: retention posture is unknown. Ask the provider, then record it — ` +
        `"unknown" must not become the value that lets a call through.`,
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(card.retention.reviewedAt)) {
    throw new ModelCardError(`model ${card.id}: reviewedAt must be an ISO date`);
  }
  if (card.retention.source.trim().length === 0) {
    throw new ModelCardError(`model ${card.id}: retention posture needs a source`);
  }
  if (!(card.budgetUsd.stage > 0) || !(card.budgetUsd.day > 0)) {
    throw new ModelCardError(
      `model ${card.id}: budgets must be positive. A zero budget is not "capped", it is a ` +
        `call that refuses nothing because there is nothing to compare against.`,
    );
  }
  if (!(card.costPerCallUsd >= 0)) {
    throw new ModelCardError(`model ${card.id}: costPerCallUsd must be a number >= 0`);
  }
}

// ────────────────────────── the ledger ──────────────────────────

export class BudgetExhausted extends Error {
  constructor(
    readonly modelId: string,
    readonly scope: "stage" | "day",
    readonly spentUsd: number,
    readonly capUsd: number,
  ) {
    super(
      `model ${modelId}: ${scope} budget exhausted — $${spentUsd.toFixed(4)} of $${capUsd.toFixed(4)}. ` +
        `Refused before the call. Paid grading stops here; fall back to the stub tier (gate 505) ` +
        `rather than widening the cap to make a run finish.`,
    );
    this.name = "BudgetExhausted";
  }
}

/** Per-model spend, in dollars, with the cap enforced ahead of the call. */
export class SpendLedger {
  private day = new Map<string, number>();
  private stage = new Map<string, number>();
  private calls = new Map<string, number>();

  record(card: ModelCard, scope: string): void {
    const stageKey = `${card.id}::${scope}`;
    this.day.set(card.id, (this.day.get(card.id) ?? 0) + card.costPerCallUsd);
    this.stage.set(stageKey, (this.stage.get(stageKey) ?? 0) + card.costPerCallUsd);
    this.calls.set(card.id, (this.calls.get(card.id) ?? 0) + 1);
  }

  dayUsd(modelId: string): number {
    return this.day.get(modelId) ?? 0;
  }

  stageUsd(modelId: string, scope: string): number {
    return this.stage.get(`${modelId}::${scope}`) ?? 0;
  }

  callCount(modelId: string): number {
    return this.calls.get(modelId) ?? 0;
  }

  /** Average cost per graded artifact — the number the scorecard publishes. */
  averageUsd(modelId: string): number {
    const n = this.calls.get(modelId) ?? 0;
    if (n === 0) return 0;
    return (this.day.get(modelId) ?? 0) / n;
  }

  reset(): void {
    this.day.clear();
    this.stage.clear();
    this.calls.clear();
  }
}

// ────────────────────────── the egress path ──────────────────────────

export type EgressFinding = "private-key" | "pem-block" | "bearer-token" | "env-assignment" | "host-path";

const REDACTION = "\u00abredacted\u00bb";

const PATTERNS: Array<{ kind: EgressFinding; re: RegExp; replace: (m: string) => string }> = [
  {
    kind: "pem-block",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => REDACTION,
  },
  {
    kind: "private-key",
    re: /\b0x[0-9a-fA-F]{64}\b/g,
    replace: () => REDACTION,
  },
  {
    kind: "bearer-token",
    re: /\b(Bearer|Authorization:)\s+[A-Za-z0-9._\-]{16,}/g,
    replace: () => REDACTION,
  },
  {
    kind: "env-assignment",
    // Anything that reads KEY=value with a key that looks like a credential. The shape matters
    // more than the name: a leaked RPC URL or an auth secret both arrive this way.
    re: /\b([A-Z][A-Z0-9_]*(?:SECRET|KEY|TOKEN|PASSWORD|PASSPHRASE|URL|DSN|URI)[A-Z0-9_]*)=([^\s,"']+)/g,
    replace: (m) => `${m.split("=")[0]}=${REDACTION}`,
  },
  {
    kind: "host-path",
    // Windows drive paths and POSIX homes. A payload does not need to know whose machine ran it.
    re: /(?:[A-Za-z]:\\|\/(?:home|Users|var|etc|root)\/)[^\s,"']*/g,
    replace: () => REDACTION,
  },
];

export interface ScrubResult {
  text: string;
  /** Categories removed. Empty means the payload left as it arrived. */
  findings: EgressFinding[];
}

/**
 * The one egress path (gate 506).
 *
 * Redacts rather than refuses, because the artifact IS the thing under test — withholding it
 * would score the model on nothing. The categories that fired are returned so the run can record
 * "a spec in this corpus carried a private key" as a fact about the corpus, which is a finding
 * worth more than the redaction.
 */
export function scrubEgress(payload: unknown): ScrubResult {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
  const found = new Set<EgressFinding>();
  let out = text;
  for (const { kind, re, replace } of PATTERNS) {
    out = out.replace(re, (m) => {
      found.add(kind);
      return replace(m);
    });
  }
  return { text: out, findings: [...found] };
}

/** True only when nothing was removed — the assertion a CI gate can check a fixture against. */
export function egressClean(payload: unknown): boolean {
  return scrubEgress(payload).findings.length === 0;
}

// ────────────────────────── the wrapper ──────────────────────────

/**
 * Wrap a paid adapter with the frontier obligations. The wrapper is the integration point: an
 * adapter reached without it is a call with no cap, no scrub and no attribution, which is exactly
 * what a runner that forgets the wrapper produces.
 *
 * Refusal happens before `grade()` is invoked, so an exhausted budget spends nothing. A refusal
 * is thrown rather than swallowed: the arena's job is to report a model that could not be graded,
 * not to invent a verdict for it.
 */
export function withFrontierGuard(
  adapter: ModelAdapter,
  card: ModelCard,
  ledger: SpendLedger,
  opts: { scope: string; onRedaction?: (findings: EgressFinding[], artifact: Artifact) => void },
): ModelAdapter {
  validateModelCard(card);
  if (adapter.id !== card.id) {
    throw new ModelCardError(
      `wrapper id "${adapter.id}" does not match card id "${card.id}" — a card must describe ` +
        `the model it guards, or the attribution on every verdict is wrong.`,
    );
  }

  return {
    id: adapter.id,
    async grade(artifact: Artifact, promptVersion: string): Promise<ModelVerdict> {
      const daySpent = ledger.dayUsd(card.id);
      if (daySpent + card.costPerCallUsd > card.budgetUsd.day) {
        throw new BudgetExhausted(card.id, "day", daySpent, card.budgetUsd.day);
      }
      const stageSpent = ledger.stageUsd(card.id, opts.scope);
      if (stageSpent + card.costPerCallUsd > card.budgetUsd.stage) {
        throw new BudgetExhausted(card.id, "stage", stageSpent, card.budgetUsd.stage);
      }

      const scrubbed = scrubEgress(artifact.payload);
      if (scrubbed.findings.length > 0) opts.onRedaction?.(scrubbed.findings, artifact);

      const verdict = await adapter.grade({ ...artifact, payload: scrubbed.text }, promptVersion);
      ledger.record(card, opts.scope);
      return verdict;
    },
  };
}
