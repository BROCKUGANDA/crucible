/**
 * The money sound: an original motif, synthesized, with no audio asset in the bundle.
 *
 * Why it is written this way. Gate 434 (see `src/lib/frenchy/money-trees.ts`) is this project's
 * own rule: never embed commercial audio — deep-link the real track to the visitor's own
 * streaming app and let *their* subscription play it. So the sound a visitor hears when a trial
 * pays out cannot be a clip of someone's record; it has to be ours. What is ours is a short
 * motif built from oscillators: a coin strike, then a pentatonic run that lands on a two-tone
 * "ching". Catchy in the way a register is catchy — few notes, bright attack, fast decay.
 *
 * The second reason for synthesizing: nothing is fetched, so nothing the visitor hears depends
 * on a CDN, a cookie banner, or `media-src` in the CSP. WebAudio needs no media permission and
 * no blob URL, and it cannot play a file we do not have.
 *
 * `buildMotif` is pure and exported because a sound is only testable through its numbers. The
 * player below walks that list and starts one oscillator per note; the tests assert the shape of
 * the list. That separation is also what keeps autoplay policy honest: the context is created on
 * the first call from a click handler, never at import, so no page load can raise a console
 * error about an interrupted audio context.
 */

/** One note of the motif: frequency in Hz, offset and length in seconds, gain 0..1. */
export interface Note {
  readonly freq: number;
  readonly at: number;
  readonly dur: number;
  readonly gain: number;
  readonly wave: OscillatorType;
}

const A4 = 440;
/** Equal-tempered semitones from A4 — the tuning math stays in one place. */
const hz = (semitones: number): number => A4 * 2 ** (semitones / 12);

/**
 * A minor pentatonic on A (A C D E G), two octaves: bright, resolve-y, and impossible to sound
 * like a quoted melody because it is a scale fragment, not a tune.
 */
const PENTATONIC = [
  hz(-57), // A2
  hz(-48), // C3
  hz(-45), // D3
  hz(-40), // E3
  hz(-33), // G3
  hz(-21), // A3
  hz(-12), // C4
  hz(-9), // D4
  hz(-4), // E4
  hz(3), // G4
  hz(15), // A4
];

/**
 * The strike: two detuned squares a fifth apart, 40 ms apart, decaying in 90 ms. Reads as
 * metal hitting metal — the same reason a coin drop is instantly legible.
 */
export function coinStrike(at = 0): readonly Note[] {
  return [
    { freq: hz(27), at, dur: 0.09, gain: 0.5, wave: "square" },
    { freq: hz(34), at: at + 0.04, dur: 0.09, gain: 0.42, wave: "square" },
    { freq: hz(15), at: at + 0.08, dur: 0.13, gain: 0.3, wave: "triangle" },
  ];
}

/**
 * The payout flourish: coin strike, an ascending run, and a two-tone "ching" that lands on the
 * octave — the interval the ear takes as "finished".
 */
export function buildMotif(): readonly Note[] {
  const run = PENTATONIC.slice(5).map((freq, i) => ({
    freq,
    at: 0.16 + i * 0.055,
    dur: 0.16,
    gain: 0.2 + i * 0.02,
    wave: "triangle" as const,
  }));
  const chingAt = 0.16 + (run.length - 1) * 0.055 + 0.16;
  const ching: readonly Note[] = [
    { freq: hz(27), at: chingAt, dur: 0.5, gain: 0.34, wave: "sine" },
    { freq: hz(39), at: chingAt, dur: 0.5, gain: 0.26, wave: "sine" },
  ];
  return [...coinStrike(), ...run, ...ching];
}

/** Length of the motif in seconds, so a caller can space two plays apart. */
export function motifSeconds(notes: readonly Note[] = buildMotif()): number {
  return notes.reduce((end, n) => Math.max(end, n.at + n.dur), 0);
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  createOscillator(): unknown;
  createGain(): unknown;
  close(): Promise<void> | void;
}

export interface MoneySound {
  /** Plays the motif. Returns false when there is no audio support to play it with. */
  play(): boolean;
  /** A short strike only — the sound for a moment that is notable but not a payday. */
  strike(): boolean;
  dispose(): void;
}

/**
 * Build the player over an injected constructor.
 *
 * The injection is not decoration: the tests run in Node with no AudioContext, and this repo
 * bans fake shapes on runtime paths — so the same code path runs in both places and only the
 * context implementation differs.
 */
export function createMoneySound(makeContext: (() => AudioContextLike) | undefined): MoneySound {
  let ctx: AudioContextLike | null = null;

  function context(): AudioContextLike | null {
    if (!makeContext) return null;
    if (!ctx) ctx = makeContext();
    return ctx;
  }

  function schedule(notes: readonly Note[]): boolean {
    const c = context();
    if (!c) return false;
    const start = c.currentTime;
    for (const n of notes) {
      const osc = c.createOscillator() as {
        type: string;
        frequency: { value: number };
        connect: (dest: unknown) => void;
        start: (t: number) => void;
        stop: (t: number) => void;
      };
      const env = c.createGain() as {
        gain: {
          value: number;
          setValueAtTime: (v: number, t: number) => void;
          exponentialRampToValueAtTime: (v: number, t: number) => void;
        };
        connect: (dest: unknown) => void;
      };
      osc.type = n.wave;
      osc.frequency.value = n.freq;
      // Percussive envelope: instant attack, exponential decay. A linear ramp to zero sounds
      // like a fade; this one sounds like a strike, and the difference is the whole effect.
      env.gain.setValueAtTime(n.gain, start + n.at);
      env.gain.exponentialRampToValueAtTime(0.0001, start + n.at + n.dur);
      osc.connect(env);
      env.connect(c.destination);
      osc.start(start + n.at);
      osc.stop(start + n.at + n.dur + 0.02);
    }
    return true;
  }

  return {
    play: () => schedule(buildMotif()),
    strike: () => schedule(coinStrike()),
    dispose: () => {
      const c = ctx;
      ctx = null;
      if (c) void Promise.resolve(c.close()).catch(() => undefined);
    },
  };
}

/** A context factory for this browser, or undefined where there is no audio to build. */
export function browserAudioContext(): (() => AudioContextLike) | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  // A factory, not the constructor: the only place `new` happens is here, so the player takes the
  // same shape in the browser and in a test that has no WebAudio to hand.
  return Ctor ? () => new Ctor() : undefined;
}
