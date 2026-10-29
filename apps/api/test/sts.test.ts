import { describe, expect, it, vi } from "vitest";
import {
  createStsRoutes,
  elevenLabsSttRequest,
  stsStatus,
  StsLedger,
  STS_MAX_AUDIO_BYTES,
  STS_MAX_SESSIONS,
  STS_MAX_TURNS,
  type StsConfig,
} from "../src/sts.js";

/**
 * The speech-to-speech host.
 *
 * Every provider is a double with a recorded request, because the properties worth
 * asserting here are about **what the host sends and what it records**: the words
 * that reach the synthesiser, the durations it reports, and the phase it publishes
 * while a turn is in flight. A test against the real provider would assert none of
 * them.
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

/** Open a session and return its id. */
async function openSession(app: ReturnType<typeof createStsRoutes>): Promise<string> {
  const res = await app.request("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(201);
  return (await res.json()).sessionId;
}

/** Post one turn of audio. */
function postTurn(app: ReturnType<typeof createStsRoutes>, id: string, audio = "fake-webm-bytes") {
  return app.request(`/session/${id}/turn`, {
    method: "POST",
    headers: { "content-type": "audio/webm" },
    body: audio,
  });
}

describe("the turn ledger", () => {
  it("records what each side said and when", () => {
    const ledger = new StsLedger({ now: () => 1000 });
    const session = ledger.create(null);
    const opened = ledger.beginTurn(session.id)!;
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
    const session = ledger.create(null);
    const opened = ledger.beginTurn(session.id)!;
    // A step that never finished has no duration. Zero would be a claim that it
    // took no time, which is a different fact from "we do not know".
    expect(opened.turn.ttsMs).toBeNull();
    expect(opened.turn.audioBytes).toBeNull();
    expect(opened.turn.endedAt).toBeNull();
  });

  it("keeps only the turns that carry words", () => {
    const ledger = new StsLedger();
    const session = ledger.create(null);
    const first = ledger.beginTurn(session.id)!;
    ledger.recordStep(session, first.turn, "stt", { text: "hello" });
    ledger.recordStep(session, first.turn, "brain", { text: "good day" });
    ledger.endTurn(session, first.turn, "ok", null);

    const second = ledger.beginTurn(session.id)!;
    ledger.recordStep(session, second.turn, "stt", { ms: 4, text: "and again" });
    ledger.endTurn(session, second.turn, "ok", null);

    const history = ledger.history(session);
    expect(history).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "good day" },
      { role: "user", content: "and again" },
    ]);
  });

  it("bounds the turns a session keeps", () => {
    const ledger = new StsLedger({ maxTurns: 3 });
    const session = ledger.create(null);
    for (let i = 0; i < 5; i++) {
      const opened = ledger.beginTurn(session.id)!;
      ledger.endTurn(session, opened.turn, "ok", null);
    }
    expect(session.turns).toHaveLength(3);
    expect(STS_MAX_TURNS).toBeGreaterThan(3);
  });

  it("bounds the sessions a host keeps", () => {
    const ledger = new StsLedger({ maxSessions: 2 });
    ledger.create(null);
    ledger.create(null);
    ledger.create(null);
    expect(ledger.size).toBe(2);
    expect(STS_MAX_SESSIONS).toBeGreaterThan(2);
  });

  it("forgets a session nobody has touched", () => {
    let now = 1000;
    const ledger = new StsLedger({ now: () => now, ttlMs: 500 });
    const session = ledger.create(null);
    now = 2000;
    expect(ledger.get(session.id)).toBeNull();
  });

  it("keeps the newest sessions when the cap is reached", () => {
    const ledger = new StsLedger({ maxSessions: 2 });
    const first = ledger.create(null);
    const second = ledger.create(null);
    const third = ledger.create(null);
    expect(ledger.get(first.id)).toBeNull();
    expect(ledger.get(second.id)).not.toBeNull();
    expect(ledger.get(third.id)).not.toBeNull();
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
  it("posts the audio as multipart form data", async () => {
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

  it("opens a session and reads it back", async () => {
    const app = createStsRoutes(config());
    const id = await openSession(app);
    const res = await app.request(`/session/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe(id);
    expect(body.phase).toBe("idle");
    expect(body.turns).toEqual([]);
  });

  it("refuses an unknown session", async () => {
    const app = createStsRoutes(config());
    expect((await app.request("/session/does-not-exist")).status).toBe(404);
    expect((await postTurn(app, "does-not-exist")).status).toBe(404);
  });

  it("answers a turn with the words and the audio", async () => {
    const stt = fakeStt("Where is my ETH?");
    const brain = fakeBrain("It is in the escrow.");
    const voice = fakeVoice([9, 9, 9]);
    const app = createStsRoutes(
      config({
        stt: { apiKey: "sk", fetchImpl: stt.fetchImpl },
        brain: { apiKey: "k", model: "m", fetchImpl: brain.fetchImpl },
        tts: { apiKey: "sk", voiceId: "v", fetchImpl: voice.fetchImpl },
      }),
    );

    const id = await openSession(app);
    const res = await postTurn(app, id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transcript).toBe("Where is my ETH?");
    expect(body.reply).toBe("It is in the escrow.");
    expect(body.audio.bytes).toBe(3);
    expect(body.audio.base64).toBe(Buffer.from([9, 9, 9]).toString("base64"));
    expect(body.voiceError).toBeNull();

    // The turn is in the ledger, with the words on both sides.
    const turn = body.turns[0];
    expect(turn.userText).toBe("Where is my ETH?");
    expect(turn.agentText).toBe("It is in the escrow.");
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

    const id = await openSession(app);
    await postTurn(app, id);
    expect(voice.calls).toHaveLength(1);
    expect(voice.calls[0]!.text).toBe("The forge does not take instructions like that.");
    expect(voice.calls[0]!.text).not.toContain("buy everything");
  });

  it("answers with the words even when the voice refuses", async () => {
    const brain = fakeBrain("It is in the escrow.");
    const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const app = createStsRoutes(
      config({
        stt: { apiKey: "sk", fetchImpl: fakeStt().fetchImpl },
        brain: { apiKey: "k", model: "m", fetchImpl: brain.fetchImpl },
        tts: { apiKey: "sk", voiceId: "v", fetchImpl: failing },
      }),
    );

    const id = await openSession(app);
    const res = await postTurn(app, id);
    // The words are the content. The audio is the garnish, and a garnish that
    // failed does not take the meal with it.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply).toBe("It is in the escrow.");
    expect(body.audio).toBeNull();
    expect(body.voiceError).toBeTruthy();
    expect(body.turns[0].outcome).toBe("failed");
    expect(body.turns[0].ttsMs).toBeNull();
    expect(body.turns[0].brainMs).not.toBeNull();
  });

  it("answers with the words when there is no voice at all", async () => {
    const app = createStsRoutes(config({ tts: null }));
    const id = await openSession(app);
    const res = await postTurn(app, id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply).toBeTruthy();
    expect(body.audio).toBeNull();
    expect(body.voiceError).toBe("this host has no voice configured");
  });

  it("answers 502 and records the failure when the transcription refuses", async () => {
    const failing = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    const app = createStsRoutes(config({ stt: { apiKey: "sk", fetchImpl: failing } }));
    const id = await openSession(app);
    const res = await postTurn(app, id);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    // The step that failed has no duration, and it is not zero.
    expect(body.turns[0].sttMs).toBeNull();
    expect(body.turns[0].outcome).toBe("failed");
  });

  it("answers 502 when the brain refuses", async () => {
    const failing = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const app = createStsRoutes(config({ brain: { apiKey: "k", model: "m", fetchImpl: failing } }));
    const id = await openSession(app);
    const res = await postTurn(app, id);
    expect(res.status).toBe(502);
    expect((await res.json()).turns[0].brainMs).toBeNull();
  });

  it("refuses a turn that carries no audio", async () => {
    const app = createStsRoutes(config());
    const id = await openSession(app);
    const res = await postTurn(app, id, "");
    expect(res.status).toBe(400);
  });

  it("refuses a turn that carries more audio than the limit", async () => {
    const app = createStsRoutes(config());
    const id = await openSession(app);
    const res = await postTurn(app, id, "x".repeat(STS_MAX_AUDIO_BYTES + 1));
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

    const id = await openSession(app);
    await postTurn(app, id);
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
    const id = await openSession(app);

    const pending = postTurn(app, id);
    // Let the transcription finish and the brain start, so the phase is the one
    // the monitor actually shows.
    await new Promise((r) => setTimeout(r, 20));
    const during = await app.request(`/session/${id}`);
    expect((await during.json()).phase).toBe("thinking");

    release!();
    await pending;
    const after = await app.request(`/session/${id}`);
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
    const id = await openSession(app);
    await postTurn(app, id);
    await postTurn(app, id);

    // The second turn carries the first exchange as history.
    const second = brain.calls[1]!.messages;
    expect(second.some((m) => m.role === "user" && m.content === "first")).toBe(true);
    expect(second.some((m) => m.role === "assistant" && m.content === "Yes.")).toBe(true);
  });
});
