import { Hono } from "hono";
import { dlq } from "./dlq.js";

/**
 * Frenchy — the optional voice host.
 *
 * The browser never sees the ElevenLabs key. It asks this process for one of a small,
 * fixed set of moments; the copy lives here, not in the request, so an open endpoint
 * cannot be used to synthesize arbitrary text on our account. The only caller-supplied
 * text is `spec`, and it is capped and normalised because a future spec viewer may
 * genuinely need to read a task aloud.
 *
 * The voice is decoration, never a source of truth: amounts, deadlines, CIDs and
 * verdicts stay on screen. If this route is absent, misconfigured or the provider is
 * down, the product behaves exactly as it did without it.
 */

export type VoiceMoment = "greeting" | "tour" | "verdict" | "verdict-repeat" | "spec";

const MOMENTS: ReadonlySet<string> = new Set([
  "greeting",
  "tour",
  "verdict",
  "verdict-repeat",
  "spec",
] satisfies VoiceMoment[]);

/**
 * Fixed copy, deliberately short. Two sentences except the tour, which the PRD allows
 * to run longer. No amounts, deadlines, addresses or CIDs — those are the screen's job.
 */
const COPY: Record<Exclude<VoiceMoment, "spec">, string> = {
  greeting:
    "Welcome, apprentice. The forge is lit; this is where agents earn trust under fire.",
  tour: "Three families, one law. BUILD a solution against a pinned suite; BREAK a claim and get paid when it cracks; JUDGE with your stake on the line.",
  verdict: "The forge has paid you, mon ami. Payment is the verification.",
  "verdict-repeat": "The forge has paid you, mon ami. The metal held.",
};

export interface VoiceConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
  /** Overridable only from the environment, never from a request. */
  baseUrl?: string;
  maxTextChars?: number;
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

/** The text for a moment, or null when the request cannot be answered as asked. */
export function voiceCopy(
  moment: string,
  text: string | undefined,
  maxTextChars = 600,
): string | null {
  if (moment === "spec") {
    const cleaned = (text ?? "").replace(/\s+/g, " ").trim();
    return cleaned.length >= 1 && cleaned.length <= maxTextChars ? cleaned : null;
  }
  if (!MOMENTS.has(moment) || moment === "spec") return null;
  return COPY[moment as Exclude<VoiceMoment, "spec">] ?? null;
}

const DEFAULT_BASE = "https://api.elevenlabs.io";
const DEFAULT_MODEL = "eleven_flash_v2_5";

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
    if (typeof moment !== "string" || !MOMENTS.has(moment)) {
      return c.json({ error: "unknown voice moment" }, 400);
    }

    const copy = voiceCopy(
      moment,
      typeof text === "string" ? text : undefined,
      config.maxTextChars ?? 600,
    );
    if (!copy) {
      return c.json(
        { error: `text must be 1-${config.maxTextChars ?? 600} characters for this moment` },
        400,
      );
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
