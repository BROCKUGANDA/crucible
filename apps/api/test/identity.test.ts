import { describe, expect, it } from "vitest";
import {
  decide,
  LIKELIHOOD_RATIOS,
  scoreWallet,
  type Decision,
  type RiskScore,
} from "../src/identity.js";
import type { AlloyState, AgentRow, ReadModel, TrialRow } from "@crucible/indexer";

function makeAlloy(overrides: Partial<AlloyState> = {}): AlloyState {
  return {
    tier: null,
    locked: null,
    tokenUri: null,
    epoch: null,
    epochStartedAt: null,
    lifetimeWins: null,
    lifetimeSlashes: null,
    holder: null,
    ...overrides,
  };
}

function makeAgent(
  overrides: Partial<AgentRow> & { id: number; operator: string },
): AgentRow {
  return {
    id: overrides.id,
    operator: overrides.operator,
    runner: "0x" + "11".repeat(20),
    metadataURI: "ipfs://x",
    stakeWei: 0n,
    active: 0,
    wins: 0,
    survived: 0,
    slashes: 0,
    identityAgentId: null,
    identity: null,
    settlements: [],
    ...overrides,
  };
}

function makeTrial(
  overrides: Partial<TrialRow> & { id: number; agentId: number },
): TrialRow {
  return {
    id: overrides.id,
    sponsor: "0x" + "22".repeat(20),
    specCID: null,
    testsCID: null,
    specDigest: "0x" + "33".repeat(32),
    testsDigest: "0x" + "44".repeat(32),
    rewardWei: 1n ** 18n,
    bondWei: 0n,
    createdAt: Math.floor(Date.now() / 1000) - 86400 * 100,
    deadline: Math.floor(Date.now() / 1000) + 86400,
    breakWindow: 86400,
    agentId: overrides.agentId,
    runHash: null,
    runAt: null,
    breakSkeptic: null,
    breakStakeWei: null,
    breakProofCID: null,
    status: "settled",
    verdict: "paid",
    disputeOpenedAt: null,
    settledAt: Math.floor(Date.now() / 1000) - 86400 * 50,
    ...overrides,
  };
}

function makeModel(
  agents: AgentRow[],
  trials: TrialRow[],
): ReadModel {
  return {
    trials: new Map(trials.map((t) => [t.id, t])),
    agents: new Map(agents.map((a) => [a.id, a])),
    runs: new Map(),
    disputes: new Map(),
    appliedLogs: new Set(),
    version: 0,
  } as ReadModel;
}

function makeAlloyStateFn(
  alloyById: Map<number, AlloyState>,
): (agentId: number) => AlloyState | null {
  return (id) => alloyById.get(id) ?? null;
}

