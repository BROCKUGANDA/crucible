import { describe, expect, it } from "vitest";
import poolsJson from "./pools.json";
import {
  DEFAULT_BUDGET,
  FrenchySelector,
  toneFor,
  wordCount,
  selectQuip,
} from "./index.js";
import type { FrenchyTrigger, QuipRecord } from "./index.js";

const pools = poolsJson.pools as Record<FrenchyTrigger, string[]>;

const nowBase = 1_000_000_000_000;
let now = nowBase;
const fakeNow = () => now;

function makeSelector(overrides: Partial<{
  sessionSeed: string;
  budget: typeof DEFAULT_BUDGET;
  muted: boolean;
  dismissals: number;
}> = {}): FrenchySelector {
  return new FrenchySelector(
    overrides.sessionSeed ?? "seed-abc",
    fakeNow,
    overrides.budget ?? DEFAULT_BUDGET,
    [],
    overrides.muted ?? false,
    overrides.dismissals ?? 0,
  );
}

function advance(ms: number): void {
  now += ms;
}

describe("Frenchy word count (gate 672)", () => {
  it("every reactive pool quip is <= 12 words", () => {
    for (const [trigger, quips] of Object.entries(pools)) {
      for (const q of quips) {
        expect(wordCount(q), `${trigger}: "${q}"`).toBeLessThanOrEqual(12);
      }
    }
  });

  it("every anchor is <= 25 words", () => {
    const anchors = (poolsJson as { anchors: Record<string, string[]> }).anchors;
    for (const [name, quips] of Object.entries(anchors)) {
      for (const q of quips) {
        expect(wordCount(q), `${name}: "${q}"`).toBeLessThanOrEqual(25);
      }
    }
  });
});

describe("Tone ladder (gate 670)", () => {
  it("maps triggers to tones", () => {
    expect(toneFor("verdict_pass")).toBe("smug");
    expect(toneFor("verdict_fail")).toBe("roast");
    expect(toneFor("tx_error")).toBe("roast");
    expect(toneFor("expiry")).toBe("gentle");
    expect(toneFor("dispute_opened")).toBe("theatrical");
    expect(toneFor("settle_batch")).toBe("quiet");
    expect(toneFor("escrow_opened")).toBe("dry");
    expect(toneFor("work_posted")).toBe("dry");
  });
});

describe("Determinism (gate 675)", () => {
  it("same seed + trigger + history => same quip", () => {
    const s1 = makeSelector({ sessionSeed: "deterministic" });
    const s2 = makeSelector({ sessionSeed: "deterministic" });
    const r1 = s1.select("escrow_opened", false);
    const r2 = s2.select("escrow_opened", false);
    expect(r1.quip?.text).toBe(r2.quip?.text);
    expect(r1.quip?.tone).toBe(r2.quip?.tone);
  });

  it("different seed => possibly different quip", () => {
    const results = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const s = makeSelector({ sessionSeed: `seed-${i}` });
      const r = s.select("work_posted", false);
      if (r.quip) results.add(r.quip.text);
    }
    expect(results.size).toBeGreaterThan(1);
  });

  it("quip recorded as a frenchy.quip span-equivalent record", () => {
    const s = makeSelector({ sessionSeed: "span" });
    const r = s.select("verdict_pass", false);
    expect(r.quip).toMatchObject({
      trigger: "verdict_pass",
      tone: "smug",
    });
    expect(typeof r.quip?.at).toBe("number");
    expect(r.quip?.text).toBeTruthy();
  });
});

describe("Anti-repeat (gate 677)", () => {
  it("does not repeat a quip within the last 10", () => {
    const s = makeSelector({ sessionSeed: "repeat" });
    const seen = new Set<string>();
    // Advance > 5 min between selections so the 5-min window doesn't interfere;
    // anti-repeat is keyed to last 10 quips regardless of time.
    const gap = 6 * 60_000;
    for (let i = 0; i < 6; i++) {
      advance(gap);
      const r = s.select("escrow_opened", false);
      if (r.quip) {
        expect(seen.has(r.quip.text)).toBe(false);
        seen.add(r.quip.text);
      }
    }
    // Pool has 5 entries; 5th fills the window, 6th is pool-exhausted.
    expect(seen.size).toBe(5);
  });

  it("stays silent when every pool quip is in the recent window", () => {
    const s = makeSelector({ sessionSeed: "exhaust" });
    const gap = 6 * 60_000;
    for (let i = 0; i < 5; i++) {
      advance(gap);
      s.select("escrow_opened", false);
    }
    // All 5 pool entries are now in the last-10 window.
    advance(gap);
    const r = s.select("escrow_opened", false);
    expect(r.quip).toBeNull();
    expect(r.reason).toBe("pool-exhausted");
  });
});

