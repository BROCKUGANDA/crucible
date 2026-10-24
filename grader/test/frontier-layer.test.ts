import { describe, expect, it, vi } from "vitest";
import { Arena } from "../src/eval/arena.js";
import {
  BudgetExhausted,
  CallCeilingReached,
  ModelCardError,
  SpendLedger,
  scrubEgress,
  validateModelCard,
  withFrontierGuard,
  type ModelCard,
} from "../src/eval/frontier.js";
import { DEFAULT_THRESHOLDS } from "../src/eval/arena.js";
import { buildAdapter } from "../src/adapter.js";
import type { Artifact, ModelAdapter } from "../src/eval/types.js";

const SECRET = "0x59c6995e998f97a5a0044966f0945389dc98a1073772777215dc9d3f5d5d0b4f";

function card(over: Partial<ModelCard> = {}): ModelCard {
  return {
    id: "gpt-frontier",
    dialect: "openai-compat",
    snapshot: "gpt-frontier-2026-03-11",
    pinnedAt: "2026-03-15",
    roles: ["contestant"],
    retention: {
      retention: "zero-retention-api",
      reviewedAt: "2026-03-01",
      source: "provider terms, /api/pricing, read 2026-03-01",
    },
    budgetUsd: { stage: 40, day: 120 },
    costPerCallUsd: 0.001,
    // Generous by default so the dollar-budget tests below are testing the dollar budget.
    maxCallsPerStage: 10_000,
    latencyP95Ms: 20_000,
    ...over,
  };
}

function artifact(payload: unknown): Artifact {
  return { claimHash: "0xclaim", payload, expectedVerdict: "PASS", suite: "smoke" };
}

describe("the card refuses to be a guess", () => {
  it("accepts a complete card", () => {
    expect(() => validateModelCard(card())).not.toThrow();
  });

  it("refuses a moving snapshot alias", () => {
    expect(() => validateModelCard(card({ snapshot: "gpt-frontier:latest" }))).toThrow(/moving alias/);
  });

  it("refuses an empty snapshot", () => {
    expect(() => validateModelCard(card({ snapshot: "  " }))).toThrow(/exact pin/);
  });

  it("refuses 'unknown' retention instead of letting it pass through", () => {
    expect(() =>
      validateModelCard(card({ retention: { ...card().retention, retention: "unknown" } })),
    ).toThrow(/retention posture is unknown/);
  });

  it("refuses a posture with no citation and no review date", () => {
    expect(() =>
      validateModelCard(card({ retention: { retention: "api-logs-retained", reviewedAt: "soon", source: "" } })),
    ).toThrow(/ISO date|source/);
  });

  it("refuses a zero budget rather than reading it as unlimited", () => {
    expect(() => validateModelCard(card({ budgetUsd: { stage: 0, day: 10 } }))).toThrow(/positive/);
  });
});

describe("egress scrubber", () => {
  it("removes every secret shape it is meant to remove, and names them", () => {
    const payload = {
      spec: `sign with ${SECRET} then Bearer sk-proj-abcdefghijklmnop1234`,
      env: "RPC_URL=http://10.0.0.4:8545 AUTH_SECRET=hunterhunterhunter2",
      where: "read C:\\Users\\operator\\.env for context",
    };
    const { text, findings } = scrubEgress(payload);

    expect(findings).toEqual(expect.arrayContaining(["private-key", "bearer-token", "env-assignment", "host-path"]));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("hunterhunterhunter2");
    expect(text).not.toContain("C:\\Users\\operator");
    expect(text).toContain("redacted");
  });

  it("removes a PEM block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj3\n-----END RSA PRIVATE KEY-----";
    const { text, findings } = scrubEgress({ key: pem });
    expect(findings).toContain("pem-block");
    expect(text).not.toContain("MIIBOgIBAAJBAKj3");
  });

  it("leaves an ordinary artifact alone, so the model still sees the work", () => {
    const payload = { files: { "src/Vault.sol": "function deposit() external payable {}" } };
    const { text, findings } = scrubEgress(payload);
    expect(findings).toEqual([]);
    expect(text).toContain("function deposit()");
  });

  it("scrubs a string payload, not only an object one", () => {
    const { findings } = scrubEgress(`key ${SECRET}`);
    expect(findings).toContain("private-key");
  });
});

