import type { ModelAdapter } from "./eval/types.js";
import {
  ModelCardError,
  SpendLedger,
  withFrontierGuard,
  type ModelCard,
} from "./eval/frontier.js";
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
  /**
   * Required for every paid kind. The card is the config row gate 503 asks for: an exact provider
   * snapshot, a retention posture that is not "unknown", and a budget. A paid adapter built from a
   * row without one would be an unattributed, uncosted, unscrubbed call to a third party — which
   * is what this factory used to build.
   */
  card?: ModelCard;
  /** Where the spend is accounted. Required alongside `card` for paid kinds. */
  spend?: SpendLedger;
  /** Tournament stage the calls are billed against (`smoke` | `full` | `adversarial` | `shadow`). */
  scope?: string;
}

/** Build an adapter from a config row. No code change per model. */
export function buildAdapter(config: AdapterConfig): ModelAdapter {
  const inner = buildDialect(config);
  if (config.kind === "stub") return inner; // gate 441: the CI tier is stub-only — no cost, no egress

  if (!config.card || !config.spend) {
    throw new ModelCardError(
      `${config.kind} adapter "${config.modelId}" needs a card and a spend ledger: a paid call ` +
        "with no snapshot pin, no retention posture and no cap is exactly the frontier access this " +
        "layer exists to refuse.",
    );
  }
  // The card names the wire, so it has to be the wire being built. Nothing else reads `dialect`,
  // and a card loaded from JSON can carry any string: without this, a card written for one provider
  // guards a call to another and every verdict it stamps is attributed to a model that was never
  // called. The snapshot pin and the retention posture attached to it go with the wrong provider
  // too, which is the part that is not recoverable from the scorecard afterwards.
  if (config.card.dialect !== config.kind) {
    throw new ModelCardError(
      `${config.kind} adapter "${config.modelId}" was handed a card for the ` +
        `"${config.card.dialect}" dialect. A card describes the model it guards; one that describes ` +
        "a different wire is not a typo to be corrected downstream.",
    );
  }
  if (!config.scope || config.scope.trim().length === 0) {
    throw new ModelCardError(
      `${config.kind} adapter "${config.modelId}" needs a scope — an unlabelled stage cannot be ` +
        "capped, because there is no stage total to compare against.",
    );
  }
  return withFrontierGuard(inner, config.card, config.spend, { scope: config.scope });
}

/** The dialect switch, kept separate so the guard above is the only exit for paid kinds. */
function buildDialect(config: AdapterConfig): ModelAdapter {
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