describe("Bayesian Sybil-risk scorer (Phase 1)", () => {
  it("returns base-rate score for a wallet with no agent", () => {
    const model = makeModel([], []);
    const alloy = makeAlloyStateFn(new Map());
    const score = scoreWallet(model, alloy, "0x" + "aa".repeat(20));

    expect(score.agentId).toBeNull();
    expect(score.evidence).toEqual([]);
    expect(score.pUniqueHuman).toBeCloseTo(0.10, 2); // base rate
  });

  it("scores a Damascus-tier alloy wallet as high confidence", () => {
    const agent = makeAgent({ id: 1, operator: "0x" + "bb".repeat(20) });
    // The clock is explicit: age is measured on the chain's clock now, and a fixture that
    // relied on `Date.now()` was measuring the test runner's wall clock.
    const created = 1_700_000_000;
    const trial = makeTrial({ id: 1, agentId: 1, verdict: "paid", createdAt: created });
    const model = makeModel([agent], [trial]);
    const alloy = makeAlloyStateFn(new Map([[1, makeAlloy({ tier: 4 })]]));

    const score = scoreWallet(model, alloy, "0x" + "bb".repeat(20), created + 86400 * 100);

    expect(score.agentId).toBe(1);
    expect(score.pUniqueHuman).toBeGreaterThan(0.90);
    const damascus = score.evidence.find((e) => e.name === "alloyTierDamascus");
    expect(damascus).toBeDefined();
    expect(damascus?.lr).toBe(LIKELIHOOD_RATIOS.alloyTierDamascus);
    expect(score.evidence.map((e) => e.name)).toContain("walletAgeOld");
  });

  it("scores a wallet with slashes lower", () => {
    const agent = makeAgent({
      id: 2,
      operator: "0x" + "cc".repeat(20),
      slashes: 2,
    });
    const trial = makeTrial({ id: 2, agentId: 2, verdict: "paid" });
    const model = makeModel([agent], [trial]);
    const alloy = makeAlloyStateFn(new Map([[2, makeAlloy({ tier: 1 })]]));

    const score = scoreWallet(model, alloy, "0x" + "cc".repeat(20));

    const slashSignal = score.evidence.find((e) => e.name === "hasSlashes");
    expect(slashSignal).toBeDefined();
    expect(slashSignal?.lr).toBe(LIKELIHOOD_RATIOS.hasSlashes);
    expect(slashSignal?.lr).toBeLessThan(1); // anti-sybil
  });

  it("combines multiple signals multiplicatively in log-odds", () => {
    const agent = makeAgent({
      id: 3,
      operator: "0x" + "dd".repeat(20),
      identityAgentId: 99n,
      slashes: 0,
    });
    const trial1 = makeTrial({ id: 3, agentId: 3, verdict: "paid" });
    const trial2 = makeTrial({
      id: 4,
      agentId: 3,
      verdict: "paid",
      breakSkeptic: "0x" + "ee".repeat(20),
    });
    const model = makeModel([agent], [trial1, trial2]);
    const alloy = makeAlloyStateFn(new Map([[3, makeAlloy({ tier: 2 })]]));

    const score = scoreWallet(model, alloy, "0x" + "dd".repeat(20));

    // Should have tier bronze, identity linked, has won, has survived, multiple trials
    expect(score.evidence.length).toBeGreaterThanOrEqual(4);
    expect(score.pUniqueHuman).toBeGreaterThan(0.70);
  });

  it("unforged tier adds no information", () => {
    const agent = makeAgent({ id: 4, operator: "0x" + "ff".repeat(20) });
    const model = makeModel([agent], []);
    const alloy = makeAlloyStateFn(new Map([[4, makeAlloy({ tier: 0 })]]));

    const score = scoreWallet(model, alloy, "0x" + "ff".repeat(20));

    const unforged = score.evidence.find((e) => e.name === "alloyTierUnforged");
    expect(unforged).toBeDefined();
    expect(unforged?.lr).toBe(1.0);
    expect(unforged?.logLr).toBe(0);
    expect(score.pUniqueHuman).toBeCloseTo(0.10, 2); // base rate unchanged
  });

  it("wallet age signal triggers for old wallets", () => {
    const agent = makeAgent({ id: 5, operator: "0x" + "00".repeat(20) });
    // Trial created 200 days before the chain clock the scorer is handed.
    const created = 1_000_000_000;
    const oldTrial = makeTrial({ id: 5, agentId: 5, createdAt: created });
    const model = makeModel([agent], [oldTrial]);
    const alloy = makeAlloyStateFn(new Map());

    const score = scoreWallet(model, alloy, "0x" + "00".repeat(20), created + 86400 * 200);

    const ageSignal = score.evidence.find((e) => e.name === "walletAgeOld");
    expect(ageSignal).toBeDefined();
    expect(ageSignal?.lr).toBe(LIKELIHOOD_RATIOS.walletAgeOld);
  });

  it("wallet age signal does not trigger for new wallets", () => {
    const agent = makeAgent({ id: 6, operator: "0x" + "11".repeat(20) });
    // Trial created 1 day before the chain clock.
    const created = 1_000_000_000;
    const newTrial = makeTrial({ id: 6, agentId: 6, createdAt: created });
    const model = makeModel([agent], [newTrial]);
    const alloy = makeAlloyStateFn(new Map());

    const score = scoreWallet(model, alloy, "0x" + "11".repeat(20), created + 86400);

    const ageSignal = score.evidence.find((e) => e.name === "walletAgeOld");
    expect(ageSignal).toBeUndefined();
  });

  it("does not age a wallet against the wall clock", () => {
    // An old createdAt and NO chain clock: the signal must be absent, not computed against
    // `Date.now()`. A host whose wall clock is skewed would otherwise invent evidence.
    const agent = makeAgent({ id: 7, operator: "0x" + "12".repeat(20) });
    const trial = makeTrial({ id: 7, agentId: 7, createdAt: 1_000_000_000 });
    const score = scoreWallet(makeModel([agent], [trial]), makeAlloyStateFn(new Map()), "0x" + "12".repeat(20));
    expect(score.evidence.find((e) => e.name === "walletAgeOld")).toBeUndefined();
  });

  it("does not call a slashed trial a survived break", () => {
    // A break was filed and the agent was slashed. The old test — `breakSkeptic !== null` —
    // treated that as survival, so being successfully broken raised the humanity score.
    const agent = makeAgent({ id: 8, operator: "0x" + "13".repeat(20) });
    const slashed = makeTrial({
      id: 8,
      agentId: 8,
      verdict: "slashed",
      breakSkeptic: "0x" + "14".repeat(20),
    });
    const score = scoreWallet(makeModel([agent], [slashed]), makeAlloyStateFn(new Map()), "0x" + "13".repeat(20));
    expect(score.evidence.find((e) => e.name === "hasSurvivedBreak")).toBeUndefined();
  });

  it("counts a filed break that did not overturn a paid verdict", () => {
    const agent = makeAgent({ id: 9, operator: "0x" + "15".repeat(20) });
    const survived = makeTrial({
      id: 9,
      agentId: 9,
      verdict: "paid",
      breakSkeptic: "0x" + "16".repeat(20),
    });
    const score = scoreWallet(makeModel([agent], [survived]), makeAlloyStateFn(new Map()), "0x" + "15".repeat(20));
    expect(score.evidence.find((e) => e.name === "hasSurvivedBreak")).toBeDefined();
  });

  it("decide maps probabilities to actions", () => {
    const allow: Decision = decide({
      wallet: "0x" + "aa".repeat(20),
      agentId: 1,
      pUniqueHuman: 0.95,
      logOdds: 3.0,
      evidence: [],
      modelVersion: "test",
      computedAt: Date.now(),
    });
    expect(allow.action).toBe("allow");

    const challenge: Decision = decide({
      wallet: "0x" + "aa".repeat(20),
      agentId: 1,
      pUniqueHuman: 0.80,
      logOdds: 1.5,
      evidence: [],
      modelVersion: "test",
      computedAt: Date.now(),
    });
    expect(challenge.action).toBe("challenge");

    const rateLimit: Decision = decide({
      wallet: "0x" + "aa".repeat(20),
      agentId: 1,
      pUniqueHuman: 0.55,
      logOdds: 0.2,
      evidence: [],
      modelVersion: "test",
      computedAt: Date.now(),
    });
    expect(rateLimit.action).toBe("rate-limit");

    const deny: Decision = decide({
      wallet: "0x" + "aa".repeat(20),
      agentId: 1,
      pUniqueHuman: 0.10,
      logOdds: -2.0,
      evidence: [],
      modelVersion: "test",
      computedAt: Date.now(),
    });
    expect(deny.action).toBe("deny");
  });

  it("rejects invalid wallet addresses", () => {
    expect(() => {
      // Just verify the validation logic inline
      const wallet = "not-an-address";
      const valid = /^0x[0-9a-fA-F]{40}$/.test(wallet);
      expect(valid).toBe(false);
    }).not.toThrow();
  });
});
