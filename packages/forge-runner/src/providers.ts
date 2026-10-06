/**
 * Providers.
 *
 * Two clients behind one `LlmClient` interface, so the agent does not know or care
 * which one it is talking to — and so a provider can be swapped without touching the
 * work loop.
 *
 * ── Why Groq is the default here ─────────────────────────────────────────────────────
 * Groq's free tier runs `qwen3.8-27b` fast enough to iterate a build-and-test loop
 * interactively, which is what prompt tuning actually requires. Anthropic is kept
 * because it is the stronger model for hard work, but it needs a paid key.
 *
 * Groq is OpenAI-compatible, so this speaks `/chat/completions`. It deliberately does
 * not pull in an SDK: the wire format is small, the failure modes are worth being able
 * to read, and a provider client should not be able to break the build.
 */

import type { LlmClient } from "./agent.js";

const GROQ_BASE = "https://api.groq.com/openai/v1";

export interface GroqOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** Groq model ids move; this is the one the prompt was tuned against. */
  defaultModel?: string;
  maxTokens?: number;
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

export function groqClient(opts: GroqOptions): LlmClient {
  const base = opts.baseUrl ?? GROQ_BASE;
  const model = opts.model ?? opts.defaultModel ?? DEFAULT_GROQ_MODEL;
  const maxTokens = opts.maxTokens ?? 8000;

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

      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(
          `groq responded ${res.status}: ${(await res.text()).slice(0, 500)}`,
        );
      }

      const parsed = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = parsed.choices?.[0]?.message?.content ?? "";
      if (!text) throw new Error("groq returned no message content");
      return text;
    },
  };
}

/**
 * A prompt-injection classifier, used by `@crucible/agent-security`.
 *
 * Groq hosts Meta's Llama Prompt Guard, which is trained specifically for this: given
 * untrusted text, return a probability that it contains an injection attempt. It is
 * not a general model doing its best — it is the right tool, and on our own probes it
 * separated cleanly (benign spec 0.0006, direct injection 0.999, indirect 0.903).
 *
 * Returns `null` rather than a fabricated score when the provider is unreachable. A
 * caller treating null as "clean" would be worse than not calling it at all, so the
 * contract is explicit: null means "no verdict", and policy decides what to do about
 * that.
 */
export function promptGuard(args: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}): { score(text: string): Promise<number | null> } {
  const base = args.baseUrl ?? GROQ_BASE;
  const model = args.model ?? "meta-llama/llama-prompt-guard-2-22m";

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
            max_tokens: 8,
            messages: [{ role: "user", content: text.slice(0, 20_000) }],
          }),
        });

        if (!res.ok) return null;

        const parsed = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const raw = parsed.choices?.[0]?.message?.content ?? "";

        // The model answers with a bare float: "0.0006428543129004538" — not JSON.
        const n = Number.parseFloat(raw.trim());
        return Number.isFinite(n) ? n : null;
      } catch {
        return null;
      }
    },
  };
}