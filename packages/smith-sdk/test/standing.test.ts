import { describe, expect, it } from "vitest";

import {
  computeStanding,
  DEFAULT_HALF_LIFE_DAYS,
  outcomeValue,
  STANDING_ASSUMPTIONS,
  type StandingOutcome,
} from "../src/standing.js";

const DAY = 86_400;
const FLOOR = 10n ** 16n; // 0.01 ETH, the mint's floor from params
const NOW = 2_000_000_000;

const outcome = (over: Partial<StandingOutcome> = {}): StandingOutcome => ({
  rewardWei: 10n ** 18n, // 1 ETH = 100 floors
  verdict: "paid",
  breaksSurvived: 0,
  settledAt: NOW - 1 * DAY,
  ...over,
});

const run = (outcomes: StandingOutcome[]) =>
  computeStanding({ outcomes, floorWei: FLOOR, halfLifeDays: 45, now: NOW });

describe("the outcome values of §18.2", () => {
  it("pays +1.00 for an unchallenged pass and more for a survived break", () => {
    expect(outcomeValue(outcome())).toBe(1);
    expect(outcomeValue(outcome({ breaksSurvived: 1 }))).toBe(1.5);
    expect(outcomeValue(outcome({ breaksSurvived: 2 }))).toBe(1.75);
    expect(outcomeValue(outcome({ breaksSurvived: 3 }))).toBe(2);
    // the table stops at +2.00; a fifth break does not make the run more true
    expect(outcomeValue(outcome({ breaksSurvived: 9 }))).toBe(2);
  });

  it("charges −2.00 for a landed break, and the exits between them", () => {
    expect(outcomeValue(outcome({ verdict: "slashed", breaksSurvived: 0 }))).toBe(-2);
    expect(outcomeValue(outcome({ exited: "yield" }))).toBe(-0.25);
    expect(outcomeValue(outcome({ exited: "timeout" }))).toBe(-0.5);
    // a refund is not an outcome for the agent at all: nobody did or failed the work
    expect(outcomeValue(outcome({ verdict: "refunded" }))).toBe(0);
  });
});

describe("Standing itself", () => {
  it("holds a brand-new agent short of the ceiling, because of the +3 prior", () => {
    const s = run([]);
    expect(s.standing).toBe(0);
    expect(s.display).toBe(500);
    expect(s.counted).toBe(0);

    const one = run([outcome()]);
    // A single pass at 100 floors cannot reach +1.00: the denominator's prior is the whole
    // mechanism behind that, and with o = +1 the identity standing = m ÷ (m + 3) is checkable
    // exactly against the decayed weight the result reports.
    expect(one.standing).toBeGreaterThan(0);
    expect(one.standing).toBeLessThan(1);
    expect(one.standing).toBeCloseTo(one.weightMass / (one.weightMass + 3), 3);
    expect(one.display).toBeGreaterThan(500);
    expect(one.display).toBeLessThan(700);
  });

  it("rewards surviving breaks and punishes a landed one, all else equal", () => {
    const clean = run([outcome(), outcome(), outcome()]);
    const scarred = run([outcome({ verdict: "slashed", breaksSurvived: 0 })]);
    const defended = run([
      outcome({ breaksSurvived: 2 }),
      outcome({ breaksSurvived: 2 }),
      outcome({ breaksSurvived: 2 }),
    ]);
    expect(scarred.standing).toBeLessThan(0);
    expect(clean.standing).toBeGreaterThan(0);
    expect(defended.standing).toBeGreaterThan(clean.standing);
  });

  it("weighs a trial by its reward in floors, so 100 floors is not worth 1 floor", () => {
    const small = run([{ ...outcome(), rewardWei: FLOOR }]);
    const hundred = run([outcome()]);
    // log2(1 + 100) over log2(1 + 1): the same verdict, six and two-thirds times the weight.
    // Expressed as a ratio because the absolute numbers are the decay's too, and a test that
    // pins four-decimal float output fails for reasons nobody can read.
    expect(small.weightMass).toBeGreaterThan(0);
    // Two decimals, because weightMass is rounded to 4 for JSON stability and dividing two
    // rounded numbers costs a digit. The claim under test is logarithmic-not-linear weighting —
    // 6.66×, which no reading of a linear or per-wei scheme could produce.
    expect(hundred.weightMass / small.weightMass).toBeCloseTo(Math.log2(101) / Math.log2(2), 2);
    expect(hundred.counted).toBe(small.counted);
  });

  it("halves an outcome's influence every 45 days, exactly once per half-life", () => {
    const fresh = run([outcome({ settledAt: NOW })]);
    const oneHalfLife = run([outcome({ settledAt: NOW - 45 * DAY })]);
    const twoHalfLives = run([outcome({ settledAt: NOW - 90 * DAY })]);

    // Same verdict, same size. Only the age differs, so the ratio IS the decay.
    expect(oneHalfLife.weightMass).toBeCloseTo(fresh.weightMass / 2, 3);
    expect(twoHalfLives.weightMass).toBeCloseTo(fresh.weightMass / 4, 3);
  });

  it("lets the score, not just the weight, fade toward the prior as the history ages out", () => {
    const recent = run([outcome({ verdict: "slashed", settledAt: NOW - DAY })]);
    const ancient = run([outcome({ verdict: "slashed", settledAt: NOW - 365 * DAY })]);
    expect(recent.standing).toBeLessThan(0);
    // the bad outcome still counts, but its weight has decayed toward the +3 prior
    expect(ancient.standing).toBeGreaterThan(recent.standing);
    expect(ancient.standing).toBeGreaterThan(-0.5);
  });

  it("is unaffected by a half-life that is switched off, so the parameter is the whole knob", () => {
    const off = computeStanding({ outcomes: [outcome({ settledAt: NOW - 400 * DAY })], floorWei: FLOOR, halfLifeDays: 0, now: NOW });
    const noDecay = run([outcome({ settledAt: NOW - 400 * DAY })]);
    expect(off.weightMass).toBeGreaterThan(noDecay.weightMass);
  });

  it("refuses to hide the two operands this repository does not measure", () => {
    const s = run([outcome()]);
    expect(s.assumptions).toEqual(STANDING_ASSUMPTIONS);
    const keys = s.assumptions.map((a) => a.key);
    expect(keys).toContain("difficulty");
    expect(keys).toContain("sponsorIndependence");
    // an assumption that does not say what would replace it is a fiction with a label on it
    for (const a of s.assumptions) {
      expect(a.needs.length).toBeGreaterThan(10);
      expect(a.value).toMatch(/neutral|unknown|not counted/);
    }
  });

  it("keeps the display score inside the 0–1000 scale it advertises", () => {
    for (const outcomes of [[], [outcome()], Array.from({ length: 40 }, () => outcome({ breaksSurvived: 3 }))]) {
      const d = run(outcomes).display;
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1000);
    }
    expect(run([outcome({ verdict: "slashed" })]).display).toBeLessThan(500);
  });

  it("defaults its decay to the parameter, so the half-life is not decorative", () => {
    // `standing_half_life_days` existed in params and was read by nothing. This asserts the link
    // in both directions: the exported default equals the generated constant, and a caller that
    // omits the value decays at exactly the same rate as a caller that passes 45.
    expect(DEFAULT_HALF_LIFE_DAYS).toBe(45);
    const omitted = computeStanding({ outcomes: [outcome({ settledAt: NOW - 90 * DAY })], floorWei: FLOOR, now: NOW });
    const explicit = run([outcome({ settledAt: NOW - 90 * DAY })]);
    expect(omitted.halfLifeDays).toBe(DEFAULT_HALF_LIFE_DAYS);
    expect(omitted.weightMass).toBe(explicit.weightMass);
    expect(omitted.weightMass).toBeLessThan(1);
  });

  it("produces a number that survives JSON unchanged, because it is shown as a figure", () => {
    const s = run([outcome(), outcome({ breaksSurvived: 2 })]);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    expect(String(s.display)).not.toMatch(/e[+-]?\d+/i);
  });
});

