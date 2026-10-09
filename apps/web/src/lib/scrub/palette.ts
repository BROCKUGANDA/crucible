import { forge } from "@/lib/forge";

/**
 * The scene's colour ramp.
 *
 * One sky, one stone, one sand, and the light on them changes through the walk. The four
 * *state* colours (action, value, reprieve, slash) are imported from `forge` so the canvas
 * and the components cannot disagree about what "slashed" looks like. The four Roman
 * material colours are declared here and mirrored in `styles/tokens.css`; the drift gate in
 * `test/scrub-palette.test.ts` parses the stylesheet and fails if the two ever separate,
 * because a scene that drifts from the theme is invisible until someone ships it.
 */

/** Material tokens. Keep in sync with `--marble --bronze --sand --tyrian` in tokens.css. */
export const material = {
  marble: "#F2EAD9",
  bronze: "#8C6B3F",
  sand: "#C8A878",
  tyrian: "#7A2B56",
} as const;

type Channel = "r" | "g" | "b";

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const CHANNELS: Channel[] = ["r", "g", "b"];

function parse(hex: string): Rgb {
  const h = hex.trim().replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function channel(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  const clamped = Math.max(0, Math.min(255, Math.round(safe)));
  return clamped.toString(16).padStart(2, "0");
}

/** Linear blend of two hex colours, returning a hex the canvas accepts anywhere. */
export function mix(from: string, to: string, t: number): string {
  const a = parse(from);
  const b = parse(to);
  // A non-finite factor is a caller bug, and the honest answer is the start colour. Left
  // unguarded it produces a literal `NaN` channel, which the canvas silently draws as black.
  const k = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  let out = "#";
  for (const c of CHANNELS) out += channel(a[c]! + (b[c]! - a[c]!) * k);
  return out;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** A hex as an rgba() string — the canvas has no alpha channel on gradient stops otherwise. */
export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = parse(hex);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

/**
 * A keyframe of light. `at` is the timeline position it describes, and the palette between
 * two keyframes is blended, never snapped, so the scrub reads as continuous.
 */
export interface LightKey {
  at: number;
  skyTop: string;
  skyLow: string;
  stoneLit: string;
  stoneDeep: string;
  sand: string;
  glow: string;
  haze: string;
}

const LIGHT: readonly LightKey[] = [
  {
    // The hero, before dawn. This key sits under the wordmark for the whole first
    // screen, and it used to be so dark the arcade read as a silhouette behind
    // mud. The stone now holds travertine in shadow rather than extinguishing it.
    at: 0,
    skyTop: "#0E0F15",
    skyLow: "#2E1B13",
    stoneLit: "#4A3A2C",
    stoneDeep: "#17110D",
    sand: "#382B20",
    glow: "#74482A",
    haze: "#201519",
  },
  {
    at: 0.16,
    skyTop: "#191822",
    skyLow: "#6E3B26",
    stoneLit: "#8B6539",
    stoneDeep: "#1F1613",
    sand: "#54402A",
    glow: "#D8873F",
    haze: "#31201E",
  },
  {
    at: 0.36,
    skyTop: "#2B2016",
    skyLow: "#6B4526",
    stoneLit: "#B08A54",
    stoneDeep: "#2A1D15",
    sand: "#8A6B41",
    glow: "#E9A95C",
    haze: "#3A2A1B",
  },
  {
    at: 0.55,
    skyTop: "#3E3323",
    skyLow: "#A07A44",
    stoneLit: "#DCC08A",
    stoneDeep: "#3D2E1E",
    sand: "#C8A878",
    glow: "#F2D9A0",
    haze: "#57432A",
  },
  {
    at: 0.75,
    skyTop: "#43261A",
    skyLow: "#B0512C",
    stoneLit: "#E2A468",
    stoneDeep: "#361A12",
    sand: "#D08F5A",
    glow: "#FF7A3C",
    haze: "#5E2A1C",
  },
  {
    at: 0.9,
    skyTop: "#201014",
    skyLow: "#4A1420",
    stoneLit: "#B4784E",
    stoneDeep: "#1C0F10",
    sand: "#9A6144",
    glow: "#C22F2A",
    haze: "#331418",
  },
  {
    at: 1,
    skyTop: "#0D0B0C",
    skyLow: "#241812",
    stoneLit: "#93713F",
    stoneDeep: "#120D0A",
    sand: "#5C452C",
    glow: "#D8A94F",
    haze: "#1A1210",
  },
] as const;

export interface ScenePalette {
  skyTop: string;
  skyLow: string;
  stoneLit: string;
  stoneDeep: string;
  sand: string;
  glow: string;
  haze: string;
  /** The sovereign accent — the emperor's box, the seal ring. Always Tyrian. */
  tyrian: string;
  /** The state colour of the settlement being narrated, or bronze while nothing has settled. */
  mark: string;
}

/**
 * Which way the crowd turns at the end. Fed from the last settled trial in the index, so
 * the closing act is a statement about real data rather than a colour that looked good.
 */
export type SettlementMark = "none" | "paid" | "slashed" | "refunded";

const MARK: Record<SettlementMark, string> = {
  none: material.bronze,
  paid: forge.quench,
  slashed: forge.sear,
  refunded: forge.ash,
};

export function scenePalette(progress: number, mark: SettlementMark = "none"): ScenePalette {
  const p = clampUnit(progress);

  let a = LIGHT[0]!;
  let b = LIGHT[LIGHT.length - 1]!;
  for (let i = 0; i < LIGHT.length - 1; i += 1) {
    const lo = LIGHT[i]!;
    const hi = LIGHT[i + 1]!;
    if (p >= lo.at && p <= hi.at) {
      a = lo;
      b = hi;
      break;
    }
  }

  const span = b.at - a.at;
  const t = span <= 0 ? 0 : (p - a.at) / span;

  return {
    skyTop: mix(a.skyTop, b.skyTop, t),
    skyLow: mix(a.skyLow, b.skyLow, t),
    stoneLit: mix(a.stoneLit, b.stoneLit, t),
    stoneDeep: mix(a.stoneDeep, b.stoneDeep, t),
    sand: mix(a.sand, b.sand, t),
    glow: mix(a.glow, b.glow, t),
    haze: mix(a.haze, b.haze, t),
    tyrian: material.tyrian,
    mark: p >= 0.72 ? mix(MARK.none, MARK[mark], Math.min(1, (p - 0.72) / 0.14)) : MARK.none,
  };
}