describe("the wrapper is the integration point", () => {
  it("hands the inner adapter a scrubbed payload and never the key", async () => {
    const seen: unknown[] = [];
    const inner: ModelAdapter = {
      id: "gpt-frontier",
      async grade(a) {
        seen.push(a.payload);
        return { verdict: "PASS", confidence: 0.9, latencyMs: 5, promptVersion: "v1" };
      },
    };
    const guarded = withFrontierGuard(inner, card(), new SpendLedger(), { scope: "smoke" });
    await guarded.grade(artifact({ spec: `use ${SECRET} to sign` }), "v1");

    expect(JSON.stringify(seen[0])).not.toContain(SECRET);
  });

  it("records which categories were redacted, per artifact", async () => {
    const inner: ModelAdapter = {
      id: "gpt-frontier",
      async grade() {
        return { verdict: "PASS", confidence: 0.9, latencyMs: 5, promptVersion: "v1" };
      },
    };
    const onRedaction = vi.fn();
    const guarded = withFrontierGuard(inner, card(), new SpendLedger(), { scope: "smoke", onRedaction });
    await guarded.grade(artifact({ p: SECRET }), "v1");
    expect(onRedaction).toHaveBeenCalledWith(expect.arrayContaining(["private-key"]), expect.anything());
  });

  it("refuses a card that describes a different model than the adapter it guards", () => {
    const inner: ModelAdapter = {
      id: "other-model",
      async grade() {
        return { verdict: "PASS", confidence: 0.9, latencyMs: 1, promptVersion: "v1" };
      },
    };
    expect(() => withFrontierGuard(inner, card(), new SpendLedger(), { scope: "smoke" })).toThrow(ModelCardError);
  });
});

describe("spend governance caps before the money moves", () => {
  function countingInner(id: string) {
    const calls: number[] = [];
    const adapter: ModelAdapter = {
      id,
      async grade() {
        calls.push(1);
        return { verdict: "PASS", confidence: 0.9, latencyMs: 5, promptVersion: "v1" };
      },
    };
    return { adapter, calls: () => calls.length };
  }

  it("stops at the daily cap, and spends nothing on the refused call", async () => {
    const ledger = new SpendLedger();
    const { adapter, calls } = countingInner("gpt-frontier");
    const guarded = withFrontierGuard(adapter, card({ costPerCallUsd: 0.004, budgetUsd: { stage: 100, day: 0.01 } }), ledger, {
      scope: "full",
    });

    await guarded.grade(artifact("a"), "v1");
    await guarded.grade(artifact("b"), "v1");
    await expect(guarded.grade(artifact("c"), "v1")).rejects.toThrow(BudgetExhausted);

    expect(calls()).toBe(2); // the third never reached the model
    expect(ledger.dayUsd("gpt-frontier")).toBeCloseTo(0.008, 10);
  });

  it("enforces the stage cap independently of the day cap", async () => {
    const ledger = new SpendLedger();
    const { adapter } = countingInner("gpt-frontier");
    const guarded = withFrontierGuard(adapter, card({ costPerCallUsd: 0.004, budgetUsd: { stage: 0.004, day: 100 } }), ledger, {
      scope: "adversarial",
    });

    await guarded.grade(artifact("a"), "v1");
    await expect(guarded.grade(artifact("b"), "v1")).rejects.toThrow(/stage budget exhausted/);
    expect(ledger.dayUsd("gpt-frontier")).toBeCloseTo(0.004, 10);
  });

  it("names the stub-tier fallback in the refusal instead of suggesting a wider cap", async () => {
    const ledger = new SpendLedger();
    const { adapter } = countingInner("gpt-frontier");
    const guarded = withFrontierGuard(adapter, card({ costPerCallUsd: 1, budgetUsd: { stage: 0.5, day: 0.5 } }), ledger, {
      scope: "smoke",
    });
    await expect(guarded.grade(artifact("a"), "v1")).rejects.toThrow(/fall back to the stub tier/);
  });
});

/**
 * A dollar cap cannot fire when the price is zero: `spent + 0 > cap` is false for every positive
 * cap. Unmetered catalogs are exactly that, and the arena's ladder is the runaway — 200 artifacts
 * at 20 retests is 4000 calls per candidate. These tests are about the ceiling that does bind.
 */
