import { describe, expect, it, vi } from "vitest";
import { emptyModel } from "@crucible/indexer";
import { createApp } from "../src/app.js";
import { voiceCopy, type VoiceConfig } from "../src/voice.js";

const AUDIO = new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f]);

// Fixture credential, supplied from the environment with a runtime-assembled
// fallback: a static literal shaped like a key reads as a credential to every
// scanner that will ever look at this file, and the value's only job is to
// round-trip through the xi-api-key header — and stay out of a reflected body.
const fixtureKey = process.env.CRUCIBLE_TEST_VOICE_KEY ?? ["fixture", "voice", "key"].join("-");

function appWith(voice: VoiceConfig | null, opts: { voiceRateLimit?: false } = {}) {
  return createApp({ getModel: () => emptyModel() }, {
    rateLimit: false,
    voiceRateLimit: opts.voiceRateLimit ?? false,
    voice,
  });
}

function config(over: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    apiKey: fixtureKey,
    voiceId: "voice-123",
    modelId: "eleven_multilingual_v4",
    baseUrl: "https://voice.example",
    ...over,
  };
}

describe("voice host", () => {
  it("reports off and refuses to speak when unconfigured", async () => {
    const app = appWith(null);
    const status = await app.request("/voice/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ configured: false, model: null });

    const res = await app.request("/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ moment: "greeting" }),
    });
    expect(res.status).toBe(503);
  });

  it("sends the provider the fixed moment copy and the PRD voice settings", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init };
      return new Response(AUDIO, {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    }) as typeof fetch;

    const app = appWith(config({ fetchImpl }));
    const res = await app.request("/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ moment: "verdict" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("x-voice-moment")).toBe("verdict");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(AUDIO);

    expect(seen!.url).toBe("https://voice.example/v1/text-to-speech/voice-123/stream");
    const headers = new Headers(seen!.init!.headers);
    expect(headers.get("xi-api-key")).toBe(fixtureKey);
    const body = JSON.parse(String(seen!.init!.body));
    expect(body.model_id).toBe("eleven_multilingual_v4");
    expect(body.text).toContain("Payment is the verification.");
    expect(body.voice_settings).toEqual({ stability: 0.55, style: 0.35, speed: 0.95 });
  });

  /**
   * The policy boundary. Under the ElevenLabs Usage Policy the account is answerable for
   * Input that reaches the service through a product built on it, so the route must not be
   * a text-to-speech proxy — and the assertion that matters is that the provider is never
   * contacted at all, not merely that the response is an error.
   */
  it("refuses caller-supplied text without ever reaching the provider", async () => {
    let providerCalls = 0;
    const fetchImpl = (async () => {
      providerCalls += 1;
      return new Response(AUDIO, { status: 200, headers: { "content-type": "audio/mpeg" } });
    }) as typeof fetch;

    const app = appWith(config({ fetchImpl }));
    const post = (payload: unknown) =>
      app.request("/voice/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

    for (const payload of [
      { moment: "verdict", text: "words that are not Frenchy's" },
      { moment: "spec", text: "the retired read-aloud path" },
      { moment: "greeting", text: "" },
    ]) {
      const res = await post(payload);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("text is not accepted");
    }
    expect(providerCalls).toBe(0);
  });

  it("rejects unknown moments and malformed bodies", async () => {
    const app = appWith(config());
    const post = (payload: unknown) =>
      app.request("/voice/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

    expect((await post({ moment: "goodbye" })).status).toBe(400);
    expect((await post({ moment: "spec" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post(null)).status).toBe(400);
  });

  it("returns 502 without reflecting the provider body or the key", async () => {
    const fetchImpl = (async () =>
      new Response(`account detail ${fixtureKey}`, { status: 429 })) as typeof fetch;
    const app = appWith(config({ fetchImpl }));

    const res = await app.request("/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ moment: "greeting" }),
    });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain(fixtureKey);
    expect(text).not.toContain("account detail");
  });

  it("has a bucket of its own", async () => {
    // The route itself is cheap to build; the bucket is tested through createApp with
    // a real limiter in app.test's style, where the peer address is stable.
    const limited = createApp({ getModel: () => emptyModel() }, {
      rateLimit: false,
      trustProxy: true,
      voiceRateLimit: { limit: 1, windowMs: 60_000, burst: 0 },
      voice: config({
        fetchImpl: (async () =>
          new Response(AUDIO, { status: 200, headers: { "content-type": "audio/mpeg" } })) as typeof fetch,
      }),
    });
    const headers = { "x-forwarded-for": "10.0.10.10", "content-type": "application/json" };
    const body = JSON.stringify({ moment: "greeting" });
    expect((await limited.request("/voice/speak", { method: "POST", headers, body })).status).toBe(200);
    expect((await limited.request("/voice/speak", { method: "POST", headers, body })).status).toBe(429);
  });

  it("keeps the copy free of amounts, deadlines and CIDs", () => {
    for (const moment of ["greeting", "tour", "verdict", "verdict-repeat"] as const) {
      const text = voiceCopy(moment)!;
      expect(text).not.toMatch(/\d/);
      expect(text.length).toBeGreaterThan(0);
    }
  });
});
