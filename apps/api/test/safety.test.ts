import { afterAll, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  DEFAULT_MODEL_ID,
  MODEL_REGISTRY,
  MODERATION_POLICY_VERSION,
  classifyContent,
  contentDigest,
  moderationSnapshot,
  parseClassification,
  recordModeration,
  resolveSafetyConfig,
  __resetModerationLogForTests,
  type SafetyConfig,
} from "../src/safety.js";
import {
  assertSafetyCasesValid,
  metricsFrom,
  runSafetyBenchmark,
  SAFETY_BENCHMARK_VERSION,
  SAFETY_CASES,
  SAFETY_DIMENSIONS,
} from "../src/safety-benchmark.js";
import { createApp } from "../src/app.js";
import { emptyModel } from "@crucible/indexer";

process.env.AUTH_ALLOW_DEV_SECRET = "1";
process.env.AUTH_ORIGIN = "http://localhost:3000";

const DEV_SECRET = "crucible-local-dev-secret-not-for-production";

const CFG: SafetyConfig = {
  baseUrl: "https://fake.endpoint/v1",
  model: DEFAULT_MODEL_ID,
  modelRevision: "rev-test-1",
  apiKey: "test-key",
  timeoutMs: 5_000,
  retries: 1,
  fetchImpl: undefined,
};

/** A provider answering a well-formed Qwen3Guard-Gen classification. */
function providerReply(safety: string, categories?: string[]) {
  const body = categories
    ? `Safety: ${safety}\nContent Types: ${categories.join(", ")}`
    : `Safety: ${safety}`;
  return vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: body } }] }), { status: 200 }));
}

afterAll(() => __resetModerationLogForTests());

describe("the classification parser", () => {
  it("accepts Safe with no categories", () => {
    expect(parseClassification("Safety: Safe")).toEqual({ verdict: "safe", categories: [] });
  });

  it("accepts Unsafe with categories, sorted, both spellings", () => {
    expect(parseClassification("Safety: Unsafe\nContent Types: weapons, fraud")).toEqual({
      verdict: "unsafe",
      categories: ["fraud", "weapons"],
    });
    expect(parseClassification("Safety: Unsafe\nCategories: weapons")).toEqual({
      verdict: "unsafe",
      categories: ["weapons"],
    });
  });

  it("is case-insensitive over the label", () => {
    expect(parseClassification("safety: SAFE")?.verdict).toBe("safe");
    expect(parseClassification("SAFETY: UNSAFE")?.verdict).toBe("unsafe");
  });

  it("rejects a Safe that smuggles categories in — contradiction, not safety", () => {
    expect(parseClassification("Safety: Safe\nContent Types: weapons")).toBeNull();
  });

  it("returns null on anything ambiguous — and null means error, never safe", () => {
    expect(parseClassification("")).toBeNull();
    expect(parseClassification("I think this is probably fine")).toBeNull();
    expect(parseClassification("Safety: Debatable")).toBeNull();
    expect(parseClassification("Safety:")).toBeNull();
    expect(parseClassification("The content is unsafe to post")).toBeNull();
  });
});

