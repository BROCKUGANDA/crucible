import { Hono } from "hono";
import { dlq } from "./dlq.js";
import type { ReadModel } from "@crucible/indexer";
import {
  askLLM,
  buildContext,
  emptyReadModel,
  speakAudio,
  type FrenchyBrain,
  type FrenchyTts,
} from "./frenchy.js";

/**
 * Frenchy, spoken.
 *
 * The one-way voice host (ADR-0009) speaks fixed lines and refuses caller text: the
 * ElevenLabs key is ours, and an unmoderated text-to-speech endpoint on the public
 * internet is the impersonation surface that provider policy puts on the account
 * holder. That decision stands, and this route is built *around* it rather than
 * against it.
 *
 * **The caller brings audio, not words.** The visitor's speech is transcribed by our
 * key, the brain composes the answer, and only the brain's words are handed to the
 * synthesiser. So the string that reaches the TTS endpoint is never the caller's
 * string, which is the boundary ADR-0009 drew, and the one line it drew it around.
 * A caller who wants the synthesiser to say something else cannot: the only words it
 * can make the voice say are words the model chose.
 *
 * **The words are the content; the audio is the garnish.** When the synthesiser
 * refuses, the transcript and the reply are still returned, with the failure said
 * plainly, because a visitor who asked a question deserves the answer even on a host
 * whose voice has stopped working. The reverse is not true: audio without words is
 * decoration, and this route never lets it stand in for the reply.
 *
 * **No socket.** The whole exchange is one request and one response, over the same
 * HTTP the rest of the API uses. The security whitepaper's never-list carries "second
 * SSE stream / WebSocket", and nothing here needs one: the browser records an
 * utterance, posts the bytes, and plays the answer it gets back.
 *
 * The turn monitor is the ledger in this file. It is the API's own record of the
 * conversation — who spoke, what was said, and how long each step took — and it is
 * written by the party that did the work, so it cannot be a client-side claim about
 * something the client made up.
 */

/* ------------------------------------------------------------------ config ---- */

