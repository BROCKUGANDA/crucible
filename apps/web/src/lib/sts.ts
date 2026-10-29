"use client";

/**
 * The speech-to-speech client.
 *
 * The browser records an utterance, posts the bytes, and plays the answer it gets
 * back. There is no socket: the whole exchange is one request and one response,
 * which is the same shape as every other write this product makes.
 *
 * **The client holds no key and no words.** The provider key stays on the host,
 * and the words that reach the synthesiser are the model's — the visitor's speech
 * is transcribed by the host, not synthesised from anything the visitor typed.
 *
 * **The phase is read, not guessed.** While a turn is in flight the host publishes
 * which step it is in (`transcribing`, `thinking`, `speaking`), and the monitor
 * polls for it. The panel therefore shows the phase the host is actually in rather
 * than a guess made from a timer on the client, and a slow provider reads as a slow
 * provider instead of as a client that lost track.
 */

/** What the host can do. */
export interface StsStatus {
  configured: boolean;
  stt: boolean;
  brain: boolean;
  tts: boolean;
  model: string | null;
}

/** One exchange. */
export interface StsTurn {
  id: number;
  userText: string | null;
  agentText: string | null;
  startedAt: number;
  endedAt: number | null;
  sttMs: number | null;
  brainMs: number | null;
  ttsMs: number | null;
  audioBytes: number | null;
  outcome: "ok" | "failed";
  reason: string | null;
}

/** The session, as the host publishes it. */
export interface StsSessionView {
  sessionId: string;
  phase: string;
  startedAt: number;
  lastActivityAt: number;
  turns: StsTurn[];
}

/** The answer to one turn. */
export interface StsTurnResult {
  transcript: string | null;
  reply: string | null;
  audio: { contentType: string; bytes: number; base64: string } | null;
  voiceError: string | null;
  /** The turn was superseded by a newer one, so there is no answer to show. */
  interrupted: boolean;
  phase: string;
  turns: StsTurn[];
}

/** The phases the host publishes, in the order a turn passes through them. */
export const STS_PHASES = ["idle", "transcribing", "thinking", "speaking"] as const;

/**
 * What a phase means to a reader.
 *
 * Plain words: the panel says what is happening, not which enum value it is.
 */
export function phaseLabel(phase: string | null | undefined): string {
  switch (phase) {
    case "transcribing":
      return "Hearing the words";
    case "thinking":
      return "Thinking";
    case "speaking":
      return "Speaking";
    case "idle":
      return "Waiting";
    default:
      // An unknown phase is unknown, not idle. Saying "waiting" for a phase this
      // client has never heard of would be a claim it cannot make.
      return "—";
  }
}

/**
 * A duration, or the absence of one.
 *
 * `null` is a measurement that was not taken, and it renders as a dash. It is never
 * `0`: a step that never ran did not take no time, and a panel that printed `0 ms`
 * for it would be reporting a number it does not have.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The measured cost of a whole turn.
 *
 * Only the steps that finished are counted, and a turn where none of them did has
 * no total at all.
 */
export function measuredTotal(turn: StsTurn): number | null {
  const parts = [turn.sttMs, turn.brainMs, turn.ttsMs].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  if (parts.length === 0) return null;
  return parts.reduce((sum, value) => sum + value, 0);
}

/** One row of the monitor. */
export interface TurnRow {
  id: number;
  /** What the visitor said, or null when there are no words. */
  userText: string | null;
  /** What Frenchy said, or null when there are no words. */
  agentText: string | null;
  /** The measured cost of the turn as a whole. */
  totalMs: number | null;
  /** The measured cost of each step. */
  steps: { label: string; ms: number | null }[];
  /** Whether the exchange completed. */
  outcome: "ok" | "failed";
  /** Why it failed, in words. */
  reason: string | null;
  /** Whether the turn is still running. */
  running: boolean;
}

/**
 * The turns, as rows.
 *
 * One exchange is one row: what the visitor said, what Frenchy said, and what each
 * step cost. Both sides are kept, because an exchange where only one side spoke is
 * a different thing from an exchange where both did, and a row that showed one of
 * them would make the second look like the first.
 */