describe("classifyContent — the fail-closed law", () => {
  it("reaches safe only through the provider saying so", async () => {
    const cfg = { ...CFG, fetchImpl: providerReply("Safe") as unknown as typeof fetch };
    const r = await classifyContent(cfg, "hello", "PUBLICATION");
    expect(r.verdict).toBe("safe");
    expect(r.categories).toEqual([]);
    expect(r.modelRevision).toBe("rev-test-1");
    expect(r.policyVersion).toBe(MODERATION_POLICY_VERSION);
  });

  it("answers error on a provider 500 — never safe", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const cfg = { ...CFG, retries: 1, fetchImpl: fetchImpl as unknown as typeof fetch };
    const r = await classifyContent(cfg, "hello", "USER_INPUT");
    expect(r.verdict).toBe("error");
    expect(r.reason).toMatch(/500/);
  });

  it("answers error on an unparseable classification — never safe", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "looks fine to me" } }] }), { status: 200 }),
    );
    const r = await classifyContent({ ...CFG, fetchImpl: fetchImpl as unknown as typeof fetch }, "x", "SUBMISSION");
    expect(r.verdict).toBe("error");
    expect(r.reason).toMatch(/did not parse/);
  });

  it("answers error on a timeout — never safe", async () => {
    const fetchImpl = vi.fn(
      () => new Promise<Response>((_, reject) => setTimeout(() => reject(new DOMException("aborted", "TimeoutError")), 20)),
    );
    const r = await classifyContent(
      { ...CFG, timeoutMs: 50, retries: 0, fetchImpl: fetchImpl as unknown as typeof fetch },
      "x",
      "TOOL_OUTPUT",
    );
    expect(r.verdict).toBe("error");
    expect(r.reason).toMatch(/timed out/);
  });

  it("retries a 429 and succeeds — an idempotent read", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response("slow down", { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "Safety: Safe" } }] }), { status: 200 });
    });
    const r = await classifyContent({ ...CFG, fetchImpl: fetchImpl as unknown as typeof fetch }, "x", "PUBLICATION");
    expect(r.verdict).toBe("safe");
    expect(calls).toBe(2);
  });

  it("refuses content that is unconfigured — unconfigured is a verdict, not safe", async () => {
    const r = await classifyContent({ ...CFG, apiKey: "" }, "x", "SUBMISSION");
    expect(r.verdict).toBe("unconfigured");
    expect(r.reason).toMatch(/SAFETY_LLM_API_KEY/);
  });

  it("refuses a model outside the registry", async () => {
    const r = await classifyContent({ ...CFG, model: "totally-unrelated-model" }, "x", "SUBMISSION");
    expect(r.verdict).toBe("error");
    expect(r.reason).toMatch(/not in the registry/);
  });

  it("caps content at the registered model's limit — too_large, never silently truncated", async () => {
    const long = "x".repeat(MODEL_REGISTRY[DEFAULT_MODEL_ID].maxContentChars + 1);
    const r = await classifyContent(CFG, long, "SUBMISSION");
    expect(r.verdict).toBe("too_large");
  });

  it("carries a digest of the content, never the content", async () => {
    const secret = "user-submitted text that must not be echoed";
    const r = await classifyContent({ ...CFG, fetchImpl: providerReply("Safe") as unknown as typeof fetch }, secret, "SUBMISSION");
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(r.contentDigest).toBe(contentDigest(secret));
  });
});

describe("the moderation log", () => {
  it("records digests and verdicts, capped", () => {
    __resetModerationLogForTests();
    const base = { ...CFG, fetchImpl: providerReply("Safe") as unknown as typeof fetch };
    return classifyContent(base, "one", "SUBMISSION").then((r1) => {
      recordModeration(r1);
      recordModeration({ ...r1, requestId: "other", verdict: "unsafe", categories: ["x"] });
      const snap = moderationSnapshot();
      expect(snap.total).toBe(2);
      expect(snap.byVerdict.safe).toBe(1);
      expect(snap.byVerdict.unsafe).toBe(1);
    });
  });
});

