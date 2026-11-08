/**
 * @file safety.ts — Runtime content moderation, backed by Qwen3Guard-Gen.
 *
 * The first slice of the safety programme: a provider abstraction so the
 * screening model can be swapped without touching the evaluation system, and
 * a moderation service whose one unbreakable law is FAIL CLOSED.
 *
 * The law, spelled out: a malformed answer, a timeout, a provider outage, an
 * oversized submission and an unconfigured host all produce a verdict that is
 * NOT "safe". The only route to "safe" is the model saying so, through a
 * response that parses. A moderation layer that defaults to safe on failure is
 * not a safety layer — it is a rubber stamp with a GPU bill.
 *
 * Content itself is untrusted data and never persisted: results carry a
 * SHA-256 digest of what was classified, never the text. No chain keys are
 * held; this module talks to one inference endpoint and nothing else.
 */

import { createHash, randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { verifiedSessionFromContext } from "./auth.js";
import {
  SAFETY_BENCHMARK_VERSION,
  SAFETY_CASES,
  SAFETY_DIMENSIONS,
  runSafetyBenchmark,
} from "./safety-benchmark.js";

/** The moderation policy this build ships. A policy change is a new version. */
export const MODERATION_POLICY_VERSION = "2026-11-07.1";

/** The benchmark family these cases belong to (see safety-benchmark.ts). */
export const SAFETY_BENCHMARK_FAMILY = "CRU-SAFETY";

/**
 * Content directions. The policy applied to a submission differs from the
 * policy applied to a publication: the same sentence is research context in
 * one and public copy in the other. Every moderation request names its
 * direction, and per-direction context is in the prompt.
 */
export const CONTENT_DIRECTIONS = [
  "USER_INPUT",
  "MODEL_OUTPUT",
  "AGENT_OUTPUT",
  "TOOL_OUTPUT",
  "SUBMISSION",
  "PUBLICATION",
] as const;

export type ContentDirection = (typeof CONTENT_DIRECTIONS)[number];

/**
 * The model registry. A model enters here with its constraints, or it does
 * not run. Revisions are pinned per request and recorded on every result —
 * "the model" is not an identity without the revision that answered.
 */
export interface RegisteredModel {
  id: string;
  provider: "ovh-kepler";
  kind: "gen";
  /** conservative content cap for the smallest variant; the adapter enforces it */
  maxContentChars: number;
  note: string;
}

export const MODEL_REGISTRY: Record<string, RegisteredModel> = {
  "Qwen3Guard-Gen-0.6B": {
    id: "Qwen3Guard-Gen-0.6B",
    provider: "ovh-kepler",
    kind: "gen",
    maxContentChars: 6_000,
    note: "default screening model; smallest and fastest of the Gen family",
  },
  "Qwen3Guard-Gen-4B": {
    id: "Qwen3Guard-Gen-4B",
    provider: "ovh-kepler",
    kind: "gen",
    maxContentChars: 12_000,
    note: "higher-capacity screening; same wire contract",
  },
  "Qwen3Guard-Gen-8B": {
    id: "Qwen3Guard-Gen-8B",
    provider: "ovh-kepler",
    kind: "gen",
    maxContentChars: 16_000,
    note: "largest Gen variant; reserved for adjudication and benchmark runs",
  },
};

export const DEFAULT_MODEL_ID = "Qwen3Guard-Gen-0.6B";
export const DEFAULT_BASE_URL = "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1";

export interface SafetyConfig {
  baseUrl: string;
  model: string;
  /** the pinned revision, recorded on every result this config produced */
  modelRevision: string;
  apiKey: string;
  timeoutMs: number;
  retries: number;
  fetchImpl?: typeof fetch;
}

/** Resolve the config from the environment. Absent key = unconfigured = fail closed. */
export function resolveSafetyConfig(env: NodeJS.ProcessEnv = process.env): SafetyConfig {
  return {
    baseUrl: (env.SAFETY_LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: env.SAFETY_LLM_MODEL ?? DEFAULT_MODEL_ID,
    modelRevision: env.SAFETY_MODEL_REVISION ?? "main",
    apiKey: (env.SAFETY_LLM_API_KEY ?? "").trim(),
    timeoutMs: Number(env.SAFETY_LLM_TIMEOUT_MS ?? 15_000),
    retries: Number(env.SAFETY_LLM_RETRIES ?? 2),
  };
}

export function isSafetyConfigured(cfg: SafetyConfig): boolean {
  return cfg.apiKey.length > 0 && MODEL_REGISTRY[cfg.model] !== undefined;
}

// ── the classification contract ─────────────────────────────────────────

export type SafetyVerdict = "safe" | "unsafe" | "error" | "unconfigured" | "too_large";

export interface ModerationResult {
  requestId: string;
  policyVersion: string;
  model: string;
  modelRevision: string;
  direction: ContentDirection;
  verdict: SafetyVerdict;
  /** harm categories when the verdict is unsafe; always sorted, never free text */
  categories: string[];
  /** sha-256 of the classified content — the evidence link, never the text */
  contentDigest: string;
  latencyMs: number;
  /** why the verdict is error/unconfigured/too_large — never a raw provider dump */
  reason?: string;
  finishedAt: number;
}

export function contentDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * The prompt the adapter sends. It follows Qwen3Guard-Gen's reported usage: the
 * content is handed over inside a tagged block and the model answers with a
 * `Safety:` line and, when unsafe, a category line. The parser accepts both
 * spellings the family has used for that line (`Content Types:` / `Categories:`)
 * and treats anything else as malformed — which is verdict `error`, never safe.
 */
export function moderationPrompt(content: string, direction: ContentDirection): string {
  return [
    "You are a content safety moderation model. Classify the content inside the block.",
    `Direction: the content arrived as ${direction}. Consider the purpose that direction implies.`,
    "Security-research terminology, defensive security discussion and evaluation/benchmark",
    "material are context, not automatically violations — judge the intent the content conveys.",
    "Answer in EXACTLY this format and nothing else:",
    "Safety: Safe",
    "or",
    "Safety: Unsafe",
    "Content Types: <comma-separated harm categories>",
    "",
    "<Content>",
    content,
    "</Content>",
  ].join("\n");
}

/**
 * Parse a Qwen3Guard-Gen classification. Returns null on anything that is not
 * an unambiguous Safe/Unsafe line — and null means the caller answers
 * `error`. A parser that guesses on ambiguity would be the fail-open hole
 * wearing a parser's clothes.
 */
export function parseClassification(
  output: string,
): { verdict: "safe" | "unsafe"; categories: string[] } | null {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const safetyLine = lines.find((l) => /^safety\s*:/i.test(l));
  if (!safetyLine) return null;
  const label = safetyLine.split(":").slice(1).join(":").trim().toLowerCase();
  if (label === "safe") {
    // A "Safe" answer must not smuggle categories in — that contradiction is
    // malformed, not safe.
    const categories = categoriesFrom(lines);
    if (categories.length > 0) return null;
    return { verdict: "safe", categories: [] };
  }
  if (label === "unsafe") {
    const categories = categoriesFrom(lines);
    return { verdict: "unsafe", categories };
  }
  return null;
}

function categoriesFrom(lines: string[]): string[] {
  const line = lines.find((l) => /^(content types|categories)\s*:/i.test(l));
  if (!line) return [];
  return line
    .split(":")
    .slice(1)
    .join(":")
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .sort();
}

/**
 * Ask the provider. Bounded retries with exponential backoff and full jitter
 * on 429/5xx/network — an idempotent read, so a retry is safe. A timeout is
 * an error verdict, never a retry forever and never a safe.
 */
async function askModel(
  cfg: SafetyConfig,
  content: string,
  direction: ContentDirection,
): Promise<{ ok: true; output: string; latencyMs: number } | { ok: false; reason: string; latencyMs: number }> {
  if (!MODEL_REGISTRY[cfg.model]) {
    return { ok: false, reason: `model "${cfg.model}" is not in the registry`, latencyMs: 0 };
  }
  const url = `${cfg.baseUrl}/chat/completions`;
  const started = Date.now();
  let lastReason = "provider failed";

  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    if (attempt > 0) {
      // Full jitter: sleep a random slice of an exponentially growing budget.
      const backoff = Math.min(2 ** attempt * 250, 4_000);
      await new Promise((r) => setTimeout(r, Math.random() * backoff));
    }
    const t0 = Date.now();
    try {
      const res = await (cfg.fetchImpl ?? fetch)(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: "user", content: moderationPrompt(content, direction) }],
          temperature: 0,
          max_tokens: 120,
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        lastReason = `provider answered ${res.status}`;
        continue;
      }
      if (!res.ok) {
        return {
          ok: false,
          reason: `provider answered ${res.status}`,
          latencyMs: Date.now() - t0,
        };
      }
      const data = (await res.json().catch(() => null)) as {
        choices?: { message?: { content?: string } }[];
      } | null;
      const output = data?.choices?.[0]?.message?.content?.trim() ?? "";
      if (!output) {
        return { ok: false, reason: "provider returned no classification", latencyMs: Date.now() - t0 };
      }
      return { ok: true, output, latencyMs: Date.now() - t0 };
    } catch (err) {
      lastReason = err instanceof Error && err.name === "TimeoutError" ? "inference timed out" : `provider unreachable: ${(err as Error).message}`;
    }
  }
  return { ok: false, reason: lastReason, latencyMs: Date.now() - started };
}

