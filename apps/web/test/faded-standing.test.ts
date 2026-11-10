import { describe, expect, it } from "vitest";
import type { ApiTrial } from "@crucible/indexer";
import { fadedStanding } from "../src/lib/faded-standing";

const NOW = 1_700_000_000;
const DAY = 86_400;

function trial(overrides: Partial<ApiTrial> = {}): ApiTrial {
  return {
    id: 1,
    sponsor: "0x" + "11".repeat(20),
    specCID: null,
    testsCID: null,
    specDigest: "0x" + "aa".repeat(32),
    testsDigest: "0x" + "bb".repeat(32),
    rewardEth: "0.01",
    rewardWei: "10000000000000000",
    bondEth: "0.005",
    createdAt: NOW - 90 * DAY,
    deadline: NOW - 80 * DAY,
    breakWindow: 43_200,
    agentId: 7,
    operator: "0x" + "22".repeat(20),
    runHash: null,
    runAt: null,
    breakSkeptic: null,
    breakStakeEth: null,
    status: "settled",
    verdict: "paid",
    deadlineAt: null,
    breakWindowEndsAt: null,
    awaitingDisclosure: false,
    settledAt: NOW - 45 * DAY,
    disputeOpenedAt: null,
    dispute: null,
    ...overrides,
  };
}

describe("fadedStanding", () => {
  it("ages outcomes identically whether `now` arrives in milliseconds or seconds", () => {
    // The snapshot carries `Date.now()` (ms) while settledAt is chain seconds — a
    // mixed-unit age must not silently zero out every outcome (the hall read exactly 500).
    const seconds = fadedStanding([trial()], 7, NOW);
    const millis = fadedStanding([trial()], 7, NOW * 1000);
    expect(millis.display).toEqual(seconds.display);
    expect(millis.counted).toBe(seconds.counted);
  });

  it("matches §18.2 arithmetic for one floor-sized win 45 days old", () => {
    // δ = 2^(−45/45) = 0.5; weight = log2(1 + 1) = 1; value = 1.0 (unchallenged pass).
    // standing = (1 · 1 · 0.5 · 0.5) / (1 · 1 · 0.5 · 0.5 + 3) = 0.25 / 3.25 ≈ 0.0769
    // display  = 500 + 250 · standing ≈ 519.23
    const s = fadedStanding([trial()], 7, NOW);
    expect(s.counted).toBe(1);
    expect(s.unaged).toBe(0);
    expect(s.display).toBeCloseTo(519.23, 1);
    expect(s.halfLifeDays).toBe(45);
  });

  it("refuses a score when every outcome lacks a settlement time — never aged from submission", () => {
    const s = fadedStanding([trial({ settledAt: null })], 7, NOW);
    expect(s.counted).toBe(0);
    expect(s.unaged).toBe(1);
    expect(s.display).toBeNull();
  });

  it("excludes outcomes settled before the current identity epoch opened (ADR-0012)", () => {
    const s = fadedStanding([trial()], 7, NOW, NOW - 1 * DAY);
    expect(s.excludedPreEpoch).toBe(1);
    expect(s.counted).toBe(0);
    expect(s.display).toBeNull();
  });

  it("keeps the aged outcome and reports the unaged one beside it", () => {
    const s = fadedStanding([trial({ id: 1 }), trial({ id: 2, settledAt: null })], 7, NOW);
    expect(s.counted).toBe(1);
    expect(s.unaged).toBe(1);
    expect(s.display).not.toBeNull();
  });

  it("does not count a refund — nobody won, nobody failed", () => {
    const s = fadedStanding([trial({ verdict: "refunded" })], 7, NOW);
    expect(s.counted).toBe(0);
    expect(s.unaged).toBe(0);
    expect(s.display).toBeNull();
  });

  it("ignores other agents' trials and non-settled trials", () => {
    const s = fadedStanding([trial({ agentId: 8 }), trial({ status: "judging", settledAt: null })], 7, NOW);
    expect(s.counted).toBe(0);
    expect(s.unaged).toBe(0);
    expect(s.display).toBeNull();
  });
});