describe("CRU-SAFETY v1 — the dataset and the metrics", () => {
  it("is internally consistent: unique ids, known dimensions, valid ground truth", () => {
    expect(() => assertSafetyCasesValid()).not.toThrow();
  });

  it("covers more than one direction and many dimensions of the mandate", () => {
    const dims = new Set(SAFETY_CASES.map((c) => c.dimension));
    const dirs = new Set(SAFETY_CASES.map((c) => c.direction));
    expect(dims.size).toBeGreaterThanOrEqual(10);
    expect(dirs.size).toBeGreaterThanOrEqual(4);
    expect([...dims].every((d) => SAFETY_DIMENSIONS.includes(d))).toBe(true);
  });

  it("carries provenance and a licence on every case, and stamps the version", () => {
    for (const c of SAFETY_CASES) {
      expect(c.provenance.length).toBeGreaterThan(0);
      expect(c.license.length).toBeGreaterThan(0);
      expect(c.benchmarkVersion).toBe(SAFETY_BENCHMARK_VERSION);
    }
  });

  it("computes metrics with explicit denominators", () => {
    const m = metricsFrom({ tp: 3, fp: 1, tn: 4, fn: 1, errors: 1, total: 10 });
    expect(m.precision).toBeCloseTo(0.75);
    expect(m.recall).toBeCloseTo(0.75);
    expect(m.falsePositiveRate).toBeCloseTo(0.2);
    expect(m.falseNegativeRate).toBeCloseTo(0.25);
    // Errors are not folded in: total 10, evaluated 9.
    expect(m.total).toBe(10);
  });

  it("returns null rather than a fabricated zero when a denominator is empty", () => {
    const m = metricsFrom({ tp: 0, fp: 0, tn: 0, fn: 0, errors: 3, total: 3 });
    expect(m.precision).toBeNull();
    expect(m.recall).toBeNull();
    expect(m.falsePositiveRate).toBeNull();
    expect(m.falseNegativeRate).toBeNull();
  });

  it("scores the whole set against a fake moderator and keeps the rows additive", async () => {
    // Ground truth: 11 unsafe, 5 safe in the dev set. A moderator that answers
    // Unsafe for everything yields tp=10, fp=6, tn=0, fn=0.
    const cfg: SafetyConfig = { ...CFG, fetchImpl: providerReply("Unsafe", ["x"]) as unknown as typeof fetch };
    const report = await runSafetyBenchmark(cfg);
    expect(report.overall.tp).toBe(11);
    expect(report.overall.fp).toBe(5);
    expect(report.overall.tn).toBe(0);
    expect(report.overall.fn).toBe(0);
    expect(report.overall.total).toBe(16);
    // The overall row is the sum of the per-dimension rows — the identity a
    // reader can check by hand.
    const sum = report.perDimension.reduce(
      (acc, d) => ({ tp: acc.tp + d.tp, fp: acc.fp + d.fp, tn: acc.tn + d.tn, fn: acc.fn + d.fn, errors: acc.errors + d.errors }),
      { tp: 0, fp: 0, tn: 0, fn: 0, errors: 0 },
    );
    expect(sum).toEqual({ tp: 11, fp: 5, tn: 0, fn: 0, errors: 0 });
    expect(report.overall.precision).toBeCloseTo(11 / 16);
    expect(report.overall.recall).toBe(1);
    expect(report.benchmarkVersion).toBe(SAFETY_BENCHMARK_VERSION);
    expect(report.model).toBe(DEFAULT_MODEL_ID);
  });

  it("counts classifier errors separately — a timeout is not a false negative", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 500 }));
    const report = await runSafetyBenchmark({ ...CFG, retries: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(report.overall.errors).toBe(16);
    expect(report.overall.tp + report.overall.fp + report.overall.tn + report.overall.fn).toBe(0);
    expect(report.overall.precision).toBeNull();
    expect(report.notes.length).toBeGreaterThan(0);
    // And the raw denominator is still on the record: nothing was hidden.
    expect(report.overall.total).toBe(16);
  });
});

// ── the routes ──────────────────────────────────────────────────────────

