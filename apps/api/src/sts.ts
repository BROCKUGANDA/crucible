import { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
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
 * The one-way voice host (ADR-0009) speaks fixed lines and refuses caller text:
 * the ElevenLabs key is ours, and an unmoderated text-to-speech endpoint on the
 * public internet is the impersonation surface that provider policy puts on the
 * account holder. That decision stands, and this route is built *around* it
 * rather than against it.
 *
 * **The caller brings audio, not words.** The visitor's speech is transcribed by
 * our key, the brain composes the answer, and **only the brain's words** are
 * handed to the synthesiser. So the string that reaches the TTS endpoint is never
 * the caller's string, which is the boundary ADR-0009 drew, and the one line it
 * drew it around. A caller who wants the synthesiser to say something else
 * cannot: the only words it can make the voice say are words the model chose.
 *
 * **The words are the content; the audio is the garnish.** When the synthesiser
 * refuses, the transcript and the reply are still returned, with the failure said
 * plainly, because a visitor who asked a question deserves the answer even on a
 * host whose voice has stopped working. The reverse is not true: audio without
 * words is decoration, and this route never lets it stand in for the reply.
 *
 * **No socket.** The whole exchange is one request and one response, over the same
 * HTTP the rest of the API uses. The security whitepaper's never-list carries
 * "second SSE stream / WebSocket", and nothing here needs one: the browser
 * records an utterance, posts the bytes, and plays the answer it gets back.
 *
 * The turn monitor is the ledger in this file. It is the API's own record of the
 * conversation — who spoke, what was said, and how long each step took — and it
 * is written by the party that did the work, so it cannot be a client-side claim
 * about something the client made up.
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

/* --------------------------------------------------------------- credential ---- */

/**
 * The header the session token travels in.
 *
 * **Not `Authorization`.** The Fetch specification forbids a wildcard
 * `Access-Control-Allow-Origin` on a request that carries an `Authorization`
 * header, and this API supports a `ALLOWED_ORIGINS=*` deployment — the public
 * anonymous reads the transport policy describes. A custom header has no such
 * rule, so the session works under both shapes of the allowlist.
 *
 * A header rather than a path segment, for the reason that matters: **a path
 * segment travels.** It lands in an access log, in the browser's history, and in a
 * `Referer` header when the page links anywhere. A credential in any of those is a
 * credential in three places it was not meant to be.
 */
export const STS_TOKEN_HEADER = "x-crucible-session";

/** The token's length in bytes. 32 bytes is 256 bits. */
const TOKEN_BYTES = 32;

/**
 * The digest a session is keyed by.
 *
 * The ledger holds **digests, not tokens**. A token is a bearer credential, and a
 * process that keeps live bearer credentials in memory is a process whose memory
 * dump is a list of conversations. Hashing on the way in means the raw token
 * exists in exactly one place — the browser that owns the conversation — and the
 * host holds only the digest it compares against.
 */
export function sessionDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A fresh session token. */
export function newSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/* ------------------------------------------------------------------- model ---- */

/**
 * Which phase of a turn the host is in.
 *
 * The phases are the *work*, not the mood: a turn is transcribed, then answered,
 * then spoken. `idle` is a session waiting for its next turn.
 */
export type StsPhase = "idle" | "transcribing" | "thinking" | "speaking";

/**
 * How a turn ended.
 *
 * `interrupted` is the one that is not a failure: the visitor answered again
 * while this turn was still running, so it was **superseded**, and the ledger
 * says so rather than calling it a provider error.
 */
export type StsOutcome = "ok" | "failed" | "interrupted";

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
  /** How the exchange ended. */
  outcome: StsOutcome;
  /** Why it failed or was interrupted, in words a reader can act on. */
  reason: string | null;
}

/** One conversation. */
export interface StsSession {
  /**
   * A short, public handle for the session: the first eight characters of the
   * digest. It is for a log line and a panel heading, and it is **not** a
   * credential — it cannot open the session.
   */
  ref: string;
  phase: StsPhase;
  /** The connected wallet, if the visitor named one. It is a claim, not a proof. */
  wallet: string | null;
  startedAt: number;
  lastActivityAt: number;
  /** The exchanges, oldest first. */
  turns: StsTurn[];
  /** The turn in flight, and the handle that stops it. */
  inflight: { turnId: number; controller: AbortController } | null;
}