describe("the identity epoch of ADR-0012", () => {
  const runIn = (outcomes: StandingOutcome[], epochStartedAt: number | null) =>
    computeStanding({ outcomes, floorWei: FLOOR, halfLifeDays: 45, now: NOW, epochStartedAt });

  it("counts only the outcomes the current holder earned", () => {
    const before = outcome({ settledAt: NOW - 30 * DAY });
    const after = outcome({ settledAt: NOW - 1 * DAY, breaksSurvived: 3 });
    const s = runIn([before, after], NOW - 10 * DAY);
    expect(s.counted).toBe(1);
    expect(s.excludedPreEpoch).toBe(1);
    // The excluded pass is not merely dropped: the score is the buyer's alone, so a strong
    // predecessor's history cannot hold the display up.
    expect(s.standing).toBeLessThan(2);
    expect(s.weightMass).toBeLessThan(runIn([after], null).weightMass + 0.0001);
  });

  it("reports the boundary it excluded against, so the exclusion is checkable", () => {
    const s = runIn([outcome({ settledAt: NOW - 5 * DAY })], NOW - 1 * DAY);
    expect(s.epochStartedAt).toBe(NOW - 1 * DAY);
    expect(s.excludedPreEpoch).toBe(1);
    expect(s.counted).toBe(0);
    // Nothing counted is the prior's answer, not a fabricated zero-history badge: 500 with the
    // exclusion published beside it is the honest reading.
    expect(s.display).toBe(500);
  });

  it("treats an unread epoch as no boundary at all, never as the dawn of the chain", () => {
    // `epochStartedAt: null` means the registry was not read. Reading that as 0 would count
    // everything; reading it as "now" would silently exclude everything and publish 500 as if the
    // agent had no history. Both wrong, and only one of them is visible.
    const all = [outcome({ settledAt: NOW - 400 * DAY })];
    expect(runIn(all, null).counted).toBe(1);
    expect(runIn(all, null).excludedPreEpoch).toBe(0);
    expect(runIn(all, undefined).counted).toBe(1);
  });

  it("excludes on the epoch, not on the decay, and the two stay independent", () => {
    const old = outcome({ settledAt: NOW - 40 * DAY });
    const sameDay = outcome({ settledAt: NOW - 40 * DAY, verdict: "slashed" });
    const withEpoch = runIn([old, sameDay], NOW - 20 * DAY);
    const withoutEpoch = run([old, sameDay]);
    expect(withEpoch.counted).toBe(0);
    expect(withoutEpoch.counted).toBe(2);
    // A boundary one day after the other's decay horizon must not change how the surviving
    // outcomes age: the filter removes rows, it does not re-age them.
    const kept = runIn([outcome({ settledAt: NOW - 10 * DAY })], NOW - 20 * DAY);
    expect(kept.weightMass).toBeCloseTo(run([outcome({ settledAt: NOW - 10 * DAY })]).weightMass, 6);
  });
});
