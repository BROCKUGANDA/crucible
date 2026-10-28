import { Hono } from "hono";
import { dlq } from "./dlq.js";
import type { ReadModel } from "@crucible/indexer";

export type FrenchyMode = "text" | "voice";

export interface FrenchyConfig {
  /** LLM provider configuration. */
  llm: {
    apiKey: string;
    model: string;
    baseUrl?: string;
    /** Injected by tests; production uses the platform fetch. */
    fetchImpl?: typeof fetch;
  };
  /** Optional premium TTS (ElevenLabs). If absent, the voice route is disabled. */
  tts?: {
    apiKey: string;
    voiceId: string;
    modelId?: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
  };
  /** Optional ElevenLabs Scribe Realtime STT. If absent, /frenchy/scribe-url is disabled. */
  scribe?: {
    apiKey: string;
    modelId?: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
  };
}

/**
 * The system prompt for Frenchy — butler register, concise, optional light French flourish,
 * always answers in <= 3 spoken sentences unless asked to expand.
 */
const SYSTEM_PROMPT = `You are Frenchy, the butler of the Crucible Forge. You speak in a refined butler register — concise, courteous, with an optional light French flourish. 

CRITICAL RULES:
1. You NEVER sign transactions. You may draft intents ("post a trial with 1 ETH reward") and render a confirmation card, but the wallet confirmation click is ALWAYS human. Voice → intent → confirm → action, no shortcuts.
2. You answer in 3 spoken sentences MAXIMUM unless explicitly asked to expand. Spoken UI dies with paragraphs.
3. You are grounded in live CRUCIBLE state — open trials, latest verdicts, escrowed totals, drift/epoch status, wallet connection. Answer from this context, not hallucination.
4. You are a garnish on the show, never the show. The Warden owns the stage.

Current CRUCIBLE context will be injected with each request. Use it.

5. When the visitor asks about a surface below, answer from that list instead of repeating a greeting or one canned sentence. If a surface is absent from the context, say you do not have it rather than inventing it.`;

/**
 * Build the context string from the live read model.
 */
function buildContext(model: ReadModel): string {
  const now = Date.now();
  const trials = [...model.trials.values()];
  const agents = [...model.agents.values()];

  // Open trials
  const openTrials = trials.filter((t) => t.status !== "settled");
  const openTrialsSummary = openTrials
    .slice(0, 10)
    .map((t) => `#${t.id}: ${t.status}, reward ${formatEth(t.rewardWei)} ETH, deadline ${formatTime(t.deadline)}`)
    .join("; ") || "none";

  // Latest verdicts (settled, newest first)
  const latestVerdicts = trials
    .filter((t) => t.status === "settled")
    .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0))
    .slice(0, 5)
    .map((t) => `#${t.id}: ${t.verdict}, payout ${t.payoutWei ? formatEth(t.payoutWei) : "?"} ETH`)
    .join("; ") || "none";

  // Escrowed totals (active trials = assigned + judging + challenged)
  const activeTrials = trials.filter((t) => ["assigned", "judging", "challenged"].includes(t.status));
  const totalStaked = activeTrials.reduce((sum, t) => sum + t.bondWei, 0n);
  const totalRewards = activeTrials.reduce((sum, t) => sum + t.rewardWei, 0n);

  // Drift/epoch status - from agent registry activity
  const activeAgents = agents.filter((a) => a.active > 0).length;
  const totalAgents = agents.length;

  // Wallet connection - not available server-side, client injects
  return `
CRUCIBLE LIVE CONTEXT (as of ${new Date(now).toISOString()}):
- Open trials (${openTrials.length}): ${openTrialsSummary}
- Latest verdicts (${trials.filter((t) => t.status === "settled").length} total): ${latestVerdicts}
- Active trials: ${activeTrials.length} (staked: ${formatEth(totalStaked)} ETH, rewards: ${formatEth(totalRewards)} ETH)
- Active agents: ${activeAgents}/${totalAgents}
- Surfaces: /trials (the forge); /verticals (the RWA NAV and PayFi reconciliation exams); /escrow (a wallet's ETH: locked in trials, free stake, or claimable); /mcp (eleven tools, resource subscriptions, unsigned transaction drafts); sponsor on-ramp (a single-use Coinbase session; the provider sends ETH to the sponsor's own wallet).
- Settlement: native ETH only; the fee is five percent (500 bps); no ERC-20, no bridge, and no RWA custody.
- Your wallet: [INJECTED BY CLIENT]
`.trim();
}

function formatEth(wei: bigint): string {
  const s = wei.toString();
  const padded = s.padStart(19, "0");
  const whole = padded.slice(0, -18);
  const frac = padded.slice(-18).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function formatTime(ts: number): string {
  if (ts === 0) return "never";
  const diff = ts - Math.floor(now() / 1000);
  if (diff <= 0) return "expired";
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

let now = () => Date.now();

/**
 * Request the LLM with the injected context.
 */
async function askLLM(config: FrenchyConfig["llm"], prompt: string, history: { role: "user" | "assistant"; content: string }[]): Promise<string> {
  const baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.slice(-6).map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: prompt },
  ];

  const res = await (config.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      max_tokens: 300,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    dlq.push("frenchy.llm", `provider answered ${res.status}: ${text.slice(0, 200)}`);
    throw new Error("the brain is foggy");
  }

  // `Response.json()` is `unknown` under Node's types, and the shape here is known: an
  // OpenAI-compatible chat completion. Saying so is what lets the compiler check the walk down
  // to the reply instead of `any`-ing it away.
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error("the brain gave no answer");
  return reply;
}

