import { Hono } from "hono";
import { dlq } from "./dlq.js";
import type { ReadModel } from "@crucible/indexer";
import { FRENCHY_SYSTEM_PROMPT } from "./frenchy/prompt.js";
import { parseEnvelope, spokenWindow, type FrenchyAnswer } from "./frenchy/envelope.js";

export type FrenchyMode = "text" | "voice";

/**
 * The brain's provider configuration.
 *
 * Named separately because the speech-to-speech host (`sts.ts`) borrows exactly this
 * configuration and nothing else: one brain, one provider key, one prompt.
 */
export interface FrenchyBrain {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Injected by tests; production uses the platform fetch. */
  fetchImpl?: typeof fetch;
  /**
   * How long the brain may take, in milliseconds.
   *
   * A brain that answers in two seconds and one that takes twenty are both
   * working; the difference is the provider and the size of the prompt, and
   * neither is a fault. The blanket request timeout is ten seconds, so this
   * is the ceiling for the brain itself - and the browser says "Thinking..."
   * for as long as it takes.
   */
  timeoutMs?: number;
}

/** The premium voice's provider configuration. */
export interface FrenchyTts {
  apiKey: string;
  voiceId: string;
  modelId?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface FrenchyConfig {
  /** LLM provider configuration. */
  llm: FrenchyBrain;
  /** Optional premium TTS (ElevenLabs). If absent, the voice route is disabled. */
  tts?: FrenchyTts;
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
const SYSTEM_PROMPT = FRENCHY_SYSTEM_PROMPT;

/**
 * Build the context string from the live read model.
 *
 * Exported because the speech-to-speech host answers the same questions and must be
 * grounded in the same facts: two hosts that each built their own context would be
 * two places where "what is open right now?" could be answered differently.
 */
export function buildContext(model: ReadModel): string {
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
- Surfaces: the site index in the prompt lists every route of this site, what it is for, and what a visitor can do there; a path that is not in it is not a page, and the host refuses it.
- Endpoints that are not pages: /mcp (eleven tools, resource subscriptions, unsigned transaction drafts); sponsor on-ramp (a single-use Coinbase session; the provider sends ETH to the sponsor's own wallet).
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
 *
 * Exported for the same reason `buildContext` is: one brain, one prompt, one place
 * where the refusal to answer an empty question lives.
 *
 * `signal` lets the caller stop the request. The speech host uses it to abandon a
 * turn the visitor has already answered again: the provider call is torn down
 * rather than left running to produce an answer nobody wants. The timeout is
 * composed with it, so a call that is neither interrupted nor timed out still
 * cannot hang.
 */
export async function askLLM(
  config: FrenchyBrain,
  prompt: string,
  history: { role: "user" | "assistant"; content: string }[],
  signal?: AbortSignal,
): Promise<string> {
  const raw = await askProvider(config, prompt, history, signal);
  const { answer } = parseEnvelope(raw);
  return answer ? answer.spoken : spokenWindow(raw);
}

/**
 * The whole answer: what to say, what to show, and what to do.
 *
 * The chat route uses this; the speech-to-speech host uses `askLLM`, because
 * a voice turn wants the line and nothing else. Both go through the same
 * parser, so a model that answers in the envelope is understood the same way
 * in both places - one brain, one prompt, one reader.
 *
 * A model that does not answer in the envelope at all is not a failure: the
 * raw text becomes the spoken line (cut to what the voice can carry) and the
 * panel shows the whole of it, which is what happened before the envelope
 * existed.
 */
export async function askLLMDetailed(
  config: FrenchyBrain,
  prompt: string,
  history: { role: "user" | "assistant"; content: string }[],
  signal?: AbortSignal,
): Promise<FrenchyAnswer> {
  const raw = await askProvider(config, prompt, history, signal);
  const { answer, refused } = parseEnvelope(raw);
  for (const reason of refused) dlq.push("frenchy.action", reason);
  if (answer) return answer;
  return {
    spoken: spokenWindow(raw),
    detail: raw.trim().slice(0, 4_000) || null,
    action: null,
  };
}

/**
 * How long the brain may take.
 *
 * Thirty seconds by default, because a provider that is slow is still
 * answering, and the browser says "Thinking..." the whole time. The visitor
 * is not better served by a 504 than by an answer that arrives late.
 */
export const DEFAULT_BRAIN_TIMEOUT_MS = 30_000;

function brainTimeoutMs(config: FrenchyBrain): number {
  const value = config.timeoutMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_BRAIN_TIMEOUT_MS;
}

/**
 * The provider call itself.
 *
 * Split out so the two shapes of "ask" - a line, or the whole answer - share
 * one request. Two requests would be two places for the model's answer to
 * drift.
 */
async function askProvider(
  config: FrenchyBrain,
  prompt: string,
  history: { role: "user" | "assistant"; content: string }[],
  signal?: AbortSignal,
): Promise<string> {
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
      // Enough room for the spoken line, the detail and the action. The old
      // 300 was enough for three sentences and nothing else, which is the
      // shape the old prompt asked for.
      max_tokens: 900,
      temperature: 0.7,
    }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(brainTimeoutMs(config))])
      : AbortSignal.timeout(brainTimeoutMs(config)),
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
 *
 * The bytes are returned rather than a `Blob` because the speech-to-speech host
 * needs the length of the audio as a number and the audio itself as a payload, and
 * two shapes of the same call is two places for the provider's request to drift.
 *
 * `signal` stops the synthesis when the turn that asked for it has been superseded.
 */
export async function speakAudio(
  config: FrenchyTts,
  text: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
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
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });

  if (!res.ok || !res.body) {
    dlq.push("frenchy.tts", `provider answered ${res.status}`);
    throw new Error("the voice failed");
  }

  return new Uint8Array(await res.arrayBuffer());
}

export interface FrenchyDeps {
  /**
   * The live read model.
   *
   * A dependency rather than something read off the request, so that the grounding
   * the system prompt promises is the grounding the host actually has. A host with
   * no chain behind it gets an empty model, and the prompt says so rather than
   * implying facts it does not have.
   */
  getModel?: () => ReadModel;
}

/**
 * The read model a host with no chain behind it hands to the brain.
 *
 * Exported so the speech host uses the same empty model rather than a second copy
 * of it: two empty models would be two places where "there is no chain here" is
 * decided, and the two could drift into meaning different things.
 */
export function emptyReadModel(): ReadModel {
  return {
    trials: new Map(),
    agents: new Map(),
    runs: new Map(),
    disputes: new Map(),
    version: 0,
  } as ReadModel;
}

export function createFrenchyRoutes(config: FrenchyConfig | null, deps: FrenchyDeps = {}): Hono {
  const app = new Hono();
  const getModel = deps.getModel ?? (() => emptyReadModel());

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

    // Build context from the live read model.
    //
    // The model is handed in by the caller, not read off the context variable.
    // It used to be read off `(c as any).var?.apiDeps`, and **nothing ever set
    // that variable**: the host answered every question with an empty read model,
    // while the system prompt told the model it was "grounded in live CRUCIBLE
    // state". A prompt that promises grounding the host does not provide is a
    // prompt that produces confident sentences about a deployment the model cannot
    // see, so the model is now a dependency the route is mounted with.
    const model = getModel();

    const context = buildContext(model);
    const walletContext = wallet && typeof wallet === "object" && "address" in wallet
      ? `\n- Your wallet: ${(wallet as any).address}`
      : "\n- Your wallet: not connected";

    const fullPrompt = `${context}${walletContext}\n\nUser: ${prompt.trim()}`;

    try {
      const answer = await askLLMDetailed(config.llm, fullPrompt, validatedHistory);
      return c.json({
        reply: answer.spoken,
        detail: answer.detail,
        action: answer.action,
        mode: mode === "voice" ? "voice" : "text",
      });
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
      const bytes = await speakAudio(config.tts, text.trim());
      return new Response(Buffer.from(bytes), {
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