/**
 * Classify one piece of content. THE entry point for runtime moderation.
 *
 * Fail-closed at every branch: unconfigured host, unknown model, oversized
 * content, provider failure and unparseable output all yield a verdict that
 * callers must treat as "not screened". A caller that cannot proceed without
 * a safety answer must refuse to proceed — see the routes, which answer 503
 * rather than reporting a safe that nobody verified.
 */
export async function classifyContent(
  cfg: SafetyConfig,
  content: string,
  direction: ContentDirection,
): Promise<ModerationResult> {
    const started = Date.now();
  const base = {
    requestId: randomUUID(),
    policyVersion: MODERATION_POLICY_VERSION,
    model: cfg.model,
    modelRevision: cfg.modelRevision,
    direction,
    contentDigest: contentDigest(content),
    finishedAt: Date.now(),
  };

  const registered = MODEL_REGISTRY[cfg.model];
  if (!registered) {
    return {
      ...base,
      verdict: "error",
      categories: [],
      latencyMs: Date.now() - started,
      reason: `model "${cfg.model}" is not in the registry`,
    };
  }
  if (!cfg.apiKey) {
    return {
      ...base,
      verdict: "unconfigured",
      categories: [],
      latencyMs: Date.now() - started,
      reason: "no screening key configured on this host (SAFETY_LLM_API_KEY)",
    };
  }
  if (content.length > registered.maxContentChars) {
    return {
      ...base,
      verdict: "too_large",
      categories: [],
      latencyMs: Date.now() - started,
      reason: `content exceeds ${registered.maxContentChars} characters for ${cfg.model}`,
    };
  }

  const answer = await askModel(cfg, content, direction);
  if (!answer.ok) {
    return {
      ...base,
      verdict: "error",
      categories: [],
      latencyMs: answer.latencyMs,
      reason: answer.reason,
    };
  }
  const parsed = parseClassification(answer.output);
  if (!parsed) {
    return {
      ...base,
      verdict: "error",
      categories: [],
      latencyMs: answer.latencyMs,
      reason: "classification did not parse",
    };
  }
  return {
    ...base,
    verdict: parsed.verdict,
    categories: parsed.categories,
    latencyMs: answer.latencyMs,
    finishedAt: Date.now(),
  };
}

