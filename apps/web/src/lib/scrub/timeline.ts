/**
 * The scrub timeline.
 *
 * The reference this is built against plays ~144 pre-rendered frames behind the page. We
 * draw instead of loading, so the frame count is a *virtual* ruler: one number that both
 * the canvas and the HUD agree on, so the counter in the corner is a real measurement of
 * the thing being drawn rather than a decoration copied from the reference.
 *
 * Acts are the six beats of the walk into the arena. They are boundaries in the same
 * 0..1 space the canvas reads, and a section of copy is assigned to exactly one act, so
 * the narrative, the drawing and the HUD can never disagree about where the reader is.
 */

/** The virtual frame ruler. Divisible by 2, 3, 4, 6, 8, 12 — clean act boundaries. */
export const FRAME_COUNT = 144;

export type ActKey = "gate" | "passage" | "sand" | "ordeal" | "verdict" | "alloy";

export interface Act {
  key: ActKey;
  /** Roman numeral, shown in the HUD and as the section eyebrow. */
  numeral: string;
  /** The act's name in capitals, as an inscription would carry it. */
  label: string;
  /**
   * The Roman term for the mechanism this act describes, and the reason the act is called
   * what it is: `pignus` is a pledge held as security, `sacramentum` the sworn deposit that
   * put a case in play, `provocatio` the appeal against a magistrate, `sententia` the
   * finding, `auctoritas` the standing that made a word count. One source, so the HUD rail
   * and the section heading can never disagree about which beat the reader is in.
   */
  latin: string;
  /** Inclusive start on the 0..1 timeline. */
  from: number;
  /** Exclusive end on the 0..1 timeline. */
  to: number;
}

/**
 * Six acts, contiguous, covering [0,1] with no gap and no overlap. The test in
 * `test/scrub-timeline.test.ts` proves contiguity and full coverage; an accidental gap
 * here would show up as the canvas freezing mid-scroll for one band, which is exactly the
 * kind of defect a static review misses.
 */
export const ACTS: readonly Act[] = [
  { key: "gate", numeral: "I", label: "The Gate", latin: "Pignus", from: 0, to: 0.16 },
  { key: "passage", numeral: "II", label: "The Oath", latin: "Sacramentum", from: 0.16, to: 0.34 },
  { key: "sand", numeral: "III", label: "The Sand", latin: "Harena", from: 0.34, to: 0.55 },
  { key: "ordeal", numeral: "IV", label: "The Appeal", latin: "Provocatio", from: 0.55, to: 0.75 },
  { key: "verdict", numeral: "V", label: "The Verdict", latin: "Sententia", from: 0.75, to: 0.9 },
  { key: "alloy", numeral: "VI", label: "The Standing", latin: "Auctoritas", from: 0.9, to: 1.0001 },
] as const;

/** Which act a timeline position falls in. Position 1 is the last act, not an off-by-one. */
export function actAt(progress: number): Act {
  const p = clamp01(progress);
  for (const act of ACTS) if (p >= act.from && p < act.to) return act;
  return ACTS[ACTS.length - 1]!;
}

/**
 * An act by name, for content that is written against a key rather than a position. Never
 * returns undefined: an unknown key falls back to the first act instead of silently
 * rendering a section with no numeral.
 */
export function actByKey(key: ActKey): Act {
  return ACTS.find((act) => act.key === key) ?? ACTS[0]!;
}

export function actIndexAt(progress: number): number {
  const p = clamp01(progress);
  const i = ACTS.findIndex((a) => p >= a.from && p < a.to);
  return i === -1 ? ACTS.length - 1 : i;
}

/** The frame index the canvas is drawing at. */
export function frameAt(progress: number): number {
  const p = clamp01(progress);
  return Math.min(FRAME_COUNT - 1, Math.round(p * (FRAME_COUNT - 1)));
}

/**
 * Local position of `progress` inside `[from,to]`, as 0..1. Used for every layer so a
 * band reads as its own camera move instead of inheriting the whole page's easing.
 */
export function band(progress: number, from: number, to: number): number {
  if (to <= from) return progress >= to ? 1 : 0;
  return clamp01((clamp01(progress) - from) / (to - from));
}

export function clamp01(value: number): number {
  // Ordered comparisons, so the infinities land on the ends they belong to and only a real
  // non-number is treated as "no position". `Number.isFinite(v) ? … : 0` clamps +Infinity to
  // 0, which reads as a page stuck at the top, and `Number.isNaN(v)` does not catch the
  // `undefined` that arrives out of a JSON payload.
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}