describe("the call ceiling caps what the dollar budget cannot", () => {
  function counting(id: string) {
    const calls: number[] = [];
    const adapter: ModelAdapter = {
      id,
      async grade() {
        calls.push(1);
        return { verdict: "PASS", confidence: 0.9, latencyMs: 5, promptVersion: "v1" };
      },
    };
    return { adapter, calls: () => calls.length };
  }

  it("refuses a zero-priced model that the dollar budget would have waved through", async () => {
    const ledger = new SpendLedger();
    const { adapter, calls } = counting("gpt-frontier");
    const guarded = withFrontierGuard(
      adapter,
      // Every dollar figure here is permissive. Under the old guard this adapter never refused.
      card({ costPerCallUsd: 0, budgetUsd: { stage: 1_000, day: 10_000 }, maxCallsPerStage: 2 }),
      ledger,
      { scope: "smoke" },
    );

    await guarded.grade(artifact("a"), "v1");
    await guarded.grade(artifact("b"), "v1");
    await expect(guarded.grade(artifact("c"), "v1")).rejects.toThrow(CallCeilingReached);

    expect(calls()).toBe(2); // the third never reached the model
    expect(ledger.dayUsd("gpt-frontier")).toBe(0);
    expect(ledger.stageCallCount("gpt-frontier", "smoke")).toBe(2);
  });

  it("counts the ceiling per stage, so one stage cannot spend another's calls", async () => {
    const ledger = new SpendLedger();
    const { adapter } = counting("gpt-frontier");
    const smoke = withFrontierGuard(adapter, card({ costPerCallUsd: 0, maxCallsPerStage: 1 }), ledger, {
      scope: "smoke",
    });
    const full = withFrontierGuard(adapter, card({ costPerCallUsd: 0, maxCallsPerStage: 1 }), ledger, {
      scope: "full",
    });

    await smoke.grade(artifact("a"), "v1");
    await full.grade(artifact("b"), "v1");
    await expect(smoke.grade(artifact("c"), "v1")).rejects.toThrow(/call ceiling reached on stage "smoke"/);
    await expect(full.grade(artifact("d"), "v1")).rejects.toThrow(/call ceiling reached on stage "full"/);

    expect(ledger.stageCallCount("gpt-frontier", "smoke")).toBe(1);
    expect(ledger.stageCallCount("gpt-frontier", "full")).toBe(1);
    expect(ledger.callCount("gpt-frontier")).toBe(2);
  });

  it("says to narrow the stage rather than to raise the ceiling", async () => {
    const ledger = new SpendLedger();
    const { adapter } = counting("gpt-frontier");
    const guarded = withFrontierGuard(adapter, card({ costPerCallUsd: 0, maxCallsPerStage: 1 }), ledger, {
      scope: "adversarial",
    });

    await guarded.grade(artifact("a"), "v1");
    await expect(guarded.grade(artifact("b"), "v1")).rejects.toThrow(/Narrow the stage/);
  });

  /** A ceiling that survived `reset()` would carry one run's calls into the next. */
  it("clears the stage count on reset, so a new run starts with its full ceiling", async () => {
    const ledger = new SpendLedger();
    const { adapter } = counting("gpt-frontier");
    const guarded = withFrontierGuard(adapter, card({ costPerCallUsd: 0, maxCallsPerStage: 1 }), ledger, {
      scope: "smoke",
    });

    await guarded.grade(artifact("a"), "v1");
    await expect(guarded.grade(artifact("b"), "v1")).rejects.toThrow(CallCeilingReached);

    ledger.reset();
    expect(ledger.stageCallCount("gpt-frontier", "smoke")).toBe(0);
    await expect(guarded.grade(artifact("c"), "v1")).resolves.toBeDefined();
  });

  it("refuses a card whose ceiling could not fire, or could not be met", () => {
    expect(() => validateModelCard(card({ maxCallsPerStage: 0 }))).toThrow(/positive integer/);
    expect(() => validateModelCard(card({ maxCallsPerStage: -5 }))).toThrow(/positive integer/);
    expect(() => validateModelCard(card({ maxCallsPerStage: 2.5 }))).toThrow(/positive integer/);
    // Absent is not zero: a card that forgot the field must not read as "unmetered".
    const { maxCallsPerStage: _dropped, ...withoutCeiling } = card();
    expect(() => validateModelCard(withoutCeiling as ModelCard)).toThrow(/positive integer/);
  });
});

describe("the door is guarded, not merely guardable", () => {
  it("buildAdapter returns an adapter that refuses when the card's budget is already spent", async () => {
    // cost > day budget, so the FIRST call is refused before any socket opens — the assertion is
    // that the factory's product carries the guard, and it needs no network to prove it.
    const adapter = buildAdapter({
      kind: "openai-compat",
      modelId: "gpt-frontier",
      promptVersion: "v1",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "sk-test",
      model: "gpt-frontier",
      card: card({ costPerCallUsd: 2, budgetUsd: { stage: 1, day: 1 } }),
      spend: new SpendLedger(),
      scope: "smoke",
    });

    await expect(adapter.grade(artifact("anything"), "v1")).rejects.toThrow(/budget exhausted/);
  });
});

describe("cost reaches the scorecard instead of being declared zero", () => {
  it("publishes the measured average per verdict", async () => {
    const ledger = new SpendLedger();
    const inner: ModelAdapter = {
      id: "gpt-frontier",
      async grade() {
        return { verdict: "PASS", confidence: 0.9, latencyMs: 5, promptVersion: "v1" };
      },
    };
    const guarded = withFrontierGuard(inner, card({ costPerCallUsd: 0.0025 }), ledger, { scope: "smoke" });

    const suites = {
      smoke: () => [artifact("a"), artifact("b"), artifact("c")].map((a, i) => ({ ...a, claimHash: `0x${i}` })),
    };
    const arena = new Arena(undefined, ledger);
    const scorecard = await arena.runSmoke([guarded], suites, 1, DEFAULT_THRESHOLDS);
    const measured = scorecard.rows[0]!;

    expect(measured.avgCostUsd).toBeCloseTo(0.0025, 12);
    expect(measured.avgCostUsd).not.toBe(0);
  });
});