export function turnRows(turns: StsTurn[]): TurnRow[] {
  return turns.map((turn) => ({
    id: turn.id,
    userText: turn.userText,
    agentText: turn.agentText,
    totalMs: measuredTotal(turn),
    steps: [
      { label: "hearing", ms: turn.sttMs },
      { label: "thinking", ms: turn.brainMs },
      { label: "speaking", ms: turn.ttsMs },
    ],
    outcome: turn.outcome,
    reason: turn.reason,
    running: turn.endedAt === null,
  }));
}

/* --------------------------------------------------------------- transport ---- */

type Fetcher = typeof fetch;

/**
 * The fetch to use.
 *
 * `fetch` is called **through `globalThis`** rather than detached from it: a
 * browser's `fetch` is a method of `window`, and calling it without its receiver
 * throws `TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation`.
 * Node's `fetch` is a plain function and does not care, so no test suite finds
 * this and the browser finds it on the first render — which is why the client is
 * called through this and never as `(fetchImpl ?? fetch)(url)`.
 */
function resolveFetch(fetchImpl?: Fetcher): Fetcher {
  if (fetchImpl) return fetchImpl;
  return (input, init) => globalThis.fetch(input, init);
}

/**
 * What the host can do.
 *
 * `null` when the host could not answer, which is not the same as "not
 * configured": one is a fact about the host and the other is a fact about the
 * deployment.
 */
export async function fetchStsStatus(apiBase: string, fetchImpl?: Fetcher): Promise<StsStatus | null> {
  try {
    const res = await resolveFetch(fetchImpl)(`${apiBase}/sts/status`);
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as StsStatus | null;
    if (!body || typeof body.configured !== "boolean") return null;
    return body;
  } catch {
    return null;
  }
}

/**
 * The header the session token travels in.
 *
 * The same name the API reads. It is a header rather than a path segment because
 * **a path segment travels**: it lands in an access log, in the browser's history
 * and in a `Referer` when the page links anywhere. A credential in any of those is
 * a credential in three places it was not meant to be.
 */
export const STS_TOKEN_HEADER = "x-crucible-session";

/**
 * The conversation's credential.
 *
 * It is a bearer token: whoever holds it may read that conversation. The API holds
 * only its digest, so a memory dump of the host is not a list of conversations.
 */
export interface StsSession {
  token: string;
  /** A short public handle for the panel: not a credential. */
  ref: string;
  phase: string;
  startedAt: number;
  turns: StsTurn[];
}

/**
 * Open a conversation.
 *
 * The token is returned **once**. There is no route that hands it out again, so it
 * is kept in this tab's memory and nowhere else.
 */