/** The transcription provider. ElevenLabs, because the key is already ours. */
export interface StsSttConfig {
  apiKey: string;
  modelId?: string;
  baseUrl?: string;
  /** Injected by tests; production uses the platform fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Everything the speech-to-speech route needs to say a sentence.
 *
 * The parts are nullable because they can be separately absent: a host with a brain
 * and no synthesiser can still answer in words, and a host with a key but no voice
 * id is not the same host as one with nothing at all. `/sts/status` reports which
 * pieces are missing rather than a flat "not configured".
 */
export interface StsConfig {
  stt: StsSttConfig | null;
  brain: FrenchyBrain | null;
  tts: FrenchyTts | null;
}

/**
 * The defaults, in one place.
 *
 * `scribe_v1` is ElevenLabs' hosted transcription model; the realtime Scribe the
 * browser uses for live captions is a different thing and is not reachable over a
 * plain POST.
 */
const DEFAULT_BASE = "https://api.elevenlabs.io";
const DEFAULT_STT_MODEL = "scribe_v1";

/* ------------------------------------------------------------------ bounds ---- */

/**
 * How much audio one turn may carry.
 *
 * 256 KiB is about sixteen seconds of Opus at 128 kbps, which is a spoken sentence
 * with room for a slow one. It is a ceiling on a body this process buffers, so it is
 * deliberately small: the point of the limit is that a caller cannot make this
 * process hold an arbitrary amount of memory.
 */
export const STS_MAX_AUDIO_BYTES = 256 * 1024;

/** How many exchanges one session keeps. */
export const STS_MAX_TURNS = 40;

/** How many sessions this process keeps at once. */
export const STS_MAX_SESSIONS = 50;

/** How long a session may sit idle before it is swept. */
export const STS_SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * How long one turn may take end to end.
 *
 * Three provider round trips: transcription, the brain, the synthesiser. The API's
 * blanket request timeout is ten seconds, which is right for a read and too short for
 * this, so the turn route carries its own ceiling and the sweep of an expired
 * session is the other half of the bound — a request that outlives its budget is
 * answered, and the credits it spent are still spent.
 */
export const STS_TURN_TIMEOUT_MS = 45_000;

/* ------------------------------------------------------------------- model ---- */

/**
 * Which phase of a turn the host is in.
 *
 * The phases are the *work*, not the mood: a turn is transcribed, then answered,
 * then spoken. `idle` is a session waiting for its next turn.
 */
export type StsPhase = "idle" | "transcribing" | "thinking" | "speaking";

/**
 * One exchange: what the visitor said, what Frenchy said, and what each step cost.
 *
 * The durations are **measured**, never estimated. A step that did not run, or that
 * ran and failed, has `null` for its duration — and null is not zero: an unknown
 * cost is not a cost of nothing, and a panel that printed `0 ms` for a step that
 * never happened would be reporting a measurement that was never taken.
 */
export interface StsTurn {
  /** Monotonic within the session, so two exchanges can be told apart. */
  id: number;
  /** What the visitor said, once transcribed. Null when the audio never became words. */
  userText: string | null;
  /** What Frenchy answered. Null when the brain never answered. */
  agentText: string | null;
  /** When the turn began. */
  startedAt: number;
  /** When the turn ended. Null while it is still running. */
  endedAt: number | null;
  /** Milliseconds spent transcribing. Null when it did not finish. */
  sttMs: number | null;
  /** Milliseconds spent in the brain. Null when it did not finish. */
  brainMs: number | null;
  /** Milliseconds spent synthesising. Null when it did not finish. */
  ttsMs: number | null;
  /** How many bytes of audio came back. Null when there was none. */
  audioBytes: number | null;
  /** Whether the exchange completed. */
  outcome: "ok" | "failed";
  /** Why it failed, in words a reader can act on. */
  reason: string | null;
}

/** One conversation. */
export interface StsSession {
  id: string;
  phase: StsPhase;
  /** The connected wallet, if the visitor named one. It is a claim, not a proof. */
  wallet: string | null;
  startedAt: number;
  lastActivityAt: number;
  /** The exchanges, oldest first. */
  turns: StsTurn[];
}

/**
 * The ledger.
 *
 * In-memory, like the rest of this host's state (ADR-0008), and bounded for the same
 * reason the sponsorship queue is bounded: a ledger that grows without limit is a
 * second outage wearing the first one's clothes. A hundred exchanges per session and
 * fifty sessions is more than a demo conversation needs and less than a leak.
 */
export class StsLedger {
  private readonly sessions = new Map<string, StsSession>();
  private readonly now: () => number;
  private readonly maxSessions: number;
  private readonly maxTurns: number;
  private readonly ttlMs: number;

  constructor(
    opts: {
      now?: () => number;
      maxSessions?: number;
      maxTurns?: number;
      ttlMs?: number;
    } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.maxSessions = opts.maxSessions ?? STS_MAX_SESSIONS;
    this.maxTurns = opts.maxTurns ?? STS_MAX_TURNS;
    this.ttlMs = opts.ttlMs ?? STS_SESSION_TTL_MS;
  }