/**
 * Premium TTS via ElevenLabs (reuses voice.ts logic).
 */
async function speakTTS(config: NonNullable<FrenchyConfig["tts"]>, text: string): Promise<Blob> {
  const baseUrl = (config.baseUrl ?? "https://api.elevenlabs.io").replace(/\/+$/, "");
  const url = `${baseUrl}/v1/text-to-speech/${encodeURIComponent(config.voiceId)}/stream`;

  const res = await (config.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: {
      "xi-api-key": config.apiKey,
      "content-type": "application/json",
      accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: config.modelId ?? "eleven_multilingual_v4",
      voice_settings: { stability: 0.55, style: 0.35, speed: 0.95 },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok || !res.body) {
    dlq.push("frenchy.tts", `provider answered ${res.status}`);
    throw new Error("the voice failed");
  }

  return await res.blob();
}

export function createFrenchyRoutes(config: FrenchyConfig | null): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    if (!config) {
      return c.json({ error: "Frenchy's brain is not configured" }, 503);
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

    const { prompt, history, wallet, mode } = body as {
      prompt?: unknown;
      history?: unknown;
      wallet?: unknown;
      mode?: unknown;
    };

    if (typeof prompt !== "string" || !prompt.trim()) {
      return c.json({ error: "prompt is required" }, 400);
    }

    // Validate history
    let validatedHistory: { role: "user" | "assistant"; content: string }[] = [];
    if (Array.isArray(history)) {
      validatedHistory = history
        .filter((h): h is { role: "user" | "assistant"; content: string } =>
          h && typeof h === "object" &&
          (h.role === "user" || h.role === "assistant") &&
          typeof h.content === "string"
        )
        .slice(-12);
    }

    // Build context from the live read model
    const deps = (c as any).var?.apiDeps;
    const model = deps?.getModel?.() ?? { trials: new Map(), agents: new Map(), runs: new Map(), disputes: new Map(), version: 0 } as ReadModel;

    const context = buildContext(model);
    const walletContext = wallet && typeof wallet === "object" && "address" in wallet
      ? `\n- Your wallet: ${(wallet as any).address}`
      : "\n- Your wallet: not connected";

    const fullPrompt = `${context}${walletContext}\n\nUser: ${prompt.trim()}`;

    try {
      const reply = await askLLM(config.llm, fullPrompt, validatedHistory);
      return c.json({ reply, mode: mode === "voice" ? "voice" : "text" });
    } catch (err) {
      dlq.push("frenchy", err instanceof Error ? err.message : "brain error");
      return c.json({ error: "Frenchy is momentarily indisposed" }, 502);
    }
  });

  app.post("/voice", async (c) => {
    if (!config?.tts) {
      return c.json({ error: "premium voice not configured" }, 503);
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

    const { text } = body as { text?: unknown };
    if (typeof text !== "string" || !text.trim() || text.length > 600) {
      return c.json({ error: "text is required (max 600 chars)" }, 400);
    }

    try {
      const blob = await speakTTS(config.tts, text.trim());
      return new Response(blob, {
        status: 200,
        headers: {
          "content-type": "audio/mpeg",
          "cache-control": "no-store",
        },
      });
    } catch {
      return c.json({ error: "the voice failed" }, 502);
    }
  });

  app.get("/scribe-url", async (c) => {
    if (!config?.scribe) {
      return c.json({ error: "scribe not configured" }, 503);
    }
    const cfg = config.scribe;
    const baseUrl = (cfg.baseUrl ?? "https://api.elevenlabs.io").replace(/\/+$/, "");
    const fetchImpl = cfg.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(`${baseUrl}/v1/single-use-token/realtime_scribe`, {
        method: "POST",
        headers: { "xi-api-key": cfg.apiKey, "content-type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        dlq.push("frenchy.scribe", `token mint failed ${res.status}: ${text.slice(0, 200)}`);
        return c.json({ error: "could not mint scribe token" }, 502);
      }
      const data = (await res.json().catch(() => null)) as { token?: string } | null;
      if (!data?.token) {
        dlq.push("frenchy.scribe", "token mint returned no token");
        return c.json({ error: "could not mint scribe token" }, 502);
      }
      const modelId = cfg.modelId ?? "scribe_v2_realtime";
      const wsUrl = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=${encodeURIComponent(modelId)}&token=${encodeURIComponent(data.token)}&commit_strategy=vad&vad_silence_threshold_secs=1.5`;
      return c.json({ url: wsUrl }, 200, { "cache-control": "no-store" });
    } catch (err) {
      dlq.push("frenchy.scribe", err instanceof Error ? err.message : "scribe error");
      return c.json({ error: "scribe unavailable" }, 502);
    }
  });

  return app;
}