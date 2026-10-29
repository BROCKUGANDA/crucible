import { describe, expect, it, vi } from "vitest";
import {
  audioBlob,
  fetchStsStatus,
  formatDuration,
  measuredTotal,
  openStsSession,
  phaseLabel,
  readStsSession,
  sendStsTurn,
  turnRows,
  type StsTurn,
} from "@/lib/sts";

/**
 * The speech-to-speech client.
 *
 * The properties worth holding here are the ones a reader would catch: an unknown
 * duration renders as a dash and never as a zero, a host that cannot answer is
 * distinguished from a host with nothing to say, and the words that come back are
 * read without a renderer being involved.
 */

function turn(overrides: Partial<StsTurn> = {}): StsTurn {
  return {
    id: 1,
    userText: "Where is my ETH?",
    agentText: "In the escrow.",
    startedAt: 1000,
    endedAt: 2000,
    sttMs: 100,
    brainMs: 200,
    ttsMs: 300,
    audioBytes: 4096,
    outcome: "ok",
    reason: null,
    ...overrides,
  };
}

describe("the display rules", () => {
  it("renders an unknown duration as a dash, never as zero", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
  });

  it("renders a measured duration in the unit a reader expects", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(412)).toBe("412 ms");
    expect(formatDuration(1500)).toBe("1.5 s");
  });

  it("has no total when no step finished", () => {
    expect(measuredTotal(turn({ sttMs: null, brainMs: null, ttsMs: null }))).toBeNull();
  });

  it("adds up only the steps that finished", () => {
    expect(measuredTotal(turn({ ttsMs: null }))).toBe(300);
    expect(measuredTotal(turn())).toBe(600);
  });

  it("names a phase in plain words and says nothing about an unknown one", () => {
    expect(phaseLabel("thinking")).toBe("Thinking");
    expect(phaseLabel("idle")).toBe("Waiting");
    expect(phaseLabel("something-new")).toBe("—");
    expect(phaseLabel(null)).toBe("—");
  });
});

describe("the turn rows", () => {
  it("keeps both sides of an exchange", () => {
    const rows = turnRows([turn()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userText).toBe("Where is my ETH?");
    expect(rows[0]!.agentText).toBe("In the escrow.");
  });

  it("marks a turn that has not finished as still running", () => {
    const rows = turnRows([turn({ endedAt: null, brainMs: null, ttsMs: null })]);
    expect(rows[0]!.running).toBe(true);
    expect(rows[0]!.totalMs).toBe(100);
  });

  it("carries the failure through", () => {
    const rows = turnRows([turn({ outcome: "failed", reason: "the voice failed" })]);
    expect(rows[0]!.outcome).toBe("failed");
    expect(rows[0]!.reason).toBe("the voice failed");
  });

  it("leaves the words empty rather than inventing them", () => {
    const rows = turnRows([turn({ userText: null, agentText: null })]);
    expect(rows[0]!.userText).toBeNull();
    expect(rows[0]!.agentText).toBeNull();
  });
});

describe("the browser's fetch", () => {
  it("is called with its receiver, because a detached fetch is an illegal invocation", async () => {
    // A browser's `fetch` is a method of `window` and throws
    // `TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation`
    // when it is called without its receiver. Node's `fetch` is a plain function
    // and does not care, so every test in this file passes against the broken
    // form and only a browser finds it — which is exactly what happened the
    // first time this page was opened in one.
    //
    // The stand-in below refuses to answer unless `this` is the global object,
    // which is what a browser's own fetch requires.
    const original = globalThis.fetch;
    let receiver: unknown = null;
    globalThis.fetch = function (this: unknown) {
      receiver = this;
      return Promise.resolve(
        new Response(JSON.stringify({ configured: false, stt: false, brain: false, tts: false, model: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    } as unknown as typeof fetch;
    try {
      const status = await fetchStsStatus("http://api.test");
      expect(status).not.toBeNull();
      expect(receiver).toBe(globalThis);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("the host conversation", () => {
  it("reports what the host can do", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ configured: true, stt: true, brain: true, tts: true, model: "scribe_v1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const status = await fetchStsStatus("http://api.test", fetchImpl);
    expect(status?.configured).toBe(true);
    expect(status?.model).toBe("scribe_v1");
  });

  it("cannot tell a host that cannot answer from a host with nothing to say", async () => {
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await fetchStsStatus("http://api.test", failing)).toBeNull();

    const refusing = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchStsStatus("http://api.test", refusing)).toBeNull();
  });

  it("opens a session and returns the host's id", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ sessionId: "abc" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    expect(await openStsSession("http://api.test", { fetchImpl })).toBe("abc");
  });

  it("returns null when the host will not open a session", async () => {
    const refusing = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    expect(await openStsSession("http://api.test", { fetchImpl: refusing })).toBeNull();
  });

  it("reads a session back", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ sessionId: "abc", phase: "thinking", turns: [turn()] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const view = await readStsSession("http://api.test", "abc", fetchImpl);
    expect(view?.phase).toBe("thinking");
    expect(view?.turns).toHaveLength(1);
  });

  it("returns null when the session cannot be read", async () => {
    const refusing = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    expect(await readStsSession("http://api.test", "abc", refusing)).toBeNull();
  });

  it("sends the audio with the type it arrived as", async () => {
    let seen: { type: string; body: unknown } | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen = { type: (init.headers as Record<string, string>)["content-type"]!, body: init.body };
      return new Response(
        JSON.stringify({
          transcript: "hello",
          reply: "good day",
          audio: { contentType: "audio/mpeg", bytes: 2, base64: "AQI=" },
          voiceError: null,
          phase: "idle",
          turns: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
    const result = await sendStsTurn("http://api.test", "abc", blob, fetchImpl);
    expect(result?.reply).toBe("good day");
    expect(seen!.type).toBe("audio/webm");
    expect(seen!.body).toBe(blob);
  });

  it("keeps the voice failure in the answer instead of swallowing it", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          transcript: "hello",
          reply: "good day",
          audio: null,
          voiceError: "the voice failed",
          phase: "idle",
          turns: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const result = await sendStsTurn("http://api.test", "abc", new Blob(), fetchImpl);
    expect(result?.voiceError).toBe("the voice failed");
    expect(result?.reply).toBe("good day");
    expect(audioBlob(result)).toBeNull();
  });

  it("turns the returned audio into something a browser can play", () => {
    const blob = audioBlob({
      transcript: null,
      reply: null,
      audio: { contentType: "audio/mpeg", bytes: 2, base64: "AQI=" },
      voiceError: null,
      phase: "idle",
      turns: [],
    });
    expect(blob?.type).toBe("audio/mpeg");
    expect(blob?.size).toBe(2);
  });
});