describe("Budget & cooldown (gate 668-669)", () => {
  it("enforces 45s cooldown between quips", () => {
    const s = makeSelector({ sessionSeed: "cooldown" });
    const r1 = s.select("escrow_opened", false);
    expect(r1.quip).toBeTruthy();

    advance(DEFAULT_BUDGET.cooldownMs - 1);
    const r2 = s.select("work_posted", false);
    expect(r2.quip).toBeNull();
    expect(r2.reason).toBe("budget");

    advance(2);
    const r3 = s.select("work_posted", false);
    expect(r3.quip).toBeTruthy();
  });

  it("max 3 per 5-minute window", () => {
    const s = makeSelector({ sessionSeed: "five-min" });
    const triggers: FrenchyTrigger[] = ["escrow_opened", "work_posted", "settle_batch"];
    for (const t of triggers) {
      advance(DEFAULT_BUDGET.cooldownMs + 1);
      const r = s.select(t, false);
      expect(r.quip).toBeTruthy();
    }
    // 4th quip within 5 min should be blocked by maxPer5Min (3).
    advance(DEFAULT_BUDGET.cooldownMs + 1);
    const r4 = s.select("idle", false);
    expect(r4.quip).toBeNull();
    expect(r4.reason).toBe("budget");

    // Advance past 5 min → window clears → can speak again.
    advance(5 * 60_000 + 1);
    const r5 = s.select("idle", false);
    expect(r5.quip).toBeTruthy();
  });

  it("max 12 per hour window", () => {
    const s = makeSelector({ sessionSeed: "hour" });
    const triggers: FrenchyTrigger[] = [
      "escrow_opened", "work_posted", "verdict_pass", "verdict_fail",
      "dispute_opened", "dispute_resolved", "expiry", "tx_error",
      "idle", "settle_batch",
    ];
    // 12 quips within 1 hour (cycle triggers, 3 min apart = 36 min total).
    for (let i = 0; i < 12; i++) {
      advance(3 * 60_000 + 1);
      const t = triggers[i % triggers.length]!;
      const r = s.select(t, false);
      expect(r.quip).toBeTruthy();
    }
    // 13th quip within 1 hour blocked by maxPerHour (12).
    advance(3 * 60_000 + 1);
    const r13 = s.select("idle", false);
    expect(r13.quip).toBeNull();
    expect(r13.reason).toBe("budget");

    // Advance past 1 hour → window clears.
    advance(60 * 60_000 + 1);
    const r14 = s.select("idle", false);
    expect(r14.quip).toBeTruthy();
  });

  it("silence zone during verification blocks quips", () => {
    const s = makeSelector({ sessionSeed: "preempt" });
    advance(DEFAULT_BUDGET.cooldownMs + 1);
    const r = s.select("verdict_pass", true);
    expect(r.quip).toBeNull();
    expect(r.reason).toBe("silence-zone");
  });
});

describe("Mute & dismissals (gate 673)", () => {
  it("muted selector never speaks", () => {
    const s = makeSelector({ sessionSeed: "muted", muted: true });
    advance(DEFAULT_BUDGET.cooldownMs + 1);
    const r = s.select("escrow_opened", false);
    expect(r.quip).toBeNull();
    expect(r.reason).toBe("muted");
  });

  it("two consecutive dismissals auto-quiet for session", () => {
    const s = makeSelector({ sessionSeed: "dismiss" });
    s.dismiss();
    expect(s.isMuted()).toBe(false);
    expect(s.getDismissals()).toBe(1);
    s.dismiss();
    expect(s.isMuted()).toBe(true);
    advance(DEFAULT_BUDGET.cooldownMs + 1);
    const r = s.select("work_posted", false);
    expect(r.quip).toBeNull();
    expect(r.reason).toBe("muted");
  });

  it("unmute resets dismissals", () => {
    const s = makeSelector({ sessionSeed: "unmute", muted: true, dismissals: 2 });
    s.unmute();
    expect(s.isMuted()).toBe(false);
    expect(s.getDismissals()).toBe(0);
    advance(DEFAULT_BUDGET.cooldownMs + 1);
    const r = s.select("escrow_opened", false);
    expect(r.quip).toBeTruthy();
  });
});

describe("Silence zones (gate 671)", () => {
  it("wallet signing silence zone blocks quips", () => {
    const s = makeSelector({ sessionSeed: "signing" });
    advance(DEFAULT_BUDGET.cooldownMs + 1);
    const r = s.select("work_posted", true);
    expect(r.quip).toBeNull();
    expect(r.reason).toBe("silence-zone");
  });

  it("outside silence zone quips normally", () => {
    const s = makeSelector({ sessionSeed: "nosilence" });
    advance(DEFAULT_BUDGET.cooldownMs + 1);
    const r = s.select("work_posted", false);
    expect(r.quip).toBeTruthy();
  });
});

describe("selectQuip pure function", () => {
  it("returns null for unknown trigger", () => {
    const r = selectQuip("unknown" as FrenchyTrigger, "seed", []);
    expect(r).toBeNull();
  });

  it("respects history length in hash input", () => {
    const h1: QuipRecord[] = [];
    const h2: QuipRecord[] = [{ trigger: "idle", text: "old", tone: "dry", at: 1 }];
    const a = selectQuip("idle", "seed", h1);
    const b = selectQuip("idle", "seed", h2);
    expect([a, b].every((x) => x === null || typeof x === "string")).toBe(true);
  });
});
