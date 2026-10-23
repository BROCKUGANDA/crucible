import type { ModelAdapter } from "./eval/types.js";
import { AnthropicAdapter } from "./eval/adapters/anthropic.js";
import { GoogleAdapter } from "./eval/adapters/google.js";
import { OpenAICompatAdapter } from "./eval/adapters/openai-compat.js";
import { StubModelAdapter } from "./eval/adapters/stub.js";

/**
 * adapter.ts — the single wire behind which every frontier model is swappable.
 *
 * Adding a candidate costs one config row + RFC, zero code: buildFromConfig
 * constructs an adapter from a JSON row. The stub adapter runs the CI smoke
 * tier with zero network; frontier models appear only in full/adversarial/shadow.
 *
 * Exactly 4 adapter files live here (openai-compat, anthropic, google, stub).
 * A 5th requires an RFC naming the missing wire dialect (gate 439).
 */

export { StubModelAdapter } from "./eval/adapters/stub.js";
export { OpenAICompatAdapter } from "./eval/adapters/openai-compat.js";
export { AnthropicAdapter } from "./eval/adapters/anthropic.js";
export { GoogleAdapter } from "./eval/adapters/google.js";

export type AdapterKind = "stub" | "openai-compat" | "anthropic" | "google";

export interface AdapterConfig {
  kind: AdapterKind;
  modelId: string;
  promptVersion: string;
  /** OpenAI-compat: base URL. Anthropic/Google: ignored. */
  baseUrl?: string;
  /** API key (stub: ignored). */
  apiKey?: string;
  /** Model name (openai-compat/anthropic/google). */
  model?: string;
}

/** Build an adapter from a config row. No code change per model. */
export function buildAdapter(config: AdapterConfig): ModelAdapter {
  switch (config.kind) {
    case "stub":
      return new StubModelAdapter(config.promptVersion);
    case "openai-compat":
      if (!config.baseUrl || !config.apiKey || !config.model) {
        throw new Error("openai-compat adapter requires baseUrl, apiKey, model");
      }
      return new OpenAICompatAdapter(config.baseUrl, config.apiKey, config.model, config.promptVersion, config.modelId);
    case "anthropic":
      if (!config.apiKey || !config.model) {
        throw new Error("anthropic adapter requires apiKey, model");
      }
      return new AnthropicAdapter(config.apiKey, config.model, config.promptVersion, config.modelId);
    case "google":
      if (!config.apiKey || !config.model) {
        throw new Error("google adapter requires apiKey, model");
      }
      return new GoogleAdapter(config.apiKey, config.model, config.promptVersion, config.modelId);
    default:
      throw new Error(`unknown adapter kind: ${(config as { kind: string }).kind}`);
  }
}

/** The four permitted adapter files — a 5th requires an RFC. */
export const ADAPTER_CAP = ["stub.ts", "openai-compat.ts", "anthropic.ts", "google.ts"] as const;
