/**
 * What the identity service knows about a wallet, before any funds move.
 *
 * ADR-0015 keeps the key in this process and nowhere else; the score is read from the API over
 * loopback, and this module only decides how much a drip is worth. Two rules shape it:
 *
 *   * **Absence of evidence is not denial.** A wallet that has never touched Crucible scores
 *     the base rate (~0.10) and the decision layer says "deny". That wallet is exactly the
 *     visitor a faucet exists for — the first thing it will do is create the history that
 *     would score it. Denying it makes the demo's first step fail, so an unknown wallet gets a
 *     smaller allocation rather than none.
 *   * **Only negative evidence refuses.** A slash is a fact about this wallet's conduct on
 *     chain; that is the one signal that can say no. Everything else scales the amount.
 *
 * A risk service that cannot be reached is reported, not guessed: the caller falls back to the
 * base allocation and records why. The caps in `cap.ts` bound that fallback, so an unavailable
 * identity service can cost at most one small drip per wallet per day.
 */

export interface RiskEvidence {
  name: string;
}

export interface RiskView {
  pUniqueHuman: number;
  action: "allow" | "challenge" | "rate-limit" | "deny" | string;
  evidence: RiskEvidence[];
}

export interface RiskConsult {
  ok: true;
  view: RiskView;
}

export interface RiskFailure {
  ok: false;
  reason: string;
}

export interface AllocationPolicy {
  /** 0 refuses. 1 pays the requested amount (subject to the caps). */
  factor: number;
  reason: string;
}

/** Smaller first drip for a wallet with nothing on record: not a denial, not the full amount. */
export const FACTOR_UNKNOWN_WALLET = 0.25;
export const FACTOR_NEUTRAL = 0.5;
export const FACTOR_TRUSTED = 1;

/**
 * Map a risk view to an allocation factor.
 *
 * Deliberately independent of `decide()`'s action strings: the faucet is a different payer from
 * whatever `decide()` was written for, and a shared string would invite the two to drift.
 * The rule here is stated in terms of the evidence, which is what actually exists.
 */
export function allocationPolicy(view: RiskView): AllocationPolicy {
  if (view.evidence.some((e) => e.name === "hasSlashes")) {
    return { factor: 0, reason: "wallet has slashes on record; not funding a known-bad actor" };
  }
  if (view.pUniqueHuman >= 0.7) {
    return { factor: FACTOR_TRUSTED, reason: "chain history supports this wallet" };
  }
  if (view.pUniqueHuman >= 0.4) {
    return { factor: FACTOR_NEUTRAL, reason: "partial history; half allocation" };
  }
  // No history, or nothing that separates this wallet from a fresh one. Base rate is ~0.10,
  // and the faucet's whole purpose is the wallet that has no history yet.
  return { factor: FACTOR_UNKNOWN_WALLET, reason: "no history yet; smaller first allocation" };
}

export interface ConsultOptions {
  apiUrl: string;
  timeoutMs?: number;
  /** Injected for tests; defaults to the platform fetch. */
  fetchImpl?: typeof fetch;
}

/** Ask the identity service for this wallet's score. Never throws. */
export async function consultRisk(wallet: string, opts: ConsultOptions): Promise<RiskConsult | RiskFailure> {
  const base = opts.apiUrl.replace(/\/+$/, "");
  if (!base) return { ok: false, reason: "no identity service configured" };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 1500;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/identity/risk/${encodeURIComponent(wallet)}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { ok: false, reason: `identity service answered ${res.status}` };
    const body = (await res.json()) as { score?: Partial<RiskView> & { evidence?: RiskEvidence[] } };
    const score = body.score;
    if (!score || typeof score.pUniqueHuman !== "number" || !Array.isArray(score.evidence)) {
      return { ok: false, reason: "identity service returned no usable score" };
    }
    return {
      ok: true,
      view: {
        pUniqueHuman: score.pUniqueHuman,
        action: typeof score.action === "string" ? score.action : "unknown",
        evidence: score.evidence,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: controller.signal.aborted ? `identity service timed out after ${timeoutMs}ms` : message };
  } finally {
    clearTimeout(timer);
  }
}