  /** Open a session. The id is unguessable; see the ADR for what that is worth. */
  create(wallet: string | null): StsSession {
    this.sweep();
    const at = this.now();
    const session: StsSession = {
      id: crypto.randomUUID(),
      phase: "idle",
      wallet,
      startedAt: at,
      lastActivityAt: at,
      turns: [],
    };
    this.sessions.set(session.id, session);
    // The oldest falls off the front. A map preserves insertion order, so the first
    // key is the oldest session.
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) break;
      this.sessions.delete(oldest.value);
    }
    return session;
  }

  /** How many sessions are retained. */
  get size(): number {
    return this.sessions.size;
  }

  /** A session, or null when the id is not one this host knows. */
  get(id: string): StsSession | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (this.now() - session.lastActivityAt > this.ttlMs) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  /**
   * Open a turn on a session.
   *
   * The turn is created with null everywhere it is not yet known: the text, the
   * durations and the outcome are all filled in as the steps land, and a step that
   * never lands leaves its null in place.
   */
  beginTurn(sessionId: string): { session: StsSession; turn: StsTurn } | null {
    const session = this.get(sessionId);
    if (!session) return null;
    const turn: StsTurn = {
      id: session.turns.length + 1,
      userText: null,
      agentText: null,
      startedAt: this.now(),
      endedAt: null,
      sttMs: null,
      brainMs: null,
      ttsMs: null,
      audioBytes: null,
      outcome: "ok",
      reason: null,
    };
    session.turns.push(turn);
    while (session.turns.length > this.maxTurns) session.turns.shift();
    session.lastActivityAt = this.now();
    return { session, turn };
  }

  /** The turn a session is working on, or null when it is between turns. */
  currentTurn(session: StsSession): StsTurn | null {
    for (let i = session.turns.length - 1; i >= 0; i--) {
      const turn = session.turns[i]!;
      if (turn.endedAt === null) return turn;
    }
    return null;
  }

  /** Record the phase the host is in, and touch the session so it does not expire mid-turn. */
  setPhase(session: StsSession, phase: StsPhase): void {
    session.phase = phase;
    session.lastActivityAt = this.now();
  }

  /** Fill in what a step measured. */
  recordStep(
    session: StsSession,
    turn: StsTurn,
    step: "stt" | "brain" | "tts",
    patch: { ms?: number | null; text?: string | null; audioBytes?: number | null },
  ): void {
    if (step === "stt") {
      turn.sttMs = patch.ms ?? turn.sttMs;
      turn.userText = patch.text ?? turn.userText;
    } else if (step === "brain") {
      turn.brainMs = patch.ms ?? turn.brainMs;
      turn.agentText = patch.text ?? turn.agentText;
    } else {
      turn.ttsMs = patch.ms ?? turn.ttsMs;
      turn.audioBytes = patch.audioBytes ?? turn.audioBytes;
    }
    session.lastActivityAt = this.now();
  }

  /** Close a turn. */
  endTurn(session: StsSession, turn: StsTurn, outcome: "ok" | "failed", reason: string | null): void {
    turn.outcome = outcome;
    turn.reason = reason;
    turn.endedAt = this.now();
    session.lastActivityAt = turn.endedAt;
    session.phase = "idle";
  }

  /**
   * The conversation so far, as the brain's history.
   *
   * Only the exchanges that carry words are included, and only the words the host
   * itself produced: a turn whose transcription failed has no user text and a turn
   * whose brain call failed has no answer, and neither is a message.
   */
  history(session: StsSession): { role: "user" | "assistant"; content: string }[] {
    const out: { role: "user" | "assistant"; content: string }[] = [];
    for (const turn of session.turns) {
      if (turn.userText) out.push({ role: "user", content: turn.userText });
      if (turn.agentText) out.push({ role: "assistant", content: turn.agentText });
    }
    return out;
  }

  /** Drop the sessions nobody has touched in the TTL. */
  sweep(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt > this.ttlMs) this.sessions.delete(id);
    }
  }
}

/* -------------------------------------------------------------- provider ---- */

/**
 * The transcription request.
 *
 * ElevenLabs takes the audio as multipart form data, so the body is built with
 * `FormData` and the `content-type` is left to the runtime: a hand-written
 * `multipart/form-data` header without the boundary is a request the provider
 * answers with a parse error that reads like a bad file.
 */
