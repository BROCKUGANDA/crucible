import { describe, expect, it } from "vitest";
import {
  allocationPolicy,
  consultRisk,
  FACTOR_NEUTRAL,
  FACTOR_TRUSTED,
  FACTOR_UNKNOWN_WALLET,
  type RiskView,
} from "../src/risk.js";

/**
 * The faucet's decision, which is not the identity service's decision.
 *
 * `decide()` in the API returns "deny" for the base rate, and the base rate is what a wallet
 * with no history scores. Wiring that string straight into the faucet refuses the visitor the
 * faucet exists for, so the mapping is asserted here rather than inherited.
 */
function view(over: Partial<RiskView> = {}): RiskView {
  return { pUniqueHuman: 0.1, action: "deny", evidence: [], ...over };
}

describe("faucet allocation policy", () => {
  it("pays a wallet with no history a smaller drip, not nothing", () => {
    // Base rate, no evidence. This is a brand-new visitor.
    expect(allocationPolicy(view()).factor).toBe(FACTOR_UNKNOWN_WALLET);
  });

  it("refuses a wallet with a slash on record", () => {
    // Negative evidence is the only thing that says no.
    const policy = allocationPolicy(view({ evidence: [{ name: "hasSlashes" }], pUniqueHuman: 0.9 }));
    expect(policy.factor).toBe(0);
    expect(policy.reason).toContain("slashes");
  });

  it("scales the drip with the score", () => {
    expect(allocationPolicy(view({ pUniqueHuman: 0.8 })).factor).toBe(FACTOR_TRUSTED);
    expect(allocationPolicy(view({ pUniqueHuman: 0.5 })).factor).toBe(FACTOR_NEUTRAL);
  });

  it("does not inherit the identity service's deny string", () => {
    // Same inputs, different payers: a "deny" action with no negative evidence still funds.
    const policy = allocationPolicy(view({ action: "deny", evidence: [{ name: "hasWonTrial" }] }));
    expect(policy.factor).toBeGreaterThan(0);
  });
});

function respond(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

const score = (over: Record<string, unknown> = {}) => ({
  score: { pUniqueHuman: 0.8, action: "allow", evidence: [{ name: "hasWonTrial" }], ...over },
});

describe("consulting the identity service", () => {
  it("reads the score from the loopback URL, trailing slash and all", async () => {
    let seen = "";
    const fetchImpl = (async (url: string) => {
      seen = String(url);
      return new Response(JSON.stringify(score()), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await consultRisk("0xAbC", { apiUrl: "http://127.0.0.1:8787/", fetchImpl });
    expect(seen).toBe("http://127.0.0.1:8787/identity/risk/0xAbC");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.view.pUniqueHuman).toBe(0.8);
  });

  it("reports an error status rather than pretending the wallet is clean", async () => {
    const out = await consultRisk("0xabc", { apiUrl: "http://x", fetchImpl: respond({ error: "no" }, 503) });
    expect(out).toEqual({ ok: false, reason: "identity service answered 503" });
  });

  it("reports a body with no usable score", async () => {
    const out = await consultRisk("0xabc", { apiUrl: "http://x", fetchImpl: respond({ score: { pUniqueHuman: "high" } }) });
    expect(out.ok).toBe(false);
  });

  it("reports a timeout instead of hanging the allocation", async () => {
    const fetchImpl = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const out = await consultRisk("0xabc", { apiUrl: "http://x", timeoutMs: 20, fetchImpl });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/timed out/);
  });

  it("refuses to ask an empty URL", async () => {
    const out = await consultRisk("0xabc", { apiUrl: "" });
    expect(out).toEqual({ ok: false, reason: "no identity service configured" });
  });
});