export async function openStsSession(
  apiBase: string,
  options: { wallet?: string | null; fetchImpl?: Fetcher } = {},
): Promise<StsSession | null> {
  const fetchImpl = resolveFetch(options.fetchImpl);
  try {
    const res = await fetchImpl(`${apiBase}/sts/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options.wallet ? { wallet: options.wallet } : {}),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as Partial<StsSession> | null;
    if (!body || typeof body.token !== "string" || body.token.length === 0) return null;
    return {
      token: body.token,
      ref: typeof body.ref === "string" ? body.ref : "",
      phase: typeof body.phase === "string" ? body.phase : "idle",
      startedAt: typeof body.startedAt === "number" ? body.startedAt : 0,
      turns: Array.isArray(body.turns) ? body.turns : [],
    };
  } catch {
    return null;
  }
}

/** Read the session: where it is, and what has been said in it. */
export async function readStsSession(
  apiBase: string,
  token: string,
  fetchImpl?: Fetcher,
): Promise<StsSessionView | null> {
  try {
    const res = await resolveFetch(fetchImpl)(`${apiBase}/sts/session`, {
      headers: { [STS_TOKEN_HEADER]: token },
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as StsSessionView | null;
    if (!body || !Array.isArray(body.turns)) return null;
    return body;
  } catch {
    return null;
  }
}

/**
 * Send one turn.
 *
 * The audio goes up as the bytes it is, with the type it arrived as, so the host
 * can hand them to the transcription provider without guessing a format.
 *
 * `signal` supersedes a turn that is already running: the caller aborts, and the
 * host stops the work rather than finishing an answer nobody is waiting for.
 */
export async function sendStsTurn(
  apiBase: string,
  token: string,
  audio: Blob,
  options: { fetchImpl?: Fetcher; signal?: AbortSignal } = {},
): Promise<StsTurnResult | null> {
  const doFetch = resolveFetch(options.fetchImpl);
  try {
    const res = await doFetch(`${apiBase}/sts/turn`, {
      method: "POST",
      headers: {
        "content-type": audio.type || "audio/webm",
        [STS_TOKEN_HEADER]: token,
      },
      body: audio,
      signal: options.signal,
    });
    const body = (await res.json().catch(() => null)) as Partial<StsTurnResult> & {
      interrupted?: boolean;
    } | null;
    if (!body) return null;
    if (body.interrupted) {
      return {
        transcript: null,
        reply: null,
        audio: null,
        voiceError: null,
        interrupted: true,
        phase: body.phase ?? "idle",
        turns: Array.isArray(body.turns) ? body.turns : [],
      };
    }
    return {
      transcript: body.transcript ?? null,
      reply: body.reply ?? null,
      audio: body.audio ?? null,
      voiceError: body.voiceError ?? null,
      interrupted: false,
      phase: body.phase ?? "idle",
      turns: Array.isArray(body.turns) ? body.turns : [],
    };
  } catch (err) {
    // An abort is the caller superseding the turn, not a failure: the host is
    // told by the next turn, and the answer nobody wanted is not played.
    if (options.signal?.aborted) {
      return {
        transcript: null,
        reply: null,
        audio: null,
        voiceError: null,
        interrupted: true,
        phase: "idle",
        turns: [],
      };
    }
    return null;
  }
}

/**
 * The audio the host returned, as something a browser can play.
 *
 * `null` when there is no audio: a host whose voice failed still answered in
 * words, and the panel shows the words.
 */
export function audioBlob(result: StsTurnResult | null): Blob | null {
  if (!result?.audio?.base64) return null;
  try {
    const binary = atob(result.audio.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: result.audio.contentType || "audio/mpeg" });
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- recording ---- */

/**
 * A recorder.
 *
 * The browser owns the microphone; the host never sees a stream, only the bytes of
 * one utterance. `start` refuses rather than throwing when the browser will not
 * give the microphone, because "the microphone was refused" and "the recording
 * failed" are different facts and the page says them differently.
 */
export interface StsRecorder {
  start(): Promise<boolean>;
  stop(): Promise<Blob | null>;
  readonly active: boolean;
}

/**
 * Build a recorder.
 *
 * `MediaRecorder` is looked up on the global rather than imported, because it does
 * not exist in every browser and in none of the test runners: a page that reaches
 * for it unconditionally would throw on a machine that has no microphone at all.
 */
export function createStsRecorder(): StsRecorder {
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];

  async function start(): Promise<boolean> {
    const Recorder = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
    const devices = (globalThis as { navigator?: Navigator }).navigator?.mediaDevices;
    if (!Recorder || !devices) return false;

    try {
      stream = await devices.getUserMedia({ audio: true });
    } catch {
      return false;
    }

    try {
      const mime = Recorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : Recorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
      recorder = mime ? new Recorder(stream, { mimeType: mime }) : new Recorder(stream);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
      return false;
    }

    chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    recorder.start();
    return true;
  }

  async function stop(): Promise<Blob | null> {
    const active = recorder;
    recorder = null;
    if (!active) return null;

    const done = new Promise<Blob | null>((resolve) => {
      active.onstop = () => {
        const type = active.mimeType || "audio/webm";
        resolve(chunks.length > 0 ? new Blob(chunks, { type }) : null);
        chunks = [];
      };
    });
    try {
      active.stop();
    } catch {
      /* the recorder was already stopped */
    }
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    return done;
  }

  return {
    start,
    stop,
    get active() {
      return recorder !== null;
    },
  };
}