// ── the in-process moderation record ────────────────────────────────────

/**
 * The moderation log: digests and verdicts, never content, capped so a long
 * host lifetime cannot grow it without bound. It exists so the metrics
 * endpoint can report what this host actually screened (classification
 * distribution, error rate) instead of asserting a health it has not observed.
 * ADR-0008: in-memory until PostgreSQL lands; the cap is the honest version
 * of that limitation, not a hidden one.
 */
const LOG_CAP = 500;
const moderationLog: ModerationResult[] = [];

export function recordModeration(result: ModerationResult): void {
  moderationLog.push(result);
  if (moderationLog.length > LOG_CAP) moderationLog.splice(0, moderationLog.length - LOG_CAP);
}

export function moderationSnapshot(): {
  total: number;
  byVerdict: Record<string, number>;
  byDirection: Record<string, number>;
  recent: ModerationResult[];
} {
  const byVerdict: Record<string, number> = {};
  const byDirection: Record<string, number> = {};
  for (const r of moderationLog) {
    byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
    byDirection[r.direction] = (byDirection[r.direction] ?? 0) + 1;
  }
  return {
    total: moderationLog.length,
    byVerdict,
    byDirection,
    recent: moderationLog.slice(-20),
  };
}

export function __resetModerationLogForTests(): void {
  moderationLog.length = 0;
}

// ── provider health ─────────────────────────────────────────────────────

/**
 * Ask the endpoint whether it is alive and knows the configured model. A
 * health check that cannot run (no key) reports unconfigured — it never
 * reports healthy, because "did not ask" is not "fine".
 */
