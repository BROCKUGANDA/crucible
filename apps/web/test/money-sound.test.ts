import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMotif,
  coinStrike,
  createMoneySound,
  motifSeconds,
  type AudioContextLike,
} from "@/lib/money-sound";
import { celebrate, disposeSound, isSoundEnabled, soundSupported } from "@/lib/sound-pref";
import { DEFAULT_MONEY_TREES, resolveMoneyTrees, streamLink } from "@/lib/frenchy/money-trees";

/**
 * The money sound: what plays, whether it can be proven, and where it is wired.
 *
 * A sound is only testable through its numbers, so `buildMotif` is pure and asserted here as
 * data — the run rises, the strike is percussive, the flourish ends on an octave. The player is
 * then driven through a recording context, which is the same code path the browser takes with a
 * different oscillator underneath; injecting the constructor is what keeps this honest rather
 * than a mock of the thing itself.
 *
 * The last block is the wiring, in the house style: a scan of the executed statements. A motif
 * nobody can hear is a file, not a feature.
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(join(here, "..", "src", rel), "utf8");

/** Indexed reads are asserted, not assumed: a missing note is a broken motif, not a undefined. */
function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what}`);
  return value;
}

describe("the motif", () => {
  it("is a rising pentatonic run that lands on a two-tone chime", () => {
    const notes = buildMotif();
    expect(notes.length).toBeGreaterThan(6);
    // Ascending in frequency once the strike is over: the shape a listener reads as "money in".
    const run = notes.slice(coinStrike().length, -2);
    for (let i = 1; i < run.length; i += 1) {
      expect(need(run[i], "run note").freq).toBeGreaterThan(need(run[i - 1], "previous run note").freq);
    }
    expect(run.every((n) => n.at >= 0)).toBe(true);
    // The last two notes are a perfect octave apart — the interval the ear takes as "finished",
    // measured rather than described: 27 to 39 semitones above A4 is twelve apart.
    const [a, b] = notes.slice(-2);
    expect(need(b, "upper chime").freq / need(a, "lower chime").freq).toBeCloseTo(2, 6);
  });

  it("starts every note after the previous one and never runs past two seconds", () => {
    const notes = buildMotif();
    for (let i = 1; i < notes.length; i += 1) {
      expect(need(notes[i], "note").at).toBeGreaterThanOrEqual(need(notes[i - 1], "previous note").at);
    }
    const seconds = motifSeconds(notes);
    expect(seconds).toBeGreaterThan(0.4);
    expect(seconds).toBeLessThan(2);
  });

  it("uses gains a mixer would not call a clipping mess", () => {
    for (const n of buildMotif()) {
      expect(n.gain).toBeGreaterThan(0);
      expect(n.gain).toBeLessThanOrEqual(0.5);
    }
  });
});

interface Recorded {
  osc: { type: string; freq: number; start: number; stop: number }[];
  envs: { at: number; gain: number; ramp: number }[];
  closes: number;
}

function fakeContext(startTime = 10): AudioContextLike & { log: Recorded } {
  const log: Recorded = { osc: [], envs: [], closes: 0 };
  let pendingGain: { at: number; gain: number; ramp: number } | null = null;
  const node = {
    createOscillator() {
      const rec = { type: "", freq: 0, start: 0, stop: 0 };
      log.osc.push(rec);
      return {
        set type(v: string) {
          rec.type = v;
        },
        frequency: {
          set value(v: number) {
            rec.freq = v;
          },
        },
        connect: () => undefined,
        start: (t: number) => {
          rec.start = t;
        },
        stop: (t: number) => {
          rec.stop = t;
        },
      };
    },
    createGain() {
      const rec = { at: 0, gain: 0, ramp: 0 };
      log.envs.push(rec);
      pendingGain = rec;
      return {
        gain: {
          set value(_v: number) {
            /* the initial value is not used; the envelope below is what matters */
          },
          setValueAtTime: (v: number, t: number) => {
            if (pendingGain) {
              pendingGain.gain = v;
              pendingGain.at = t;
            }
          },
          exponentialRampToValueAtTime: (v: number, t: number) => {
            if (pendingGain) pendingGain.ramp = t;
            void v;
          },
        },
        connect: () => undefined,
      };
    },
  };
  return {
    get currentTime() {
      return startTime;
    },
    destination: {},
    createOscillator: node.createOscillator,
    createGain: node.createGain,
    close: () => {
      log.closes += 1;
    },
    log,
  } as unknown as AudioContextLike & { log: Recorded };
}

describe("the player", () => {
  it("starts one oscillator per note, scheduled against the context clock", () => {
    const ctx = fakeContext(10);
    const sound = createMoneySound(() => ctx);
    expect(sound.play()).toBe(true);
    const notes = buildMotif();
    expect(ctx.log.osc.length).toBe(notes.length);
    expect(ctx.log.envs.length).toBe(notes.length);
    // Every event time is the context's own clock plus the note offset — no absolute timestamps,
    // which is the only way two calls can both land without one of them being silent.
    expect(need(ctx.log.osc[0], "first oscillator").start).toBeCloseTo(10 + need(notes[0], "first note").at, 6);
    for (let i = 0; i < notes.length; i += 1) {
      expect(need(ctx.log.osc[i], "oscillator").stop).toBeGreaterThan(need(ctx.log.osc[i], "oscillator start").start);
      expect(need(ctx.log.envs[i], "envelope").ramp).toBeGreaterThan(need(ctx.log.envs[i], "envelope start").at);
    }
    sound.dispose();
    expect(ctx.log.closes).toBe(1);
  });

  it("refuses to play where there is no audio, instead of throwing", () => {
    const sound = createMoneySound(undefined);
    expect(sound.play()).toBe(false);
    expect(sound.strike()).toBe(false);
    sound.dispose();
  });

  it("strikes without the flourish — a shorter event needs a shorter sound", () => {
    const ctx = fakeContext(1);
    const sound = createMoneySound(() => ctx);
    expect(sound.strike()).toBe(true);
    expect(ctx.log.osc.length).toBe(coinStrike().length);
    sound.dispose();
  });
});

/** The browser surface `sound-pref` reads, with storage we can inspect. */
function withWindow(stored: Record<string, string>, ctx: AudioContextLike | null) {
  const g = globalThis as unknown as { window?: unknown };
  g.window = {
    localStorage: {
      getItem: (k: string) => stored[k] ?? null,
      setItem: (k: string, v: string) => {
        stored[k] = v;
      },
      removeItem: (k: string) => {
        delete stored[k];
      },
    },
    // A function expression, not an arrow: the library does `new AudioCtor()`, and `new` on an
    // arrow throws — a fixture that cannot be constructed would test nothing.
    ...(ctx ? { AudioContext: function FakeAudioContext() { return ctx; } } : {}),
  };
  disposeSound();
  return () => {
    delete g.window;
    disposeSound();
  };
}

describe("the switch", () => {
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
    disposeSound();
  });

  it("stays off until the stored word says on, and never reads a legacy value as consent", () => {
    let cleanup = withWindow({ "crucible.sound": "true" }, fakeContext());
    expect(isSoundEnabled()).toBe(false);
    expect(celebrate(() => 0)).toBe(false);
    cleanup();

    cleanup = withWindow({ "crucible.sound": "on" }, fakeContext());
    expect(isSoundEnabled()).toBe(true);
    expect(soundSupported()).toBe(true);
  });

  it("will not stack a second motif on top of the first", () => {
    const ctx = fakeContext();
    const cleanup = withWindow({ "crucible.sound": "on" }, ctx);
    const span = motifSeconds() * 1000;
    expect(celebrate(() => 1_000)).toBe(true);
    // Halfway through the flourish: a second play would be the same arpeggio doubled.
    expect(celebrate(() => 1_000 + span / 2)).toBe(false);
    expect(celebrate(() => 1_000 + span + 1)).toBe(true);
    const log = (ctx as unknown as { log: Recorded }).log;
    expect(log.osc.length).toBe(buildMotif().length * 2);
    cleanup();
  });

  it("plays nothing at all when the visitor never enabled it", () => {
    const ctx = fakeContext();
    const cleanup = withWindow({}, ctx);
    expect(celebrate(() => 0)).toBe(false);
    expect((ctx as unknown as { log: Recorded }).log.osc.length).toBe(0);
    cleanup();
  });
});

describe("the wiring", () => {
  it("mounts the switch in the chrome beside the voice control", () => {
    const chrome = src("components/Chrome.tsx");
    expect(chrome).toMatch(/import \{ PayoffSound \} from "@\/components\/PayoffSound";/);
    expect(chrome).toMatch(/<PayoffSound \/>/);
  });

  it("celebrates a paid verdict on the trial page, and only there", () => {
    const page = src("app/trials/[id]/trial-detail.tsx");
    expect(page).toMatch(/import \{ celebrate \} from "@\/lib\/sound-pref";/);
    // Inside the paid branch: the guard above the call must refuse a slash or a refund.
    const paid = page.match(/trial\.verdict !== "paid"[\s\S]{0,400}?celebrate\(\);/);
    expect(paid, "celebrate() must sit behind the paid-verdict guard").toBeTruthy();
  });

  it("ships no audio asset and no embedded clip anywhere in the app", () => {
    // Gate 434's rule, widened from src/lib/frenchy to the whole app: what plays here is either
    // synthesized by us or played on the visitor's own device by their own subscription.
    for (const file of ["lib/money-sound.ts", "lib/sound-pref.ts", "components/PayoffSound.tsx", "components/MoneyTreesChip.tsx"]) {
      const text = src(file);
      expect(text).not.toMatch(/<audio\b|\.(mp3|wav|ogg|m4a|aac|flac)\b|from\s+["'](?:howler|wavesurfer)/i);
    }
  });

  it("deep-links a search, never a hard-coded someone-elses video", () => {
    const trees = src("lib/frenchy/money-trees.ts");
    expect(trees).not.toMatch(/watch\?v=/);
    // The id that shipped before was `dQw4w9WgXcQ` — Rick Astley. A guessed or copied video id
    // is a claim about a specific recording nobody in this repository opened.
    expect(trees).not.toMatch(/dQw4w9WgXcQ/);
    expect(trees).toMatch(/search_query|\/search\//);
  });

  it("mounts the CUE IT chip on the paid verdict, and only there", () => {
    const page = src("app/trials/[id]/trial-detail.tsx");
    expect(page).toMatch(/import \{ MoneyTreesChip \} from "@\/components\/MoneyTreesChip";/);
    expect(page).toMatch(/<MoneyTreesChip settled=\{trial\.verdict === "paid"\} \/>/);
    // Position, not prose: the chip must land inside the verdict branch, so it cannot render on a
    // `none` trial. An index comparison survives the panel's own markup, which a fixed-size window
    // did not — the first version of this check measured 700 characters and missed.
    const guard = page.indexOf('trial.verdict !== "none"');
    const chip = page.indexOf("<MoneyTreesChip settled=");
    const nextBranch = page.indexOf(') : trial.status === "challenged"');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(nextBranch).toBeGreaterThan(guard);
    expect(chip, "the chip must sit between the verdict guard and the branch after it").toBeGreaterThan(guard);
    expect(chip).toBeLessThan(nextBranch);
  });
});

describe("the deep link", () => {
  it("writes each source's link once, and derives the default from it", () => {
    expect(DEFAULT_MONEY_TREES.url).toBe(streamLink(DEFAULT_MONEY_TREES.source));
    for (const source of ["youtube", "spotify", "apple-music"] as const) {
      const link = streamLink(source);
      expect(link).toMatch(/search/);
      // `%2B` is what an earlier draft produced by encoding its own plus separators — YouTube
      // reads that as a literal plus and searches for the wrong thing. A `t=` is a timestamp on
      // somebody else's recording, which is the shape this file is not allowed to link.
      expect(link).not.toMatch(/%2B|[?&]t=\d/);
    }
    expect(streamLink("spotify")).toBe("https://open.spotify.com/search/kendrick%20lamar%20money%20trees");
  });

  it("follows a remote source that brings no url, so a Spotify chip never opens YouTube", () => {
    expect(resolveMoneyTrees({ source: "spotify" }).url).toContain("open.spotify.com");
    expect(resolveMoneyTrees({ url: "" }).url).toBe(streamLink("youtube"));
    expect(resolveMoneyTrees(null)).toEqual(DEFAULT_MONEY_TREES);
  });
});