/**
 * The ledger.
 *
 * In-memory, like the rest of this host's state (ADR-0008), and bounded for the same
 * reason the sponsorship queue is bounded: a ledger that grows without limit is a
 * second outage wearing the first one's clothes. A hundred exchanges per session and
 * fifty sessions is more than a demo conversation needs and less than a leak.
 *
 * **Keyed by digest.** The map holds `sha256(token)`, never the token.
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

  /**
   * Open a session, and hand back the token that owns it.
   *
   * The token is returned **once**, here. There is no route that gives it back,
   * because a route that gives a bearer credential back is a route that puts it in
   * a log.
   */
  create(wallet: string | null): { session: StsSession; token: string } {
    this.sweep();
    const at = this.now();
    const token = newSessionToken();
    const digest = sessionDigest(token);
    const session: StsSession = {
      ref: digest.slice(0, 8),
      phase: "idle",
      wallet,
      startedAt: at,
      lastActivityAt: at,
      turns: [],
      inflight: null,
    };
    this.sessions.set(digest, session);
    // The oldest falls off the front. A map preserves insertion order, so the first
    // key is the oldest session.
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) break;
      this.sessions.delete(oldest.value);
    }
    return { session, token };
  }

  /**
   * The session a token owns, or null.
   *
   * The token is hashed here, so the comparison is over digests and the ledger
   * never holds the credential itself.
   */
  get(token: string): StsSession | null {
    if (!token) return null;
    const session = this.sessions.get(sessionDigest(token));
    if (!session) return null;
    if (this.now() - session.lastActivityAt > this.ttlMs) {
      this.sessions.delete(sessionDigest(token));
      return null;
    }
    return session;
  }

  /** How many sessions are retained. */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Open a turn on a session.
   *
   * **A new turn supersedes the one in flight.** The visitor answered again, so
   * the answer to the previous words is no longer the answer they want: the
   * in-flight turn is stopped and recorded as `interrupted`, and the ledger says
   * that rather than calling it a provider error or letting it land as `ok`.
   *
   * The turn is created with null everywhere it is not yet known: the text, the
   * durations and the outcome are all filled in as the steps land, and a step that
   * never lands leaves its null in place.
   */
  beginTurn(session: StsSession): { session: StsSession; turn: StsTurn } {
    this.interrupt(session, "the visitor answered again");

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
    const controller = new AbortController();
    session.inflight = { turnId: turn.id, controller };
    return { session, turn };
  }

  /**
   * Stop the turn in flight and record that it was superseded.
   *
   * The abort is what stops the provider calls; the record is what keeps the
   * ledger honest about it. Both happen, and neither is left to the turn's own
   * handler — the handler may already be gone.
   */
  interrupt(session: StsSession, reason: string): void {
    const inflight = session.inflight;
    if (!inflight) return;
    session.inflight = null;
    inflight.controller.abort();
    const turn = session.turns.find((t) => t.id === inflight.turnId);
    if (turn) this.endTurn(session, turn, "interrupted", reason);
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

  /**
   * Close a turn.
   *
   * **Idempotent.** A turn that was already closed — because a newer turn
   * superseded it — is not closed again: the first word about how it ended is the
   * one that stands.
   */
  endTurn(session: StsSession, turn: StsTurn, outcome: StsOutcome, reason: string | null): void {
    if (turn.endedAt !== null) return;
    turn.outcome = outcome;
    turn.reason = reason;
    turn.endedAt = this.now();
    session.lastActivityAt = turn.endedAt;
    if (session.inflight?.turnId === turn.id) session.inflight = null;
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
    for (const [digest, session] of this.sessions) {
      if (now - session.lastActivityAt > this.ttlMs) this.sessions.delete(digest);
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
  signal?: AbortSignal,
): Promise<{ text: string }> {
  const request = elevenLabsSttRequest({ config, audio });
  let res: Response;
  try {
    res = await (config.fetchImpl ?? fetch)(request.url, {
      ...request.init,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : undefined,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
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

/** The session token on a request, or null when there is none. */
export function readSessionToken(header: string | undefined | null): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createStsRoutes(config: StsConfig | null, deps: StsDeps = {}): Hono {
  const app = new Hono();
  const ledger = new StsLedger(deps.now ? { now: deps.now } : {});
  const getModel = deps.getModel ?? emptyReadModel;

  app.get("/status", (c) => c.json(stsStatus(config)));

  /**
   * Open a conversation.
   *
   * The response carries the **token** that owns the session, and the token is
   * never sent again by the host: it goes back in a header, and there is no route
   * that hands it out a second time. The session's public `ref` is the first eight
   * characters of the digest, which is for a log line and not a credential.
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

    const { session, token } = ledger.create(wallet);
    return c.json(
      {
        token,
        ref: session.ref,
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
   *
   * The token travels in a header, so the URL carries no credential: an access log
   * of this route records that a session was read and not who it was.
   */
  app.get("/session", (c) => {
    const token = readSessionToken(c.req.header(STS_TOKEN_HEADER));
    const session = token ? ledger.get(token) : null;
    if (!session) return c.json({ error: "unknown or expired session" }, 401);
    return c.json({
      ref: session.ref,
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
   *
   * **A turn that is superseded is not a failure.** A newer turn stops this one,
   * and the ledger records `interrupted` — the visitor answered again, so the
   * answer to the previous words is not the answer they wanted.
   */
  app.post("/turn", async (c) => {
    if (!config) return c.json({ error: "the speech host is not configured" }, 503);
    if (!config.stt) return c.json({ error: "this host cannot transcribe speech" }, 503);
    if (!config.brain) return c.json({ error: "this host has no brain" }, 503);

    const token = readSessionToken(c.req.header(STS_TOKEN_HEADER));
    const session = token ? ledger.get(token) : null;
    if (!session) return c.json({ error: "unknown or expired session" }, 401);

    const { turn } = ledger.beginTurn(session);
    const signal = session.inflight?.controller.signal;

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
      transcript = (await transcribe(config.stt, audio.bytes, signal)).text;
    } catch (err) {
      if (signal?.aborted) {
        // Superseded by a newer turn: the ledger already says so.
        return c.json({ interrupted: true, turns: session.turns }, 409);
      }
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
        signal,
      );
    } catch (err) {
      if (signal?.aborted) {
        return c.json({ interrupted: true, turns: session.turns }, 409);
      }
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
        audioBytes = await speakAudio(config.tts, reply, signal);
      } catch (err) {
        if (signal?.aborted) {
          return c.json({ interrupted: true, turns: session.turns }, 409);
        }
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
 */
async function readAudio(
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
