/**
 * Frenchy v2 — reactive voice quips (gates 668-677).
 *
 * Frenchy is a garnish on the show, never the show. The Warden owns the stage.
 * Every quip is a deterministic, static-pool text string — no audio, no runtime
 * LLM, no adapter call, no new producer. Frenchy never touches the trace spine
 * as a writer; he only records frenchy.quip spans for spectator replay.
 */

import poolsJson from "./pools.json";

const pools = poolsJson.pools as Record<FrenchyTrigger, string[]>;

export type FrenchyTrigger =
  | "escrow_opened"
  | "work_posted"
  | "verdict_pass"
  | "verdict_fail"
  | "dispute_opened"
  | "dispute_resolved"
  | "expiry"
  | "tx_error"
  | "idle"
  | "settle_batch";

export type FrenchyTone = "dry" | "smug" | "roast" | "gentle" | "theatrical" | "quiet";

export interface FrenchyBudget {
  /** Max quips per single event. */
  maxPerEvent: number;
  /** Max quips per rolling 5-minute window. */
  maxPer5Min: number;
  /** Max quips per rolling 1-hour window. */
  maxPerHour: number;
  /** Minimum ms between any two quips. */
  cooldownMs: number;
  /** Max quips per session hour. */
  maxSessionHour: number;
}

export const DEFAULT_BUDGET: FrenchyBudget = {
  maxPerEvent: 1,
  maxPer5Min: 3,
  maxPerHour: 12,
  cooldownMs: 45_000,
  maxSessionHour: 12,
};

export interface QuipRecord {
  trigger: FrenchyTrigger;
  text: string;
  tone: FrenchyTone;
  at: number; // epoch ms
}

export interface FrenchyPrefs {
  muted: boolean;
  dismissals: number; // consecutive manual dismissals this session
}

export const FRENCHY_MUTED_KEY = "crucible.frenchy.muted";
export const FRENCHY_DISMISSALS_KEY = "crucible.frenchy.dismissals";

export type Reader = Pick<Storage, "getItem">;

export function readFrenchyPrefs(storage: Reader | null | undefined): FrenchyPrefs {
  return {
    muted: storage?.getItem(FRENCHY_MUTED_KEY) === "1",
    dismissals: parseInt(storage?.getItem(FRENCHY_DISMISSALS_KEY) ?? "0", 10) || 0,
  };
}

export function writeFrenchyMuted(storage: Storage | null | undefined, muted: boolean): void {
  try {
    storage?.setItem(FRENCHY_MUTED_KEY, muted ? "1" : "0");
  } catch {
    /* private mode / quota: in-memory state still works for this page */
  }
}

export function writeFrenchyDismissals(storage: Storage | null | undefined, n: number): void {
  try {
    storage?.setItem(FRENCHY_DISMISSALS_KEY, String(n));
  } catch {
    /* see writeFrenchyMuted */
  }
}

/**
 * Tone ladder (gate 670): match tone to context.
 * - progress (escrow_opened, work_posted, settle_batch) -> dry
 * - streaks (verdict_pass) -> smug
 * - user errors (verdict_fail, tx_error) -> roast the situation, never the person
 * - protocol money stopped (S1/S2 incident) -> Frenchy goes silent (gate 608)
 */
export function toneFor(trigger: FrenchyTrigger): FrenchyTone {
  switch (trigger) {
    case "verdict_pass":
      return "smug";
    case "verdict_fail":
    case "tx_error":
      return "roast";
    case "expiry":
      return "gentle";
    case "dispute_opened":
      return "theatrical";
    case "dispute_resolved":
    case "settle_batch":
      return "quiet";
    default:
      return "dry";
  }
}

/** Word count guard (gate 672): reactive quips <= 12 words. */
export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** FNV-1a 32-bit hash, deterministic across runs and platforms. */
function fnv1a(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Select a quip deterministically: quip = f(trigger, sessionSeed, quipCount).
 * Same session seed + same trigger + same history index => same quip.
 * Anti-repeat: never repeat within the last 10 quips (gate 675).
 */
export function selectQuip(
  trigger: FrenchyTrigger,
  sessionSeed: string,
  history: QuipRecord[],
): string | null {
  const pool = pools[trigger];
  if (!pool || pool.length === 0) return null;

  const recent = new Set(history.slice(-10).map((q) => q.text));
  const candidates = pool.filter((t) => !recent.has(t));
  if (candidates.length === 0) return null; // every quip in the recent window -> stay silent

  const index = fnv1a(`${sessionSeed}\u0000${trigger}\u0000${history.length}`) % candidates.length;
  const picked = candidates[index];
  return picked ?? null;
}

export interface SelectResult {
  quip: QuipRecord | null;
  reason?: "muted" | "silence-zone" | "budget" | "cooldown" | "pool-exhausted";
}

/**
 * FrenchySelector: the enforceable budget + cooldown + silence-zone engine.
 * Pure logic — no DOM, no storage, no fetch. Testable headlessly.
 */
export class FrenchySelector {
  constructor(
    private readonly sessionSeed: string,
    private readonly now: () => number,
    private readonly budget: FrenchyBudget,
    private readonly history: QuipRecord[] = [],
    private muted = false,
    private dismissals = 0,
  ) {}

  /** Whether Frenchy may speak right now (gate 668-669, 671). */
  canSpeak(trigger: FrenchyTrigger, inSilenceZone: boolean): boolean {
    if (this.muted) return false;
    if (inSilenceZone) return false;

    const t = this.now();

    // Cooldown between any two quips.
    const last = this.history.at(-1);
    if (last && t - last.at < this.budget.cooldownMs) return false;

    // Rolling 5-minute window.
    const fiveMinAgo = t - 5 * 60_000;
    if (this.history.filter((q) => q.at >= fiveMinAgo).length >= this.budget.maxPer5Min)
      return false;

    // Rolling 1-hour window.
    const hourAgo = t - 60 * 60_000;
    if (this.history.filter((q) => q.at >= hourAgo).length >= this.budget.maxPerHour)
      return false;

    return true;
  }

  /**
   * Attempt to speak on a trigger. Returns the quip record or null with a reason.
   * Verdicts preempt quips: callers must not invoke select during a verification
   * sequence (silence zone) — that is enforced by inSilenceZone, not here.
   */
  select(trigger: FrenchyTrigger, inSilenceZone: boolean): SelectResult {
    if (this.muted) return { quip: null, reason: "muted" };
    if (inSilenceZone) return { quip: null, reason: "silence-zone" };
    if (!this.canSpeak(trigger, inSilenceZone)) return { quip: null, reason: "budget" };

    const text = selectQuip(trigger, this.sessionSeed, this.history);
    if (text === null) return { quip: null, reason: "pool-exhausted" };

    const quip: QuipRecord = {
      trigger,
      text,
      tone: toneFor(trigger),
      at: this.now(),
    };

    this.history.push(quip);
    return { quip };
  }

  /** Record a manual dismissal (gate 673). Two consecutive => auto-quiet for session. */
  dismiss(): void {
    this.dismissals += 1;
    if (this.dismissals >= 2) this.mute();
  }

  mute(): void {
    this.muted = true;
  }

  unmute(): void {
    this.muted = false;
    this.dismissals = 0;
  }

  getDismissals(): number {
    return this.dismissals;
  }

  isMuted(): boolean {
    return this.muted;
  }

  getHistory(): readonly QuipRecord[] {
    return this.history;
  }
}
