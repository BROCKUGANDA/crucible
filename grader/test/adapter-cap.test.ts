import { describe, expect, it } from "vitest";
import { ADAPTER_CAP } from "../src/adapter.js";
import { buildAdapter } from "../src/adapter.js";
import type { AdapterConfig } from "../src/adapter.js";
import { StubModelAdapter } from "../src/eval/adapters/stub.js";
import { SpendLedger, type ModelCard } from "../src/eval/frontier.js";

const CARD: ModelCard = {
  id: "gpt-5.2",
  dialect: "openai-compat",
  snapshot: "gpt-5.2-2026-03-11",
  pinnedAt: "2026-03-15",
  roles: ["contestant"],
  retention: {
    retention: "zero-retention-api",
    reviewedAt: "2026-03-01",
    source: "provider terms, read 2026-03-01",
  },
  budgetUsd: { stage: 40, day: 120 },
  costPerCallUsd: 0.004,
  maxCallsPerStage: 10_000,
  latencyP95Ms: 20_000,
};

describe("Adapter cap (gate 439)", () => {
  it("exactly 4 adapter files are permitted", () => {
    expect(ADAPTER_CAP).toEqual([
      "stub.ts",
      "openai-compat.ts",
      "anthropic.ts",
      "google.ts",
    ]);
    expect(ADAPTER_CAP.length).toBe(4);
  });
});

describe("Config-row test (gate 440)", () => {
  it("builds a stub adapter from a config row with zero code change", () => {
    const config: AdapterConfig = {
      kind: "stub",
      modelId: "stub",
      promptVersion: "pv7",
    };
    const adapter = buildAdapter(config);
    expect(adapter.id).toBe("stub");
  });

  it("builds an openai-compat adapter from a config row", () => {
    // The row now carries the frontier governance (gate 503): this is still one JSON row and zero
    // code per model — the card is part of the row, not a second place to configure.
    const config: AdapterConfig = {
      kind: "openai-compat",
      modelId: "gpt-5.2",
      promptVersion: "pv7",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-5.2",
      card: CARD,
      spend: new SpendLedger(),
      scope: "full",
    };
    const adapter = buildAdapter(config);
    expect(adapter.id).toBe("gpt-5.2");
  });

  it("refuses a paid dialect whose row carries no card, ledger or scope", () => {
    const bare: AdapterConfig = {
      kind: "openai-compat",
      modelId: "gpt-5.2",
      promptVersion: "pv7",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-5.2",
    };
    expect(() => buildAdapter(bare)).toThrow(/needs a card and a spend ledger/);

    // A row with governance but no stage cannot be capped: there is no stage total to compare
    // against, so the budget becomes decorative. This is the second branch, not a repeat.
    const unscoped: AdapterConfig = { ...bare, card: CARD, spend: new SpendLedger() };
    expect(() => buildAdapter(unscoped)).toThrow(/needs a scope/);
  });

  it("rejects unknown adapter kinds", () => {
    const config = { kind: "unknown-dialect" } as unknown as AdapterConfig;
    expect(() => buildAdapter(config)).toThrow(/unknown adapter kind/);
  });

  /**
   * The card names the wire, so the wire has to be the one built. Nothing read `dialect` before
   * this, and a card is loaded from JSON at the caller, where any string is possible: a card written
   * for one provider could guard a call to another, and every verdict it stamped would carry a
   * snapshot pin and a retention posture belonging to a model that was never called.
   */
  it("refuses to guard one dialect with a card written for another", () => {
    const mismatched: AdapterConfig = {
      kind: "anthropic",
      modelId: "gpt-5.2",
      promptVersion: "pv7",
      apiKey: "sk-test",
      model: "gpt-5.2",
      card: CARD, // dialect: "openai-compat"
      spend: new SpendLedger(),
      scope: "full",
    };
    expect(() => buildAdapter(mismatched)).toThrow(
      /was handed a card for the "openai-compat" dialect/,
    );

    // The same card on its own dialect still builds, so what is refused is the disagreement and not
    // the card.
    const agreed = buildAdapter({
      ...mismatched,
      kind: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(agreed.id).toBe("gpt-5.2");
  });
});

describe("Stub-only CI (gate 441)", () => {
  it("stub adapter is deterministic with zero network dependency", async () => {
    const adapter = new StubModelAdapter("pv7");
    const art = { claimHash: "claim-1", payload: { index: 1 } };
    const v1 = await adapter.grade(art, "pv7");
    const v2 = await adapter.grade(art, "pv7");
    expect(v1).toEqual(v2);
    expect(["PASS", "VOID", "FAIL"]).toContain(v1.verdict);
  });

  it("stub latency is fast and bounded", async () => {
    const adapter = new StubModelAdapter("pv7");
    const start = Date.now();
    await adapter.grade({ claimHash: "claim-x", payload: {} }, "pv7");
    expect(Date.now() - start).toBeLessThan(100);
  });
});
