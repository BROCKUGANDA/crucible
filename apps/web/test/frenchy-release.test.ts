import { describe, expect, it } from "vitest";
import {
  cancelUtterance,
  teardownFrenchy,
  type TeardownReport,
} from "../src/lib/frenchy/teardown.js";
import { fetchFrenchyBrainStatus } from "../src/lib/frenchy/status.js";
import { API_BASE } from "../src/lib/apiBase.js";

/**
 * Frenchy's release paths, asserted as end states.
 *
 * The rule this file is written against is the one the repo learned the hard way: a cancel test
 * that only shows the caller stopped waiting is a test of the caller, not of the cancel. So
 * every assertion below is about the resource after the call — was `track.stop()` reached, is
 * the controller aborted, is the ref empty — and the fakes record exactly that. Nothing here
 * awaits a promise to prove a microphone went off.
 *
 * The provider is not rendered (there is no renderer in this suite); `frenchy-wiring.test.ts`
 * holds the claim that the provider actually calls these, and holds it against the code rather
 * than the comments.
 */

interface FakeTrack {
  stopped: boolean;
  stop(): void;
}

function fakes() {
  const trackA: FakeTrack = { stopped: false, stop() { this.stopped = true; } };
  const trackB: FakeTrack = { stopped: false, stop() { this.stopped = true; } };
  const synthesis = { cancelled: false, cancel() { this.cancelled = true; } };
  const controller = {
    aborted: false,
    signal: { aborted: false },
    abort() {
      this.aborted = true;
      this.signal.aborted = true;
    },
  };
  const recognition = { stopped: false, stop() { this.stopped = true; } };
  const audio = { paused: false, pause() { this.paused = true; } };

  return {
    tracks: { current: [trackA, trackB] as FakeTrack[] },
    synthesis,
    controller,
    recognition,
    audio: { current: audio as { pause(): void } | null },
    parts: { trackA, trackB, synthesis, controller, recognition, audio },
  };
}

describe("the unmount teardown", () => {
  it("releases every resource and reports the order it released them in", () => {
    const r = fakes();
    const report: TeardownReport = teardownFrenchy(r);

    expect(report.steps).toEqual(["tracks", "synthesis", "fetch", "recognition", "audio"]);
    expect(report.failures).toEqual([]);

    // The end state, not the intent.
    expect(r.parts.trackA.stopped).toBe(true);
    expect(r.parts.trackB.stopped).toBe(true);
    expect(r.tracks.current).toEqual([]);
    expect(r.parts.synthesis.cancelled).toBe(true);
    expect(r.parts.controller.aborted).toBe(true);
    expect(r.parts.recognition.stopped).toBe(true);
    expect(r.parts.audio.paused).toBe(true);
    expect(r.audio.current).toBeNull();
  });

  /**
   * A report that lists work it did not do is the same lie as a test that passes on nothing.
   *
   * The provider can mount in a browser with no microphone, no speech synthesis and no fetch in
   * flight, and in that state the teardown must say so by saying nothing.
   */
  it("claims no step for a resource that was never there", () => {
    const report = teardownFrenchy({
      tracks: { current: [] },
      synthesis: null,
      controller: null,
      recognition: null,
      audio: { current: null },
    });
    expect(report.steps).toEqual([]);
    expect(report.failures).toEqual([]);
  });

  /**
   * The step that throws is the reason each one is guarded.
   *
   * `SpeechRecognition.stop()` raises when the recognizer was never started. If that escaped the
   * sequence, the audio element and the fetch would be abandoned mid-sentence — the leak this
   * function exists to close. So a failure is recorded *and* everything after it still happens.
   */
  it("keeps going when a step throws, and records which one", () => {
    const r = fakes();
    r.recognition.stop = () => {
      throw new Error("cannot stop an unstarted recognizer");
    };

    const report = teardownFrenchy(r);

    expect(report.failures).toEqual([
      { step: "recognition", message: "cannot stop an unstarted recognizer" },
    ]);
    expect(r.parts.trackA.stopped).toBe(true);
    expect(r.parts.controller.aborted).toBe(true);
    // The step after the throw still ran, which is the whole point.
    expect(r.parts.audio.paused).toBe(true);
    expect(r.audio.current).toBeNull();
  });
});

