import { Hono } from "hono";
import { dlq } from "./dlq.js";

/**
 * Frenchy — the optional voice host.
 *
 * The browser never sees the ElevenLabs key, and it never supplies words. Every phrase
 * this route can synthesize is listed in `COPY` below; a request that carries text is
 * refused. That is a policy boundary, not tidiness: under the ElevenLabs Usage Policy the
 * account holder is responsible for Input and Output produced on their key, including
 * Input arriving through a product built with the service, and an unmoderated
 * text-to-speech endpoint on the public internet is exactly the impersonation,
 * harassment and platform-abuse surface that policy prohibits. A product cannot moderate
 * what it never accepts, so it accepts nothing.
 *
 * Two consequences are visible to users and deliberate: the host is labelled as an AI
 * voice wherever it is offered (§AI Transparency), and the voice is decoration, never a
 * source of truth — amounts, deadlines, CIDs and verdicts stay on the screen. If this
 * route is absent, misconfigured or the provider is down, the product behaves exactly as
 * it did without it.
 */

export type VoiceMoment = "greeting" | "tour" | "verdict" | "verdict-repeat";

const MOMENTS: ReadonlySet<string> = new Set([
  "greeting",
  "tour",
  "verdict",
  "verdict-repeat",
] satisfies VoiceMoment[]);

/** Fixed copy, deliberately short. Two sentences except the tour. */
const COPY: Record<VoiceMoment, string> = {
  greeting:
    "Welcome, apprentice. The forge is lit: trials, verticals, the escrow by address, and an agent surface, all in one hall.",
  tour: "Three families, one law: BUILD against a pinned suite, BREAK a claim, JUDGE with stake. The Verticals page runs the RWA and PayFi exams, the Escrow page shows where your ETH is, locked, free stake, or claimable, and agents can read the hall and prepare unsigned transactions over MCP. The escrow still settles in native ETH at five percent.",
  verdict: "The forge has paid you, mon ami. Payment is the verification.",
  "verdict-repeat": "Paid again, mon ami. The metal held, and the ledger remembers.",
};

export interface VoiceConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
  /** Overridable only from the environment, never from a request. */
  baseUrl?: string;
  /** Injected by tests; production uses the platform fetch. */
  fetchImpl?: typeof fetch;
  /** Injected by tests; production uses the real clock only for timeout aborts. */
  now?: () => number;
}

/** A secret is never returned; only whether the feature can answer. */
export function voiceStatus(config: VoiceConfig | null | undefined): {
  configured: boolean;
  model: string | null;
} {
  return config
    ? { configured: true, model: config.modelId }
    : { configured: false, model: null };
}

/** The words for a moment, or null when the moment is not one this host owns. */
export function voiceCopy(moment: string): string | null {
  if (!MOMENTS.has(moment)) return null;
  return COPY[moment as VoiceMoment] ?? null;
}

const DEFAULT_BASE = "https://api.elevenlabs.io";
const DEFAULT_MODEL = "eleven_multilingual_v4";

/**
 * The provider request. The voice settings are the PRD's: stability 0.55, style 0.35,
 * speed 0.95. `stream` is used so the browser can start playing before the full clip
 * has arrived; the route still returns one Response, so Hono's body cap applies.
 */
export function elevenLabsRequest(args: {
  config: VoiceConfig;
  text: string;
}): { url: string; init: RequestInit } {
  const base = (args.config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  return {
    url: `${base}/v1/text-to-speech/${encodeURIComponent(args.config.voiceId)}/stream`,
    init: {
      method: "POST",
      headers: {
        "xi-api-key": args.config.apiKey,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: args.text,
        model_id: args.config.modelId || DEFAULT_MODEL,
        voice_settings: { stability: 0.55, style: 0.35, speed: 0.95 },
      }),
    },
  };
}

export function createVoiceRoutes(config: VoiceConfig | null): Hono {
  const app = new Hono();

  app.get("/status", (c) => c.json(voiceStatus(config)));

  app.post("/speak", async (c) => {
    if (!config) {
      return c.json({ error: "the voice host is not configured" }, 503);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "expected a JSON body" }, 400);
    }
    if (!body || typeof body !== "object") {
      return c.json({ error: "expected a JSON object" }, 400);
    }

    const { moment, text } = body as { moment?: unknown; text?: unknown };
    if (text !== undefined && text !== null) {
      // Refused rather than ignored, so an integrator learns that this is not a
      // text-to-speech proxy instead of watching their words vanish.
      return c.json({ error: "the voice host speaks only its own lines; text is not accepted" }, 400);
    }
    if (typeof moment !== "string" || !MOMENTS.has(moment)) {
      return c.json({ error: "unknown voice moment" }, 400);
    }

    const copy = voiceCopy(moment);
    if (!copy) {
      return c.json({ error: "the voice host has no line for that moment" }, 400);
    }

    const request = elevenLabsRequest({ config, text: copy });
    let upstream: Response;
    try {
      upstream = await (config.fetchImpl ?? fetch)(request.url, {
        ...request.init,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      dlq.push("voice.upstream", err instanceof Error ? err.message : "the request failed");
      return c.json({ error: "the voice provider is unreachable" }, 502);
    }

    if (!upstream.ok || !upstream.body) {
      // The status is enough for the operator; the provider's body can contain a
      // request id or account detail that should not be reflected to a visitor.
      dlq.push("voice.upstream", `provider answered ${upstream.status}`);
      return c.json({ error: "the voice provider refused the request" }, 502);
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "audio/mpeg",
        "cache-control": "no-store",
        "x-voice-moment": moment,
      },
    });
  });

  return app;
}