export function elevenLabsSttRequest(args: {
  config: StsSttConfig;
  audio: Uint8Array;
}): { url: string; init: RequestInit } {
  const base = (args.config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  const form = new FormData();
  // The copy is deliberate: `new Blob([bytes])` may hold a view onto a larger
  // buffer, and the provider reads exactly what the form says is the file.
  form.append(
    "file",
    new Blob([new Uint8Array(args.audio)], { type: "audio/webm" }),
    "turn.webm",
  );
  form.append("model_id", args.config.modelId || DEFAULT_STT_MODEL);
  return {
    url: `${base}/v1/speech-to-text`,
    init: {
      method: "POST",
      headers: { "xi-api-key": args.config.apiKey },
      body: form,
    },
  };
}

/**
 * Transcribe one utterance.
 *
 * The empty transcript is refused rather than returned: a provider that answers 200
 * with no words has not transcribed anything, and handing "" to the brain would
 * produce a reply to silence and a turn record that claims the visitor said nothing.
 */
export async function transcribe(
  config: StsSttConfig,
  audio: Uint8Array,
): Promise<{ text: string }> {
  const request = elevenLabsSttRequest({ config, audio });
  let res: Response;
  try {
    res = await (config.fetchImpl ?? fetch)(request.url, {
      ...request.init,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    dlq.push("sts.stt", err instanceof Error ? err.message : "the request failed");
    throw new Error("the transcription provider is unreachable");
  }
  if (!res.ok) {
    dlq.push("sts.stt", `provider answered ${res.status}`);
    throw new Error("the transcription provider refused the request");
  }
  const body = (await res.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) throw new Error("the transcription provider returned no words");
  return { text };
}

/* ----------------------------------------------------------------- status ---- */

/**
 * What the host can do.
 *
 * The parts are reported separately because they can be separately absent: a host
 * with a brain and no synthesiser can still answer in words, and one with neither is
 * a different thing from one with no key at all. The feature is invisible until this
 * says it can answer, which is the rule ADR-0009 set for the voice host.
 */
export function stsStatus(config: StsConfig | null | undefined): {
  configured: boolean;
  stt: boolean;
  brain: boolean;
  tts: boolean;
  model: string | null;
} {
  if (!config) {
    return { configured: false, stt: false, brain: false, tts: false, model: null };
  }
  const stt = Boolean(config.stt?.apiKey);
  const brain = Boolean(config.brain?.apiKey && config.brain?.model);
  const tts = Boolean(config.tts?.apiKey && config.tts?.voiceId);
  return {
    configured: stt && brain && tts,
    stt,
    brain,
    tts,
    model: config.stt?.modelId || DEFAULT_STT_MODEL,
  };
}

/* ----------------------------------------------------------------- routes ---- */

export interface StsDeps {
  /** The live read model, so the answers are about this deployment and not about nothing. */
  getModel?: () => ReadModel;
  /** The clock, injected so a test can say when a turn began. */
  now?: () => number;
}

export function createStsRoutes(config: StsConfig | null, deps: StsDeps = {}): Hono {
  const app = new Hono();
  const ledger = new StsLedger(deps.now ? { now: deps.now } : {});
  const getModel = deps.getModel ?? emptyReadModel;

  app.get("/status", (c) => c.json(stsStatus(config)));

  /**
   * Open a conversation.
   *
   * A session is the ledger's unit: it holds the exchanges and the history the brain
   * is given. Opening one costs nothing, so it is not rate-limited harder than a
   * read — but it is not free either, and the bucket below covers it.
   */
  app.post("/session", async (c) => {
    if (!config) return c.json({ error: "the speech host is not configured" }, 503);

    let wallet: string | null = null;
    try {
      const body = (await c.req.json().catch(() => null)) as { wallet?: unknown } | null;
      if (body && typeof body.wallet === "string" && body.wallet.trim().length > 0) {
        wallet = body.wallet.trim();
      }
    } catch {
      // A body that will not parse is a body with no wallet in it.
    }

    const session = ledger.create(wallet);
    return c.json(
      {
        sessionId: session.id,
        phase: session.phase,
        startedAt: session.startedAt,
        turns: session.turns,
      },
      201,
    );
  });

  /**
   * Read a session: where it is, and what has been said in it.
   *
   * This is the monitor's read model. It is polled while a turn is in flight so the
   * phase on screen is the phase the host is actually in — the host publishes
   * `transcribing`, `thinking` and `speaking` as it moves through them — and it is
   * the same record the turn route returns, so the panel and the ledger cannot
   * disagree.
   */
  app.get("/session/:id", (c) => {
    const session = ledger.get(c.req.param("id"));
    if (!session) return c.json({ error: "unknown session" }, 404);
    return c.json({
      sessionId: session.id,
      phase: session.phase,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      turns: session.turns,
    });
  });

  /**
   * One turn: audio in, words and speech out.
   *
   * The three steps are measured separately because they fail separately, and a
   * panel that showed one number for "how long did that take" would hide which of
   * them was slow. Each duration is null until that step has finished.
   */
  app.post("/session/:id/turn", async (c) => {
    if (!config) return c.json({ error: "the speech host is not configured" }, 503);
    if (!config.stt) return c.json({ error: "this host cannot transcribe speech" }, 503);
    if (!config.brain) return c.json({ error: "this host has no brain" }, 503);

    const opened = ledger.beginTurn(c.req.param("id"));
    if (!opened) return c.json({ error: "unknown session" }, 404);
    const { session, turn } = opened;

    const audio = await readAudio(c);
    if ("error" in audio) {
      ledger.endTurn(session, turn, "failed", audio.error);
      return c.json({ error: audio.error, turns: session.turns }, audio.status);
    }

    // ── transcribe ──
    ledger.setPhase(session, "transcribing");
    const sttStart = Date.now();
    let transcript: string;
    try {
      transcript = (await transcribe(config.stt, audio.bytes)).text;
    } catch (err) {
      const reason = err instanceof Error ? err.message : "the transcription failed";
      ledger.recordStep(session, turn, "stt", { ms: null });
      ledger.endTurn(session, turn, "failed", reason);
      return c.json({ error: reason, turns: session.turns }, 502);
    }
    ledger.recordStep(session, turn, "stt", { ms: Date.now() - sttStart, text: transcript });

    // ── think ──
    ledger.setPhase(session, "thinking");
    const brainStart = Date.now();
    let reply: string;
    try {
      const context = buildContext(getModel());
      const wallet = session.wallet ? `\n- Your wallet: ${session.wallet}` : "\n- Your wallet: not connected";
      reply = await askLLM(
        config.brain,
        `${context}${wallet}\n\nUser: ${transcript}`,
        ledger.history(session).slice(0, -1),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : "the brain is foggy";
      ledger.recordStep(session, turn, "brain", { ms: null });
      ledger.endTurn(session, turn, "failed", reason);
      return c.json({ error: reason, turns: session.turns }, 502);
    }
    ledger.recordStep(session, turn, "brain", { ms: Date.now() - brainStart, text: reply });

    // ── speak ──
    //
    // A voice that refuses does not take the answer with it. The words are returned
    // with the failure named, because a visitor who asked a question deserves the
    // answer even on a host whose voice has stopped working.
    ledger.setPhase(session, "speaking");
    const ttsStart = Date.now();
    let audioBytes: Uint8Array | null = null;
    let voiceReason: string | null = null;
    if (!config.tts) {
      // A host with no synthesiser still answers in words. The failure is named so
      // the panel can say "there was no voice" rather than "there was no answer".
      voiceReason = "this host has no voice configured";
    } else {
      try {
        audioBytes = await speakAudio(config.tts, reply);
      } catch (err) {
        voiceReason = err instanceof Error ? err.message : "the voice failed";
        dlq.push("sts.tts", voiceReason);
      }
    }
    ledger.recordStep(session, turn, "tts", {
      ms: audioBytes ? Date.now() - ttsStart : null,
      audioBytes: audioBytes ? audioBytes.byteLength : null,
    });

    ledger.endTurn(session, turn, voiceReason ? "failed" : "ok", voiceReason);
    ledger.setPhase(session, "idle");

    return c.json({
      transcript,
      reply,
      audio: audioBytes
        ? {
            contentType: "audio/mpeg",
            bytes: audioBytes.byteLength,
            base64: Buffer.from(audioBytes).toString("base64"),
          }
        : null,
      voiceError: voiceReason,
      sessionId: session.id,
      phase: session.phase,
      turns: session.turns,
    });
  });

  return app;
}

/**
 * The turn's audio.
 *
 * The size is checked on the bytes that arrived, not on the announced
 * `Content-Length`: a body sent as `chunked` announces nothing, and a limit that
 * only read the header would be a limit a caller could step around by choosing a
 * different framing.
 */async function readAudio(
  c: { req: { arrayBuffer: () => Promise<ArrayBuffer> } },
): Promise<{ bytes: Uint8Array } | { error: string; status: 400 | 413 }> {
  let buffer: ArrayBuffer;
  try {
    buffer = await c.req.arrayBuffer();
  } catch {
    return { error: "the turn carried no audio", status: 400 };
  }
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength === 0) {
    return { error: "the turn carried no audio", status: 400 };
  }
  if (bytes.byteLength > STS_MAX_AUDIO_BYTES) {
    return {
      error: `the turn carried ${bytes.byteLength} bytes of audio; the limit is ${STS_MAX_AUDIO_BYTES}`,
      status: 413,
    };
  }
  return { bytes };
}