/**
 * Mute is not unmount.
 *
 * The difference is the microphone: muting a host should silence the answer it is making without
 * revoking the permission a visitor granted, and the old `mute()` managed neither — it set a
 * flag, left the brain's fetch running, and the answer arrived a moment later and spoke anyway.
 * These assertions are the two halves of that fix, and they are only falsifiable because
 * `cancelUtterance` is handed the whole bag: a function that never sees the tracks cannot be
 * shown to have left them alone.
 */
describe("muting an answer in flight", () => {
  it("aborts the fetch, stops the voice, and leaves the microphone alone", () => {
    const r = fakes();
    const done = cancelUtterance(r);

    expect(done).toEqual(["fetch", "synthesis", "audio"]);
    expect(r.parts.controller.aborted).toBe(true);
    expect(r.parts.controller.signal.aborted).toBe(true);
    expect(r.parts.synthesis.cancelled).toBe(true);
    expect(r.parts.audio.paused).toBe(true);
    expect(r.audio.current).toBeNull();

    // The capture is *not* released: muting is not revoking.
    expect(r.parts.trackA.stopped).toBe(false);
    expect(r.parts.trackB.stopped).toBe(false);
    expect(r.tracks.current).toHaveLength(2);
    // And it does not shut the recognizer, which is the caller's own step.
    expect(r.parts.recognition.stopped).toBe(false);
  });

  it("says nothing was done when nothing was in flight", () => {
    expect(
      cancelUtterance({
        tracks: { current: [] },
        synthesis: null,
        controller: null,
        recognition: null,
        audio: { current: null },
      }),
    ).toEqual([]);
  });
});

/**
 * The probe that decides whether the control exists at all.
 *
 * `POST /frenchy` reads its configuration before it reads its body, so an empty body answers
 * 503 on a host with no brain and 400 on a host with one. That is the only reason this can be
 * asked without paying for it, and the assertions below are what stop the probe drifting into
 * a request that does reach the provider: the body must stay empty of a prompt.
 */
describe("the brain probe", () => {
  const original = globalThis.fetch;

  async function withFetch(impl: typeof fetch, run: (calls: RequestCall[]) => Promise<void>) {
    const calls: RequestCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : null,
      });
      return impl(input, init);
    }) as typeof fetch;
    try {
      await run(calls);
    } finally {
      globalThis.fetch = original;
    }
  }

  interface RequestCall {
    url: string;
    method: string;
    body: string | null;
  }

  it("reads 503 as no brain, and 400 as one", async () => {
    await withFetch(
      (async () => new Response(JSON.stringify({ error: "Frenchy's brain is not configured" }), { status: 503 })) as typeof fetch,
      async () => {
        expect(await fetchFrenchyBrainStatus()).toBe(false);
      },
    );

    await withFetch(
      (async () => new Response(JSON.stringify({ error: "prompt is required" }), { status: 400 })) as typeof fetch,
      async () => {
        expect(await fetchFrenchyBrainStatus()).toBe(true);
      },
    );
  });

  it("counts a rate limit as a brain, and a missing route as not one", async () => {
    await withFetch(
      (async () => new Response("", { status: 429 })) as typeof fetch,
      async () => expect(await fetchFrenchyBrainStatus()).toBe(true),
    );
    await withFetch(
      (async () => new Response("", { status: 404 })) as typeof fetch,
      async () => expect(await fetchFrenchyBrainStatus()).toBe(false),
    );
  });

  it("is silent when the host does not answer at all", async () => {
    await withFetch(
      (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      async () => expect(await fetchFrenchyBrainStatus()).toBe(false),
    );
  });

  /**
   * The request shape is the reason this is free.
   *
   * A `prompt` in the body would reach the LLM and spend a provider credit on a status check,
   * which is the mistake this test exists to prevent. And the path has to be the API's own:
   * this app serves no `/api/frenchy`, so a relative path would 404 against Next and every host
   * would read as brainless.
   */
  it("asks on the API origin with no prompt", async () => {
    await withFetch(
      (async () => new Response("{}", { status: 400 })) as typeof fetch,
      async (calls) => {
        await fetchFrenchyBrainStatus();
        expect(calls).toHaveLength(1);
        const only = calls[0];
        if (!only) throw new Error("the probe made no request at all");
        expect(only.url).toBe(`${API_BASE}/frenchy`);
        expect(only.url).not.toContain("/api/");
        expect(only.method).toBe("POST");
        expect(JSON.parse(only.body ?? "{}")).not.toHaveProperty("prompt");
      },
    );
  });
});