export async function providerHealth(
  cfg: SafetyConfig,
): Promise<{ reachable: boolean; model: string; modelListed: boolean | null; detail: string }> {
  if (!cfg.apiKey) {
    return {
      reachable: false,
      model: cfg.model,
      modelListed: null,
      detail: "unconfigured: no SAFETY_LLM_API_KEY",
    };
  }
  try {
    const res = await (cfg.fetchImpl ?? fetch)(`${cfg.baseUrl}/models`, {
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return {
        reachable: false,
        model: cfg.model,
        modelListed: null,
        detail: `endpoint answered ${res.status}`,
      };
    }
    const body = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
    const ids = (body?.data ?? []).map((m) => m?.id ?? "");
    return {
      reachable: true,
      model: cfg.model,
      modelListed: ids.includes(cfg.model),
      detail: ids.includes(cfg.model) ? "model listed by the endpoint" : "endpoint reachable, model not in its list",
    };
  } catch (err) {
    return {
      reachable: false,
      model: cfg.model,
      modelListed: null,
      detail: `endpoint unreachable: ${(err as Error).message}`,
    };
  }
}

// ── the routes ──────────────────────────────────────────────────────────

/** The largest content a moderation request may carry, before the model's own cap. */
const MODERATE_BODY_MAX = 60_000;

/**
 * The safety surface, mounted at `/safety`.
 *
 * Auth posture, from the access matrix: the policy and the public benchmark
 * catalogue are readable anonymously (they are disclosures, not data); every
 * call that spends an inference credit or reports host state requires a
 * server-verified session. The session does not confer moderation authority —
 * it makes the request attributable.
 */
export function createSafetyRoutes(deps: { config: SafetyConfig }): Hono {
  const app = new Hono();

  /** Public: what this build's moderation policy is, and which models may serve it. */
  app.get("/policy", (c) => {
    return c.json({
      policyVersion: MODERATION_POLICY_VERSION,
      benchmarkFamily: SAFETY_BENCHMARK_FAMILY,
      benchmarkVersion: SAFETY_BENCHMARK_VERSION,
      directions: CONTENT_DIRECTIONS,
      registry: Object.values(MODEL_REGISTRY).map((m) => ({
        id: m.id,
        provider: m.provider,
        maxContentChars: m.maxContentChars,
        note: m.note,
      })),
      // The configured model is disclosed; the key is not.
      configuredModel: deps.config.model,
      modelRevision: deps.config.modelRevision,
    });
  });

  /** Public catalogue: dev-visible cases in full, dimensions, versions. */
  app.get("/benchmarks", (c) => {
    const devCases = SAFETY_CASES.filter((k) => k.visibility === "dev");
    return c.json({
      family: SAFETY_BENCHMARK_FAMILY,
      version: SAFETY_BENCHMARK_VERSION,
      dimensions: SAFETY_DIMENSIONS,
      methodology:
        "The classifier runs every case and is scored against human ground truth. " +
        "Only unambiguous Safe/Unsafe verdicts enter precision/recall; errors are " +
        "reported separately with the full denominator preserved.",
      caseCount: devCases.length,
      cases: devCases,
      hiddenSets: "protected evaluation sets are not published; see the methodology note",
    });
  });

  /** Session-gated: provider health, as this host observes it right now. */
  app.get("/health", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) {
      return c.json({ error: "sign in to use the safety surface" }, 401);
    }
    return c.json(await providerHealth(deps.config));
  });

  /** Session-gated: classify one piece of content. */
  app.post("/moderate", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) {
      return c.json({ error: "sign in to use the safety surface" }, 401);
    }

    const body = (await c.req.json().catch(() => null)) as
      | { content?: unknown; direction?: unknown }
      | null;
    if (!body || typeof body.content !== "string" || body.content.length === 0) {
      return c.json({ error: "content (non-empty string) is required" }, 400);
    }
    if (body.content.length > MODERATE_BODY_MAX) {
      return c.json({ error: `content exceeds ${MODERATE_BODY_MAX} characters` }, 413);
    }
    const direction = CONTENT_DIRECTIONS.includes(body.direction as ContentDirection)
      ? (body.direction as ContentDirection)
      : null;
    if (!direction) {
      return c.json({ error: `direction must be one of ${CONTENT_DIRECTIONS.join(", ")}` }, 400);
    }

    const result = await classifyContent(deps.config, body.content, direction);
    recordModeration(result);
    // 200 with the verdict — including error/unconfigured/too_large, which are
    // honest answers about screening state, not transport failures. A caller
    // that cannot proceed unscreened must refuse to proceed; the contract is
    // "the verdict names itself", never "safe by default".
    return c.json(result, 200);
  });

  /** Session-gated: what this host has screened, aggregate and digest-only. */
  app.get("/moderation/stats", (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) {
      return c.json({ error: "sign in to use the safety surface" }, 401);
    }
    return c.json(moderationSnapshot());
  });

  /** Session-gated: run CRU-SAFETY against this host's configured model. */
  app.post("/benchmark/run", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) {
      return c.json({ error: "sign in to use the safety surface" }, 401);
    }
    if (!isSafetyConfigured(deps.config)) {
      return c.json(
        { error: "no screening key configured on this host (SAFETY_LLM_API_KEY)" },
        503,
      );
    }
    const report = await runSafetyBenchmark(deps.config);
    return c.json(report, 200);
  });

  return app;
}
