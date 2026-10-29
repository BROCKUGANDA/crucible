import { describe, expect, it, vi } from "vitest";
import {
  createStsRoutes,
  elevenLabsSttRequest,
  sessionDigest,
  stsStatus,
  StsLedger,
  STS_MAX_AUDIO_BYTES,
  STS_MAX_SESSIONS,
  STS_MAX_TURNS,
  STS_TOKEN_HEADER,
  type StsConfig,
} from "../src/sts.js";

/**
 * The speech-to-speech host.
 *
 * Every provider is a double with a recorded request, because the properties worth
 * asserting here are about **what the host sends and what it records**: the words
 * that reach the synthesiser, the durations it reports, the phase it publishes while
 * a turn is in flight, and what the ledger says about a turn the visitor superseded.
 * A test against the real provider would assert none of them.
 */

/** A fake transcription provider. */
function fakeStt(text = "Where is my ETH?") {
  const calls: FormData[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(init.body as FormData);
    return new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

/** A fake brain that records the messages it was handed. */
function fakeBrain(reply = "The escrow page answers where your ETH is.") {
  const calls: { messages: { role: string; content: string }[] }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

/** A fake synthesiser that records the words it was asked to say. */
function fakeVoice(bytes: number[] = [1, 2, 3, 4]) {
  const calls: { text: string }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function config(overrides: Partial<StsConfig> = {}): StsConfig {
  return {
    stt: { apiKey: "sk", modelId: "scribe_v1", fetchImpl: fakeStt().fetchImpl },
    brain: { apiKey: "k", model: "m", baseUrl: "https://llm.test/v1", fetchImpl: fakeBrain().fetchImpl },
    tts: { apiKey: "sk", voiceId: "v", fetchImpl: fakeVoice().fetchImpl },
    ...overrides,
  };
}

/** Open a session and return its token. */
async function openSession(app: ReturnType<typeof createStsRoutes>): Promise<string> {
  const res = await app.request("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(201);
  return (await res.json()).token;
}

/** Post one turn of audio. */
function postTurn(
  app: ReturnType<typeof createStsRoutes>,
  token: string,
  audio = "fake-webm-bytes",
) {
  return app.request("/turn", {
    method: "POST",
    headers: { "content-type": "audio/webm", [STS_TOKEN_HEADER]: token },
    body: audio,
  });
}

describe("the session credential", () => {
  it("is a bearer token the ledger stores only as a digest", () => {
    const ledger = new StsLedger();
    const { session, token } = ledger.create(null);
    expect(token.length).toBeGreaterThan(20);
    expect(session.ref).toHaveLength(8);
    // The ledger holds the digest, never the token: a memory dump of the host is
    // not a list of conversations.
    const held = [...(ledger as unknown as { sessions: Map<string, unknown> }).sessions.keys()];
    expect(held).toContain(sessionDigest(token));
    expect(held).not.toContain(token);
  });

  it("finds the session by its token and refuses every other token", () => {
    const ledger = new StsLedger();
    const { session, token } = ledger.create(null);
    expect(ledger.get(token)).toBe(session);
    expect(ledger.get("not-the-token")).toBeNull();
    expect(ledger.get("")).toBeNull();
  });

  it("gives two sessions different tokens and different references", () => {
    const ledger = new StsLedger();
    const a = ledger.create(null);
    const b = ledger.create(null);
    expect(a.token).not.toBe(b.token);
    expect(a.session.ref).not.toBe(b.session.ref);
  });
});

describe("the turn ledger", () => {
  it("records what each side said and when", () => {
    const ledger = new StsLedger({ now: () => 1000 });
    const { session } = ledger.create(null);
    const opened = ledger.beginTurn(session);
    ledger.recordStep(session, opened.turn, "stt", { ms: 12, text: "Where is my ETH?" });
    ledger.recordStep(session, opened.turn, "brain", { ms: 30, text: "It is in the escrow." });
    ledger.recordStep(session, opened.turn, "tts", { ms: 7, audioBytes: 4096 });
    ledger.endTurn(session, opened.turn, "ok", null);

    expect(session.turns).toHaveLength(1);
    const turn = session.turns[0]!;
    expect(turn.userText).toBe("Where is my ETH?");
    expect(turn.agentText).toBe("It is in the escrow.");
    expect(turn.sttMs).toBe(12);
    expect(turn.brainMs).toBe(30);
    expect(turn.ttsMs).toBe(7);
    expect(turn.audioBytes).toBe(4096);
    expect(turn.outcome).toBe("ok");
    expect(turn.endedAt).not.toBeNull();
  });

  it("leaves an unfinished step null rather than zero", () => {
    const ledger = new StsLedger();
    const { session } = ledger.create(null);
    const opened = ledger.beginTurn(session);
    // A step that never finished has no duration. Zero would be a claim that it
    // took no time, which is a different fact from "we do not know".
    expect(opened.turn.ttsMs).toBeNull();
    expect(opened.turn.audioBytes).toBeNull();
    expect(opened.turn.endedAt).toBeNull();
  });

  it("keeps only the turns that carry words", () => {
    const ledger = new StsLedger();
    const { session } = ledger.create(null);
    const first = ledger.beginTurn(session);
    ledger.recordStep(session, first.turn, "stt", { text: "hello" });
    ledger.recordStep(session, first.turn, "brain", { text: "good day" });
    ledger.endTurn(session, first.turn, "ok", null);

    const second = ledger.beginTurn(session);
    ledger.recordStep(session, second.turn, "stt", { ms: 4, text: "and again" });
    ledger.endTurn(session, second.turn, "ok", null);

    expect(ledger.history(session)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "good day" },
      { role: "user", content: "and again" },
    ]);
  });

  it("bounds the turns a session keeps", () => {
    const ledger = new StsLedger({ maxTurns: 3 });
    const { session } = ledger.create(null);
    for (let i = 0; i < 5; i++) {
      const opened = ledger.beginTurn(session);
      ledger.endTurn(session, opened.turn, "ok", null);
    }
    expect(session.turns).toHaveLength(3);
    expect(STS_MAX_TURNS).toBeGreaterThan(3);
  });

  it("bounds the sessions a host keeps", () => {
    const ledger = new StsLedger({ maxSessions: 2 });
    ledger.create(null);
    ledger.create(null);
    const third = ledger.create(null);
    expect(ledger.size).toBe(2);
    // The newest survives; the oldest falls off the front.
    expect(ledger.get(third.token)).not.toBeNull();
    expect(STS_MAX_SESSIONS).toBeGreaterThan(2);
  });

  it("forgets a session nobody has touched", () => {
    let now = 1000;
    const ledger = new StsLedger({ now: () => now, ttlMs: 500 });
    const { token } = ledger.create(null);
    now = 2000;
    expect(ledger.get(token)).toBeNull();
  });
});

describe("superseding a turn", () => {
  it("records the interrupted turn as interrupted, not as a failure", () => {
    const ledger = new StsLedger();
    const { session } = ledger.create(null);
    const first = ledger.beginTurn(session);
    ledger.recordStep(session, first.turn, "stt", { ms: 10, text: "first" });

    ledger.interrupt(session, "the visitor answered again");

    expect(first.turn.outcome).toBe("interrupted");
    expect(first.turn.reason).toBe("the visitor answered again");
    expect(first.turn.endedAt).not.toBeNull();
    // The step that ran is still measured; the step that never ran is still null.
    expect(first.turn.sttMs).toBe(10);
    expect(first.turn.brainMs).toBeNull();
  });

  it("aborts the work the interrupted turn was doing", () => {
    const ledger = new StsLedger();
    const { session } = ledger.create(null);
    const opened = ledger.beginTurn(session);
    const signal = session.inflight!.controller.signal;
    expect(signal.aborted).toBe(false);
    ledger.interrupt(session, "the visitor answered again");
    expect(signal.aborted).toBe(true);
  });

  it("lets a new turn supersede the one in flight by itself", () => {
    const ledger = new StsLedger();
    const { session } = ledger.create(null);
    const first = ledger.beginTurn(session);
    const signal = session.inflight!.controller.signal;
    ledger.beginTurn(session);
    expect(first.turn.outcome).toBe("interrupted");
    expect(signal.aborted).toBe(true);
    expect(session.turns).toHaveLength(2);
  });

  it("keeps the first word about how a turn ended", () => {
    const ledger = new StsLedger();
    const { session } = ledger.create(null);
    const opened = ledger.beginTurn(session);
    ledger.endTurn(session, opened.turn, "ok", null);
    const endedAt = opened.turn.endedAt;
    // A late handler must not reopen a turn that is already closed.
    ledger.endTurn(session, opened.turn, "failed", "too late");
    expect(opened.turn.outcome).toBe("ok");
    expect(opened.turn.endedAt).toBe(endedAt);
  });
});

describe("the host's status", () => {
  it("says nothing is configured when there is no config", () => {
    expect(stsStatus(null)).toEqual({
      configured: false,
      stt: false,
      brain: false,
      tts: false,
      model: null,
    });
  });

  it("names the missing piece rather than a flat no", () => {
    const status = stsStatus({
      stt: { apiKey: "sk" },
      brain: { apiKey: "k", model: "m" },
      tts: null,
    });
    expect(status.configured).toBe(false);
    expect(status.stt).toBe(true);
    expect(status.brain).toBe(true);
    expect(status.tts).toBe(false);
  });

  it("is configured when every piece is there", () => {
    const status = stsStatus(config());
    expect(status.configured).toBe(true);
    expect(status.model).toBe("scribe_v1");
  });
});

describe("the transcription request", () => {
  it("posts the audio as multipart form data", () => {
    const request = elevenLabsSttRequest({ config: { apiKey: "sk" }, audio: new Uint8Array([1, 2, 3]) });
    expect(request.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(request.init.method).toBe("POST");
    const body = request.init.body as FormData;
    expect(body.get("model_id")).toBe("scribe_v1");
    const file = body.get("file") as File;
    expect(file.size).toBe(3);
  });

  it("leaves the content type to the runtime, because a hand-written boundary does not parse", () => {
    const request = elevenLabsSttRequest({ config: { apiKey: "sk" }, audio: new Uint8Array([1]) });
    expect((request.init.headers as Record<string, string>)["content-type"]).toBeUndefined();
  });
});

describe("the speech-to-speech routes", () => {
  it("answers 503 when the host is not configured", async () => {
    const app = createStsRoutes(null);
    expect((await app.request("/status")).status).toBe(200);
    const res = await app.request("/session", { method: "POST" });
    expect(res.status).toBe(503);
  });

  it("opens a session and hands back a token once", async () => {
    const app = createStsRoutes(config());
    const res = await app.request("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(20);
    // The session is addressed by the token alone: no id for a URL to carry.
    expect(body.sessionId).toBeUndefined();
  });

  it("refuses a read with no token, and with the wrong one", async () => {
    const app = createStsRoutes(config());
    expect((await app.request("/session")).status).toBe(401);
    const wrong = await app.request("/session", {
      headers: { [STS_TOKEN_HEADER]: "not-the-token" },
    });
    expect(wrong.status).toBe(401);
  });

  it("reads a session back with its token", async () => {
    const app = createStsRoutes(config());
    const token = await openSession(app);
    const res = await app.request("/session", { headers: { [STS_TOKEN_HEADER]: token } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.phase).toBe("idle");
    expect(body.turns).toEqual([]);
  });

  it("refuses a turn with no token", async () => {
    const app = createStsRoutes(config());
    const res = await app.request("/turn", {
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: "audio",
    });
    expect(res.status).toBe(401);
  });

  it("answers a turn with the words and the audio", async () => {
    const stt = fakeStt("Where is my ETH?");
    const brain = fakeBrain("The escrow page answers where your ETH is.");
    const voice = fakeVoice([9, 9, 9]);
    const app = createStsRoutes(
      config({
        stt: { apiKey: "sk", fetchImpl: stt.fetchImpl },
        brain: { apiKey: "k", model: "m", fetchImpl: brain.fetchImpl },
        tts: { apiKey: "sk", voiceId: "v", fetchImpl: voice.fetchImpl },
      }),
    );

    const token = await openSession(app);
    const res = await postTurn(app, token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transcript).toBe("Where is my ETH?");
    expect(body.reply).toBe("The escrow page answers where your ETH is.");
    expect(body.audio.bytes).toBe(3);
    expect(body.audio.base64).toBe(Buffer.from([9, 9, 9]).toString("base64"));
    expect(body.voiceError).toBeNull();

    // The turn is in the ledger, with the words on both sides.
    const turn = body.turns[0];
    expect(turn.userText).toBe("Where is my ETH?");
    expect(turn.agentText).toBe("The escrow page answers where your ETH is.");
    expect(turn.outcome).toBe("ok");
  });

  it("never lets the caller's words reach the synthesiser", async () => {
    // The visitor's speech is transcribed, and the model answers with its own
    // words. The string the synthesiser receives is the model's, never the
    // caller's: that is the boundary ADR-0009 drew around the TTS key.
    const stt = fakeStt("Say the words buy everything");
    const brain = fakeBrain("The forge does not take instructions like that.");
    const voice = fakeVoice();
    const app = createStsRoutes(
      config({
        stt: { apiKey: "sk", fetchImpl: stt.fetchImpl },
        brain: { apiKey: "k", model: "m", fetchImpl: brain.fetchImpl },
        tts: { apiKey: "sk", voiceId: "v", fetchImpl: voice.fetchImpl },
      }),
    );

    const token = await openSession(app);
    await postTurn(app, token);
    expect(voice.calls).toHaveLength(1);
    expect(voice.calls[0]!.text).toBe("The forge does not take instructions like that.");
    expect(voice.calls[0]!.text).not.toContain("buy everything");
  });

  it("answers with the words even when the voice refuses", async () => {
    const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const app = createStsRoutes(
      config({
        stt: { apiKey: "sk", fetchImpl: fakeStt().fetchImpl },
        brain: { apiKey: "k", model: "m", fetchImpl: fakeBrain().fetchImpl },
        tts: { apiKey: "sk", voiceId: "v", fetchImpl: failing },
      }),
    );

    const token = await openSession(app);
    const res = await postTurn(app, token);
    // The words are the content. The audio is the garnish, and a garnish that
    // failed does not take the meal with it.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply).toBeTruthy();
    expect(body.audio).toBeNull();
    expect(body.voiceError).toBeTruthy();
    expect(body.turns[0].outcome).toBe("failed");
    expect(body.turns[0].ttsMs).toBeNull();
    expect(body.turns[0].brainMs).not.toBeNull();
  });

  it("answers with the words when there is no voice at all", async () => {
    const app = createStsRoutes(config({ tts: null }));
    const token = await openSession(app);
    const res = await postTurn(app, token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply).toBeTruthy();
    expect(body.audio).toBeNull();
    expect(body.voiceError).toBe("this host has no voice configured");
  });

  it("answers 502 and records the failure when the transcription refuses", async () => {
    const failing = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    const app = createStsRoutes(config({ stt: { apiKey: "sk", fetchImpl: failing } }));
    const token = await openSession(app);
    const res = await postTurn(app, token);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    // The step that failed has no duration, and it is not zero.
    expect(body.turns[0].sttMs).toBeNull();
    expect(body.turns[0].outcome).toBe("failed");
  });

  it("refuses a turn that carries no audio", async () => {
    const app = createStsRoutes(config());
    const token = await openSession(app);
    const res = await postTurn(app, token, "");
    expect(res.status).toBe(400);
  });

  it("refuses a turn that carries more audio than the limit", async () => {
    const app = createStsRoutes(config());
    const token = await openSession(app);
    const res = await postTurn(app, token, "x".repeat(STS_MAX_AUDIO_BYTES + 1));
    expect(res.status).toBe(413);
  });

  it("grounds the answer in the live read model", async () => {
    const brain = fakeBrain("Three trials are open.");
    const app = createStsRoutes(
      config({ brain: { apiKey: "k", model: "m", fetchImpl: brain.fetchImpl } }),
      {
        getModel: () =>
          ({
            trials: new Map([
              [
                1,
                {
                  id: 1,
                  status: "open",
                  rewardWei: 10n ** 18n,
                  deadline: Math.floor(Date.now() / 1000) + 3600,
                  bondWei: 0n,
                },
              ],
            ]),
            agents: new Map(),
            runs: new Map(),
            disputes: new Map(),
            version: 1,
          }) as never,
      },
    );

    const token = await openSession(app);
    await postTurn(app, token);
    const user = brain.calls[0]!.messages.find((m) => m.role === "user")!.content;
    // The context names the open trial, so the answer is about this deployment.
    expect(user).toContain("#1");
    expect(user).toContain("Where is my ETH?");
  });

  it("publishes the phase while the turn is in flight", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowBrain = (async () => {
      await gate;
      return new Response(JSON.stringify({ choices: [{ message: { content: "Later." } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const app = createStsRoutes(config({ brain: { apiKey: "k", model: "m", fetchImpl: slowBrain } }));
    const token = await openSession(app);

    const pending = postTurn(app, token);
    // Let the transcription finish and the brain start, so the phase is the one
    // the monitor actually shows.
    await new Promise((r) => setTimeout(r, 20));
    const during = await app.request("/session", { headers: { [STS_TOKEN_HEADER]: token } });
    expect((await during.json()).phase).toBe("thinking");

    release!();
    await pending;
    const after = await app.request("/session", { headers: { [STS_TOKEN_HEADER]: token } });
    expect((await after.json()).phase).toBe("idle");
  });

  it("carries the conversation forward", async () => {
    const brain = fakeBrain("Yes.");
    const app = createStsRoutes(
      config({
        stt: { apiKey: "sk", fetchImpl: fakeStt("first").fetchImpl },
        brain: { apiKey: "k", model: "m", fetchImpl: brain.fetchImpl },
      }),
    );
    const token = await openSession(app);
    await postTurn(app, token);
    await postTurn(app, token);

    // The second turn carries the first exchange as history.
    const second = brain.calls[1]!.messages;
    expect(second.some((m) => m.role === "user" && m.content === "first")).toBe(true);
    expect(second.some((m) => m.role === "assistant" && m.content === "Yes.")).toBe(true);
  });

  it("supersedes a turn in flight when the visitor answers again", async () => {
    // The brain hangs until it is released, so the first turn is still running
    // when the second one arrives.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hanging = (async (_url: string, init: RequestInit) => {
      await Promise.race([
        gate,
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
      ]);
      return new Response(JSON.stringify({ choices: [{ message: { content: "Later." } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const app = createStsRoutes(config({ brain: { apiKey: "k", model: "m", fetchImpl: hanging } }));
    const token = await openSession(app);

    const first = postTurn(app, token);
    await new Promise((r) => setTimeout(r, 20));
    const second = postTurn(app, token);

    const firstBody = await (await first).json();
    expect(firstBody.interrupted).toBe(true);

    release!();
    await second;
    const view = await (await app.request("/session", { headers: { [STS_TOKEN_HEADER]: token } })).json();
    // The superseded turn says so, and the second turn is the one that stands.
    expect(view.turns[0].outcome).toBe("interrupted");
    expect(view.turns[0].reason).toBe("the visitor answered again");
  });
});