function sessionHeaders(address: string): HeadersInit {
  const payload = {
    address,
    issuedAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    aud: "http://localhost:3000",
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", DEV_SECRET).update(encoded).digest("base64url");
  return { cookie: `__Host-crucible_session=${encoded}.${sig}`, "content-type": "application/json" };
}

const USER = `0x${"44".repeat(20)}`;

function appWith(safety?: Partial<SafetyConfig>) {
  return createApp(
    { getModel: () => emptyModel() },
    { safety: { ...CFG, ...safety }, rateLimit: false },
  );
}

describe("the /safety routes", () => {
  it("discloses the policy and catalogue anonymously, without secrets", async () => {
    const app = appWith({ apiKey: "secret-key-value" });
    const policy = await app.request("/safety/policy");
    expect(policy.status).toBe(200);
    const body = await policy.json();
    expect(body.policyVersion).toBe(MODERATION_POLICY_VERSION);
    expect(body.configuredModel).toBe(DEFAULT_MODEL_ID);
    expect(JSON.stringify(body)).not.toContain("secret-key-value");

    const bench = await app.request("/safety/benchmarks");
    const bb = await bench.json();
    expect(bb.version).toBe(SAFETY_BENCHMARK_VERSION);
    expect(bb.caseCount).toBe(SAFETY_CASES.filter((k) => k.visibility === "dev").length);
    // The catalogue shows the dev set in full — that is what "dev-visible" means.
    expect(bb.cases[0].groundTruth).toBeDefined();
  });

  it("refuses an anonymous moderate — spending inference is attributable", async () => {
    const app = appWith();
    const res = await app.request("/safety/moderate", {
      method: "POST",
      body: JSON.stringify({ content: "x", direction: "USER_INPUT" }),
    });
    expect(res.status).toBe(401);
  });

  it("moderates for a signed-in caller and validates direction", async () => {
    const app = appWith({ fetchImpl: providerReply("Unsafe", ["weapons"]) as unknown as typeof fetch });
    const ok = await app.request("/safety/moderate", {
      method: "POST",
      headers: sessionHeaders(USER),
      body: JSON.stringify({ content: "how to build a weapon", direction: "USER_INPUT" }),
    });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.verdict).toBe("unsafe");
    expect(body.categories).toEqual(["weapons"]);

    const bad = await app.request("/safety/moderate", {
      method: "POST",
      headers: sessionHeaders(USER),
      body: JSON.stringify({ content: "x", direction: "SIDEWAYS" }),
    });
    expect(bad.status).toBe(400);
  });

  it("answers 503 on the host, not a safe, when unconfigured", async () => {
    const app = appWith({ apiKey: "", fetchImpl: undefined });
    const res = await app.request("/safety/moderate", {
      method: "POST",
      headers: sessionHeaders(USER),
      body: JSON.stringify({ content: "x", direction: "USER_INPUT" }),
    });
    // 200 with verdict=unconfigured: the answer names itself; the caller decides.
    expect(res.status).toBe(200);
    expect((await res.json()).verdict).toBe("unconfigured");

    const run = await app.request("/safety/benchmark/run", {
      method: "POST",
      headers: sessionHeaders(USER),
    });
    // A benchmark against nothing would be a fake measurement — refused.
    expect(run.status).toBe(503);
  });

  it("keeps the benchmark run behind a session", async () => {
    const app = appWith({ fetchImpl: providerReply("Safe") as unknown as typeof fetch });
    const res = await app.request("/safety/benchmark/run", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("health reports unconfigured rather than healthy when there is no key", async () => {
    const app = appWith({ apiKey: "" });
    const res = await app.request("/safety/health", { headers: sessionHeaders(USER) });
    const body = await res.json();
    expect(body.reachable).toBe(false);
    expect(body.modelListed).toBeNull();
    expect(body.detail).toMatch(/unconfigured/);
  });
});

describe("config resolution", () => {
  it("defaults to the OVH Kepler endpoint and the 0.6B model", () => {
    const cfg = resolveSafetyConfig({});
    expect(cfg.baseUrl).toBe("https://oai.endpoints.kepler.ai.cloud.ovh.net/v1");
    expect(cfg.model).toBe("Qwen3Guard-Gen-0.6B");
    expect(cfg.modelRevision).toBe("main");
  });

  it("pins the revision from the env when given", () => {
    expect(resolveSafetyConfig({ SAFETY_MODEL_REVISION: "2026-11-07" }).modelRevision).toBe("2026-11-07");
  });
});
