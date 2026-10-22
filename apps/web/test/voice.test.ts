import { describe, expect, it } from "vitest";
import {
  fetchVoiceClip,
  localDay,
  markCatchphrase,
  markSpoken,
  readVoicePrefs,
  shouldSpeak,
  verdictMoment,
  writeVoiceEnabled,
  VOICE_CATCHPHRASE_KEY,
  VOICE_DAY_KEY,
  VOICE_ENABLED_KEY,
} from "../src/lib/voice.js";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (i) => [...values.keys()][i] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  } as Storage;
}

describe("Frenchy's policy", () => {
  it("is off until the user turns it on", () => {
    const storage = memoryStorage();
    expect(readVoicePrefs(storage)).toEqual({
      enabled: false,
      lastDay: null,
      catchphraseUsed: false,
    });
    expect(
      shouldSpeak({
        enabled: false,
        reducedMotion: false,
        lastDay: null,
        today: "2026-10-21",
      }),
    ).toBe(false);
  });

  it("speaks once a day, and not when reduced motion is requested", () => {
    const base = { enabled: true, reducedMotion: false, today: "2026-10-21" };
    expect(shouldSpeak({ ...base, lastDay: null })).toBe(true);
    expect(shouldSpeak({ ...base, lastDay: "2026-10-20" })).toBe(true);
    expect(shouldSpeak({ ...base, lastDay: "2026-10-21" })).toBe(false);
    expect(shouldSpeak({ ...base, reducedMotion: true, lastDay: null })).toBe(false);
  });

  it("lets a manual click through even after the daily line", () => {
    expect(
      shouldSpeak({
        enabled: true,
        reducedMotion: true,
        lastDay: "2026-10-21",
        today: "2026-10-21",
        manual: true,
      }),
    ).toBe(true);
    // …but never when the host is off.
    expect(
      shouldSpeak({
        enabled: false,
        reducedMotion: false,
        lastDay: null,
        today: "2026-10-21",
        manual: true,
      }),
    ).toBe(false);
  });

  it("uses the catchphrase once per session", () => {
    expect(verdictMoment(false)).toBe("verdict");
    expect(verdictMoment(true)).toBe("verdict-repeat");
  });

  it("reads and writes the persisted prefs", () => {
    const storage = memoryStorage();
    writeVoiceEnabled(storage, true);
    expect(storage.getItem(VOICE_ENABLED_KEY)).toBe("1");
    markSpoken(storage, "2026-10-21");
    expect(storage.getItem(VOICE_DAY_KEY)).toBe("2026-10-21");
    markCatchphrase(storage);
    expect(storage.getItem(VOICE_CATCHPHRASE_KEY)).toBe("1");
    expect(readVoicePrefs(storage)).toEqual({
      enabled: true,
      lastDay: "2026-10-21",
      catchphraseUsed: true,
    });
    writeVoiceEnabled(storage, false);
    expect(readVoicePrefs(storage).enabled).toBe(false);
  });

  it("formats the user's local day, not UTC", () => {
    expect(localDay(new Date(2026, 9, 21, 23, 59))).toBe("2026-10-21");
    expect(localDay(new Date(2026, 0, 2, 0, 1))).toBe("2026-01-02");
  });
});

/**
 * A clip request that cannot be answered has to say which kind of failure it is. The first
 * version returned `null` for all of them, so a dead server, a rate limit, an empty body and
 * a browser that refused to load the resulting blob were one indistinguishable silence.
 */
describe("the clip fetch", () => {
  const original = globalThis.fetch;

  async function withFetch(impl: typeof fetch, run: () => Promise<void>) {
    globalThis.fetch = impl;
    try {
      await run();
    } finally {
      globalThis.fetch = original;
    }
  }

  it("names an unreachable server, a refused status and an empty body separately", async () => {
    await withFetch(
      (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      async () => {
        expect(await fetchVoiceClip("tour")).toEqual({
          ok: false,
          reason: "the voice server could not be reached",
        });
      },
    );

    await withFetch(
      (async () => new Response("{}", { status: 429 })) as typeof fetch,
      async () => {
        expect(await fetchVoiceClip("tour")).toEqual({ ok: false, reason: "the voice server answered 429" });
      },
    );

    await withFetch(
      (async () => new Response("", { status: 200 })) as typeof fetch,
      async () => {
        expect(await fetchVoiceClip("tour")).toEqual({ ok: false, reason: "the clip arrived empty" });
      },
    );
  });

  it("hands back the bytes when the server answers", async () => {
    await withFetch(
      (async () => new Response(new Blob(["\u0000\u0001\u0002"], { type: "audio/mpeg" }))) as typeof fetch,
      async () => {
        const clip = await fetchVoiceClip("tour");
        expect(clip.ok).toBe(true);
        if (clip.ok) expect(clip.blob.type).toBe("audio/mpeg");
      },
    );
  });
});

/**
 * The latency fix, and the dedupe, are the same mechanism: one request per line.
 *
 * Frenchy's copy is fixed, so a second turn used to pay a second round trip and a second
 * synthesis for bytes this tab already had. These tests hold both halves — repeats come
 * from memory, and simultaneous asks share one request — without which the host is
 * audibly slow and can start twice.
 */
describe("the clip cache", () => {
  const original = globalThis.fetch;

  async function withFetch(impl: typeof fetch, run: () => Promise<void>) {
    globalThis.fetch = impl;
    try {
      await run();
    } finally {
      globalThis.fetch = original;
    }
  }

  const okResponse = () => new Response("audio-bytes", { status: 200 });

  it("fetches a fixed line once and answers a repeat from memory", async () => {
    let calls = 0;
    await withFetch(
      (async () => {
        calls += 1;
        return okResponse();
      }) as typeof fetch,
      async () => {
        const first = await fetchVoiceClip("greeting");
        const second = await fetchVoiceClip("greeting");
        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        expect(calls, "the second turn re-synthesised a line the tab already had").toBe(1);
        if (first.ok && second.ok) expect(second.blob).toBe(first.blob);
      },
    );
  });

  it("collapses simultaneous asks into one request", async () => {
    let calls = 0;
    await withFetch(
      (async () => {
        calls += 1;
        // A turn is not instantaneous, which is exactly the window two callers overlap in:
        // the toggle, the return-visit effect and a page announcement can all fire in one tick.
        await new Promise((r) => setTimeout(r, 30));
        return okResponse();
      }) as typeof fetch,
      async () => {
        const [a, b, c] = await Promise.all([
          fetchVoiceClip("verdict"),
          fetchVoiceClip("verdict"),
          fetchVoiceClip("verdict"),
        ]);
        expect(calls, "three callers opened three requests").toBe(1);
        expect(a.ok && b.ok && c.ok).toBe(true);
      },
    );
  });

  it("does not remember a failure", async () => {
    let calls = 0;
    await withFetch(
      (async () => {
        calls += 1;
        return new Response("{}", { status: 503 });
      }) as typeof fetch,
      async () => {
        expect((await fetchVoiceClip("spec", "the retry line")).ok).toBe(false);
        expect((await fetchVoiceClip("spec", "the retry line")).ok).toBe(false);
        expect(calls, "a dead provider was cached as the answer forever").toBe(2);
      },
    );
  });

  it("keys caller text separately, because the spec line is not fixed copy", async () => {
    let calls = 0;
    await withFetch(
      (async () => {
        calls += 1;
        return okResponse();
      }) as typeof fetch,
      async () => {
        await fetchVoiceClip("spec", "first spec");
        await fetchVoiceClip("spec", "second spec");
        expect(calls).toBe(2);
      },
    );
  });
});
