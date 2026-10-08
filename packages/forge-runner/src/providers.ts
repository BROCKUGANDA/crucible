/**
 * Providers.
 *
 * One `LlmClient` interface with a client per provider, so the agent does not know or
 * care which one it is talking to — and so a provider can be swapped without touching
 * the work loop.
 *
 * ── Why several providers, and which one to pick ─────────────────────────────────────
 * The loop is interactive: it asks for a patch, runs a suite, and feeds the failure
 * back. Prompt tuning therefore needs a model that answers fast enough to iterate, so
 * the default is whichever hosted model is reachable from the machine running it.
 * Anthropic is kept because it is the stronger model for hard work, but it needs a
 * paid key; NVIDIA NIM is kept because it hosts code models *and* a purpose-trained
 * safety classifier, which is the pair this repo actually needs.
 *
 * Groq and NIM are both OpenAI-compatible, so they share `openAiCompatibleClient`. It
 * deliberately does not pull in an SDK: the wire format is small, the failure modes are
 * worth being able to read, and a provider client should not be able to break the build.
 */

import type { LlmClient } from "./agent.js";
import { withBackoff } from "@crucible/smith";

const GROQ_BASE = "https://api.groq.com/openai/v1";
const NIM_BASE = "https://integrate.api.nvidia.com/v1";

export interface CompatibleOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** Model ids move; this is the fallback when no explicit model was requested. */
  defaultModel?: string;
  maxTokens?: number;
  /** Label used in error text so a failure names the provider that produced it. */
  name?: string;
  /** Set false to disable the retry-on-429 behaviour below. */
  retryOnRateLimit?: boolean;
}

/**
 * The default agent model.
 *
 * Note: Groq retired `llama-3.1-70b` in September 2026, so the obvious choice is no
 * longer available. `qwen3.8-27b` is a good fit — strong at code, and it actually
 * honours "return only a diff".
 */
export const DEFAULT_GROQ_MODEL = "qwen/qwen3.8-27b";

/**
 * NIM's default. `z-ai/glm-5.3-flash` is a code model that answers in seconds and
 * returns a bare unified diff without needing to be coaxed out of prose.
 */
export const DEFAULT_NIM_MODEL = "z-ai/glm-5.3-flash";

/**
 * The one OpenAI-compatible chat-completions client.
 *
 * Reasoning models (gpt-oss, nemotron) put their chain of thought in `reasoning_content`
 * and can return `content: null` when the token budget is consumed by thinking. That is
 * handled here rather than in the agent, because every caller of `complete()` wants
 * assistant *text* and none of them want to know which field carried it.
 */
export function openAiCompatibleClient(opts: CompatibleOptions): LlmClient {
  const base = opts.baseUrl ?? GROQ_BASE;
  const model = opts.model ?? opts.defaultModel ?? DEFAULT_GROQ_MODEL;
  const maxTokens = opts.maxTokens ?? 8000;
  const name = opts.name ?? "provider";

  return {
    async complete({ system, prompt, temperature }) {
      const body = {
        model,
        max_tokens: maxTokens,
        // Work this code gets tested, so sampling stays low.
        temperature: temperature ?? 0.2,
        messages: [
          ...(system ? [{ role: "system" as const, content: system }] : []),
          { role: "user" as const, content: prompt },
        ],
      };

      const call = () =>
        fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify(body),
        });

      const res =
        opts.retryOnRateLimit === false
          ? await call()
          : // Backing off on 429s rather than failing the whole iteration is what makes a
            // rate-limited run a slow run instead of a dead run.
            await withBackoff(call, {
              operation: `${name}.chat`,
              retries: 4,
              baseMs: 300,
            });

      if (!res.ok) {
        throw new Error(
          `${name} responded ${res.status}: ${(await res.text()).slice(0, 500)}`,
        );
      }

      const parsed = (await res.json()) as {
        choices?: { message?: { content?: string; reasoning_content?: string } }[];
      };
      const message = parsed.choices?.[0]?.message;
      // A reasoning model with a short budget answers in `reasoning_content` and leaves
      // `content` null. Falling back to the reasoning keeps the run alive; returning ""
      // would look like the model refused, which is a different and much worse bug.
      const text = message?.content ?? message?.reasoning_content ?? "";
      if (!text) throw new Error(`${name} returned no message content`);
      return text;
    },
  };
}

export function groqClient(opts: CompatibleOptions): LlmClient {
  return openAiCompatibleClient({
    ...opts,
    baseUrl: opts.baseUrl ?? GROQ_BASE,
    defaultModel: opts.defaultModel ?? DEFAULT_GROQ_MODEL,
    name: "groq",
  });
}

export function nimClient(opts: CompatibleOptions): LlmClient {
  return openAiCompatibleClient({
    ...opts,
    baseUrl: opts.baseUrl ?? NIM_BASE,
    defaultModel: opts.defaultModel ?? DEFAULT_NIM_MODEL,
    name: "nim",
  });
}

/**
 * A prompt-injection classifier, used by `@crucible/agent-security`.
 *
 * Two hosted classifiers are supported because they answer in different shapes:
 *
 *   - Groq's `meta-llama/llama-prompt-guard-2-22m` returns a bare float probability.
 *     On our own probes it separated cleanly (benign spec 0.0006, direct injection
 *     0.999, indirect 0.903).
 *   - NVIDIA NIM's `nvidia/nemotron-3.5-content-safety` returns a verdict line
 *     ("User Safety: safe" / "User Safety: unsafe"). Measured on this machine against
 *     the live agent fixture: benign spec → safe, the injection spec → unsafe.
 *
 * Either way this is not a general model doing its best — it is the right tool.
 *
 * Returns `null` rather than a fabricated score when the provider is unreachable. A
 * caller treating null as "clean" would be worse than not calling it at all, so the
 * contract is explicit: null means "no verdict", and policy decides what to do about
 * that.
 */
export interface PromptGuardOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /**
   * `float`  — the model answers with a probability (Groq Prompt Guard).
   * `verdict` — the model answers with a safety label (NIM content-safety).
   */
  shape?: "float" | "verdict";
}

export function promptGuard(args: PromptGuardOptions): {
  score(text: string): Promise<number | null>;
} {
  const shape = args.shape ?? "float";
  const base =
    args.baseUrl ?? (shape === "verdict" ? NIM_BASE : GROQ_BASE);
  const model =
    args.model ??
    (shape === "verdict"
      ? "nvidia/nemotron-3.5-content-safety"
      : "meta-llama/llama-prompt-guard-2-22m");

  return {
    async score(text: string): Promise<number | null> {
      if (!text.trim()) return null;

      try {
        const res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${args.apiKey}`,
          },
          body: JSON.stringify({
            model,
            max_tokens: shape === "verdict" ? 64 : 8,
            temperature: 0,
            messages: [{ role: "user", content: text.slice(0, 20_000) }],
          }),
        });

        if (!res.ok) return null;

        const parsed = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const raw = parsed.choices?.[0]?.message?.content ?? "";

        if (shape === "verdict") {
          // "User Safety: unsafe" — anything the model flags is treated as hostile, and
          // an unparseable answer is no verdict rather than a guessed one.
          if (!raw.trim()) return null;
          const lower = raw.toLowerCase();
          if (lower.includes("unsafe")) return 1;
          if (lower.includes("safe")) return 0;
          return null;
        }

        // The model answers with a bare float: "0.0006428543129004538" — not JSON.
        const n = Number.parseFloat(raw.trim());
        return Number.isFinite(n) ? n : null;
      } catch {
        return null;
      }
    },
  };
}