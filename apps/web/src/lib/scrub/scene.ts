import { forge } from "@/lib/forge";
import { material, mix, scenePalette, withAlpha } from "./palette";
import type { ScenePalette, SettlementMark } from "./palette";
import { band, clamp01 } from "./timeline";

/**
 * The arena, drawn.
 *
 * Every pixel here is a function of `progress` and nothing else — never wall-clock time.
 * Scrub back and the dust, the crowd, the cloth and the light return to exactly the frame
 * you passed, which is the property that makes this a scrub and not an animation. It also
 * means the page does zero work while nobody scrolls: no idle rAF loop, no allocation
 * churn, nothing for the collector to keep finding.
 *
 * The context is a narrow structural interface rather than `CanvasRenderingContext2D`. It
 * states what the scene actually depends on, and it lets the tests record draw calls in
 * plain node. The real 2D context satisfies it structurally.
 */

export interface SceneGradient {
  addColorStop(offset: number, color: string): void;
}

export interface SceneCtx {
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  ellipse(
    x: number,
    y: number,
    rx: number,
    ry: number,
    rot: number,
    a0: number,
    a1: number,
  ): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): SceneGradient;
  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): SceneGradient;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  fillStyle: string | SceneGradient;
  strokeStyle: string | SceneGradient;
  lineWidth: number;
  globalAlpha: number;
  font: string;
  textAlign: string;
  textBaseline: string;
}

export interface SceneSize {
  w: number;
  h: number;
}

export interface SceneInput {
  /** 0..1, straight from the scrub controller. */
  progress: number;
  /** The settlement being narrated. Carries the mark colour through the last two acts. */
  mark?: SettlementMark;
  /**
   * 0..1 crowd fill, normalised from the registered-agent count by the host. The HUD
   * states that mapping out loud, so a growing crowd is a reading and not decoration.
   */
  crowd?: number;
  /** The numeral in the seal — the top tier on the roll, or the act number. */
  seal?: string;
}

const TAU = Math.PI * 2;

/** Deterministic scatter: same seed, same frame. Required by the rewind property. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A round-arched opening — the unit the whole building is assembled from. */
function archPath(ctx: SceneCtx, x: number, y: number, w: number, h: number): void {
  const r = w / 2;
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.arc(x + r, y + r, r, Math.PI, 0);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

function poly(ctx: SceneCtx, pts: number[][], color: string): void {
  const first = pts[0];
  if (!first) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(first[0]!, first[1]!);
  for (let i = 1; i < pts.length; i += 1) {
    const p = pts[i]!;
    ctx.lineTo(p[0]!, p[1]!);
  }
  ctx.closePath();
  ctx.fill();
}

function dot(ctx: SceneCtx, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.ellipse(x, y, r, r, 0, 0, TAU);
  ctx.fill();
}

// -------------------------------------------------------------------------- sky and distance

function sky(ctx: SceneCtx, size: SceneSize, pal: ScenePalette, p: number): void {
  const { w, h } = size;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, pal.skyTop);
  g.addColorStop(0.52, pal.skyLow);
  g.addColorStop(1, pal.haze);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Stars exist only before dawn, and leave on a curve so act I reads as elapsed time.
  const night = 1 - clamp01(band(p, 0, 0.14));
  if (night > 0.01) {
    const rand = prng(7);
    ctx.globalAlpha = night;
    ctx.fillStyle = material.marble;
    for (let i = 0; i < 80; i += 1) dot(ctx, rand() * w, rand() * h * 0.42, rand() * 1.1 + 0.25);
    ctx.globalAlpha = 1;
  }
}

/** The hills behind the amphitheatre. Fixed geometry, so it is a skyline rather than noise. */
function skyline(ctx: SceneCtx, size: SceneSize, pal: ScenePalette, p: number): void {
  const fade = 1 - clamp01(band(p, 0.04, 0.3));
  if (fade <= 0.01) return;
  const { w, h } = size;
  const base = h * 0.5;
  const rand = prng(23);
  ctx.globalAlpha = fade;
  for (let i = 0; i < 16; i += 1) {
    const cx = (i / 16) * w + rand() * (w / 40);
    const bw = w * (0.05 + rand() * 0.07);
    const bh = h * (0.02 + rand() * 0.055);
    poly(
      ctx,
      [
        [cx - bw / 2, base],
        [cx - bw / 2, base - bh],
        [cx, base - bh - h * 0.012],
        [cx + bw / 2, base - bh],
        [cx + bw / 2, base],
      ],
      withAlpha(pal.stoneDeep, 0.85),
    );
  }
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------------------- act I — the exterior

/**
 * Four stacked orders of arcade. Bays bulge toward the middle and rise there, which is what
 * an ellipse actually does when you stand outside it.
 */
function exterior(ctx: SceneCtx, size: SceneSize, pal: ScenePalette, p: number): void {
  const alpha = 1 - clamp01(band(p, 0.16, 0.34));
  if (alpha <= 0.01) return;
  const t = band(p, 0, 0.24);
  const { w, h } = size;

  ctx.save();
  ctx.globalAlpha = alpha;
  const zoom = 1 + t * 0.26;
  ctx.translate(w / 2, h);
  ctx.scale(zoom, zoom);
  ctx.translate(-w / 2, -h);

  const tiers = 4;
  const wallTop = h * (0.16 + t * 0.05);
  const wallBottom = h * 1.02;
  const tierH = (wallBottom - wallTop) / tiers;
  const bayW = tierH * 0.82;
  const bays = Math.ceil(w / bayW) + 1;

  for (let tier = 0; tier < tiers; tier += 1) {
    const y = wallTop + tier * tierH;
    ctx.fillStyle = mix(pal.stoneLit, pal.stoneDeep, tier / tiers);
    ctx.beginPath();
    ctx.rect(0, y, w, tierH);
    ctx.fill();

    for (let b = 0; b < bays; b += 1) {
      const u = b / (bays - 1 || 1);
      const bulge = Math.sin(Math.PI * u);
      const x = u * w - bayW / 2;
      const rise = tierH * 0.16 * bulge;
      const aw = bayW * (0.6 + bulge * 0.1);
      const ah = (tierH - tierH * 0.22) * (1 + bulge * 0.1);

      ctx.fillStyle = withAlpha(pal.stoneDeep, 0.92);
      ctx.beginPath();
      archPath(ctx, x + (bayW - aw) / 2, y + rise + tierH * 0.12, aw, ah);
      ctx.fill();

      if (tier < 3) {
        ctx.fillStyle = withAlpha(pal.stoneLit, 0.5);
        ctx.beginPath();
        ctx.rect(x + bayW - tierH * 0.06, y + rise, tierH * 0.06, tierH);
        ctx.fill();
      }
    }

    ctx.fillStyle = withAlpha(pal.stoneLit, 0.28);
    ctx.beginPath();
    ctx.rect(0, y, w, tierH * 0.055);
    ctx.fill();
  }

  // Crown cornice and the masts the velarium was slung from.
  ctx.fillStyle = pal.stoneLit;
  ctx.beginPath();
  ctx.rect(0, wallTop - tierH * 0.09, w, tierH * 0.09);
  ctx.fill();
  ctx.fillStyle = withAlpha(pal.stoneDeep, 0.8);
  const masts = Math.max(6, Math.round(w / 90));
  for (let m = 0; m < masts; m += 1) {
    const mx = ((m + 0.5) / masts) * w;
    ctx.beginPath();
    ctx.rect(mx - 1.5, wallTop - tierH * 0.22, 3, tierH * 0.13);
    ctx.fill();
  }
  ctx.restore();
}

// --------------------------------------------------------------------- act II — the vomitorium

/**
 * A tunnel of receding arch rings, each a shade darker than the last, with the arena
 * arriving as light before it arrives as architecture.
 */
function passage(ctx: SceneCtx, size: SceneSize, pal: ScenePalette, p: number): void {
  const alpha = clamp01(band(p, 0.14, 0.22)) * (1 - clamp01(band(p, 0.3, 0.42)));
  if (alpha <= 0.01) return;
  const t = band(p, 0.14, 0.36);
  const { w, h } = size;
  const cx = w / 2;
  const cy = h * 0.52;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = pal.stoneDeep;
  ctx.fillRect(0, 0, w, h);

  const rings = 13;
  for (let i = rings - 1; i >= 0; i -= 1) {
    const k = (i + t * 1.6) / rings;
    const s = Math.pow(1.32, k * rings) * 0.24;
    const rw = w * 0.34 * s;
    const rh = rw * 1.5;
    ctx.fillStyle = withAlpha(mix(pal.stoneLit, pal.stoneDeep, 1 - i / rings), 0.95);
    ctx.beginPath();
    archPath(ctx, cx - rw / 2, cy - rh * 0.36, rw, rh);
    ctx.fill();
  }

  const ap = 0.1 + t * 0.5;
  const g = ctx.createRadialGradient(cx, cy * 0.96, 0, cx, cy * 0.96, w * ap);
  g.addColorStop(0, withAlpha(pal.glow, 0.95));
  g.addColorStop(0.5, withAlpha(pal.glow, 0.35));
  g.addColorStop(1, withAlpha(pal.glow, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(cx, cy * 0.96, w * ap, w * ap * 0.72, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// ------------------------------------------------------------------- act III/IV — cavea and sand

function interior(
  ctx: SceneCtx,
  size: SceneSize,
  pal: ScenePalette,
  p: number,
  crowd: number,
): void {
  const arrive = clamp01(band(p, 0.3, 0.5));
  const alpha = arrive * (1 - clamp01(band(p, 0.94, 1)) * 0.35);
  if (alpha <= 0.01) return;
  const { w, h } = size;
  const cx = w / 2;
  const floor = h * (0.72 - arrive * 0.06);

  ctx.save();
  ctx.globalAlpha = alpha;

  const tiers = 7;
  for (let i = tiers - 1; i >= 0; i -= 1) {
    const k = i / tiers;
    const ry = h * (0.1 + k * 0.34);
    const rx = w * (0.52 + k * 0.62);
    const y = floor - h * 0.06 - ry * 0.35;

    ctx.fillStyle = withAlpha(mix(pal.stoneDeep, pal.stoneLit, 0.25 + k * 0.5), 0.9);
    ctx.beginPath();
    ctx.ellipse(cx, y, rx, ry * 0.42, 0, Math.PI, TAU);
    ctx.fill();

    if (i >= 2) {
      const dots = Math.round(24 + 56 * (0.35 + crowd * 0.65));
      const rand = prng(1000 + i * 37);
      ctx.fillStyle = withAlpha("#0E0A08", 0.5);
      for (let d = 0; d < dots; d += 1) {
        const a = Math.PI + rand() * Math.PI;
        const rr = 0.72 + rand() * 0.26;
        dot(ctx, cx + Math.cos(a) * rx * rr, y + Math.sin(a) * ry * 0.42 * rr, 1.5 + rand() * 1.4);
      }
    }
  }

  // The poleium band at the top of the seating, then the awning slung off the masts.
  ctx.fillStyle = withAlpha(pal.stoneLit, 0.5);
  ctx.beginPath();
  ctx.ellipse(cx, floor - h * 0.3, w * 0.94, h * 0.2, 0, Math.PI, TAU);
  ctx.fill();

  const sail = ctx.createLinearGradient(0, 0, 0, h * 0.3);
  sail.addColorStop(0, withAlpha(pal.tyrian, 0.55));
  sail.addColorStop(1, withAlpha(pal.tyrian, 0.06));
  ctx.fillStyle = sail;
  ctx.beginPath();
  ctx.moveTo(-w * 0.05, h * 0.02);
  for (let i = 0; i <= 8; i += 1) {
    const x = -w * 0.05 + (i / 8) * w * 1.1;
    const dip = h * (0.09 + 0.05 * Math.sin(i * 1.7 + p * 6));
    ctx.quadraticCurveTo(x + w * 0.06, dip + h * 0.06, x + w * 0.1375, dip);
  }
  ctx.lineTo(w * 1.05, -h * 0.05);
  ctx.lineTo(-w * 0.05, -h * 0.05);
  ctx.closePath();
  ctx.fill();

  const sandG = ctx.createLinearGradient(0, floor - h * 0.06, 0, h);
  sandG.addColorStop(0, mix(pal.sand, pal.stoneDeep, 0.35));
  sandG.addColorStop(0.4, pal.sand);
  sandG.addColorStop(1, mix(pal.sand, "#000000", 0.45));
  ctx.fillStyle = sandG;
  ctx.beginPath();
  ctx.ellipse(cx, floor + h * 0.06, w * 0.86, h * 0.3, 0, 0, TAU);
  ctx.fill();

  // The hypogeum grid in perspective: the slots the stage machinery was lifted through.
  ctx.strokeStyle = withAlpha(pal.stoneDeep, 0.5);
  ctx.lineWidth = Math.max(1, w / 900);
  ctx.beginPath();
  for (let r = 1; r <= 7; r += 1) {
    const k = Math.pow(r / 7, 1.7);
    const y = floor + h * 0.02 + k * h * 0.24;
    const half = w * 0.5 * (1 - k * 0.55);
    ctx.moveTo(cx - half, y);
    ctx.lineTo(cx + half, y);
  }
  const spokes = 13;
  for (let s = 0; s < spokes; s += 1) {
    const u = s / (spokes - 1) - 0.5;
    ctx.moveTo(cx + u * w * 0.92, floor + h * 0.02);
    ctx.lineTo(cx + u * w * 0.24, floor + h * 0.27);
  }
  ctx.stroke();
  ctx.restore();
}

/** Sun off the cavea. The lean is a function of progress, so the shafts swing as you move. */
function shafts(ctx: SceneCtx, size: SceneSize, pal: ScenePalette, p: number): void {
  const t = clamp01(band(p, 0.34, 0.9));
  const strength = 0.16 + 0.3 * Math.sin(Math.PI * clamp01((p - 0.3) / 0.5));
  if (strength <= 0.02) return;
  const { w, h } = size;
  const lean = -0.18 + t * 0.5;
  for (let i = 0; i < 5; i += 1) {
    const x = w * (0.1 + i * 0.19);
    const pw = w * (0.05 + (i % 3) * 0.02);
    poly(
      ctx,
      [
        [x, -h * 0.05],
        [x + pw, -h * 0.05],
        [x + pw + h * lean * 1.5, h],
        [x + h * lean * 1.5, h],
      ],
      withAlpha(pal.glow, strength * (0.4 + 0.2 * ((i % 2) + 1)) * 0.5),
    );
  }
}

function dust(ctx: SceneCtx, size: SceneSize, pal: ScenePalette, p: number): void {
  const vis = clamp01(band(p, 0.45, 0.62)) * (1 - clamp01(band(p, 0.95, 1)));
  if (vis <= 0.01) return;
  const { w, h } = size;
  const rand = prng(404);
  ctx.globalAlpha = vis;
  ctx.fillStyle = withAlpha(pal.glow, 0.5);
  for (let i = 0; i < 90; i += 1) {
    const bx = rand();
    const by = rand();
    const sp = 0.3 + rand() * 1.1;
    // Progress-derived, never time-derived: this is what makes the dust rewind.
    dot(ctx, ((bx + p * sp * 0.6) % 1) * w, ((by - p * sp * 0.35 + 1) % 1) * h, 0.6 + rand() * 1.6);
  }
  ctx.globalAlpha = 1;
}

/** The two standards, one per side of a trial. The cloth leans with the reader's position. */
function banners(ctx: SceneCtx, size: SceneSize, pal: ScenePalette, p: number): void {
  const vis = clamp01(band(p, 0.5, 0.68)) * (1 - clamp01(band(p, 0.86, 0.95)));
  if (vis <= 0.01) return;
  const { w, h } = size;
  ctx.save();
  ctx.globalAlpha = vis;
  const sway = (p - 0.6) * w * 0.03;
  const sides: [number, string][] = [
    [w * 0.17, pal.mark],
    [w * 0.83, pal.tyrian],
  ];
  for (const [x, color] of sides) {
    ctx.fillStyle = withAlpha(material.bronze, 0.9);
    ctx.fillRect(x - w * 0.0035, h * 0.34, w * 0.007, h * 0.4);
    poly(
      ctx,
      [
        [x, h * 0.34],
        [x + sway + w * 0.075, h * 0.355],
        [x + sway + w * 0.075, h * 0.465],
        [x, h * 0.48],
      ],
      withAlpha(color, 0.8),
    );
    ctx.fillStyle = withAlpha(material.marble, 0.55);
    ctx.fillRect(x - w * 0.006, h * 0.315, w * 0.012, h * 0.012);
  }
  ctx.restore();
}

/** The pulvinar: Tyrian canopy over the imperial box, dead centre of the top tier. */
function pulvinar(ctx: SceneCtx, size: SceneSize, pal: ScenePalette, p: number): void {
  const vis = clamp01(band(p, 0.68, 0.8));
  if (vis <= 0.01) return;
  const { w, h } = size;
  const cx = w / 2;
  const top = h * 0.06;
  const bw = w * 0.26;
  ctx.save();
  ctx.globalAlpha = vis;

  ctx.fillStyle = withAlpha(pal.stoneLit, 0.9);
  ctx.fillRect(cx - bw / 2, top, bw, h * 0.16);
  ctx.fillStyle = pal.stoneDeep;
  ctx.beginPath();
  archPath(ctx, cx - bw * 0.32, top + h * 0.03, bw * 0.64, h * 0.12);
  ctx.fill();

  const canopy = ctx.createLinearGradient(0, top - h * 0.05, 0, top + h * 0.04);
  canopy.addColorStop(0, pal.tyrian);
  canopy.addColorStop(1, withAlpha(pal.tyrian, 0.25));
  ctx.fillStyle = canopy;
  ctx.beginPath();
  ctx.moveTo(cx - bw * 0.62, top - h * 0.05);
  ctx.quadraticCurveTo(cx, top + h * 0.02, cx + bw * 0.62, top - h * 0.05);
  ctx.lineTo(cx + bw * 0.62, top - h * 0.01);
  ctx.quadraticCurveTo(cx, top + h * 0.06, cx - bw * 0.62, top - h * 0.01);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = withAlpha(forge.gold, 0.75);
  for (let i = 0; i < 9; i += 1) {
    const x = cx - bw * 0.55 + (i / 8) * bw * 1.1;
    ctx.fillRect(x, top + h * 0.012, w * 0.004, h * 0.018);
  }
  ctx.restore();
}

/**
 * The seal: a laurel ring around a disc that carries the settlement's colour. This is the
 * one place the drawing states a fact about the chain rather than about architecture.
 */
function seal(
  ctx: SceneCtx,
  size: SceneSize,
  pal: ScenePalette,
  p: number,
  numeral: string,
): void {
  const vis = clamp01(band(p, 0.78, 0.92));
  if (vis <= 0.01) return;
  const { w, h } = size;
  const cx = w / 2;
  const cy = h * 0.5;
  const r = Math.min(w, h) * 0.17 * (0.7 + vis * 0.3);

  ctx.save();
  ctx.globalAlpha = vis;

  const halo = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 2.6);
  halo.addColorStop(0, withAlpha(pal.mark, 0.4));
  halo.addColorStop(1, withAlpha(pal.mark, 0));
  ctx.fillStyle = halo;
  dot(ctx, cx, cy, r * 2.6);

  ctx.fillStyle = withAlpha("#0B0908", 0.85);
  dot(ctx, cx, cy, r);

  ctx.strokeStyle = pal.mark;
  ctx.lineWidth = Math.max(1.5, r * 0.06);
  ctx.beginPath();
  ctx.ellipse(cx, cy, r * 0.94, r * 0.94, 0, 0, TAU);
  ctx.stroke();

  // Two branches sweeping up from the tied bottom, leaving the crown of the ring open.
  ctx.fillStyle = withAlpha(forge.gold, 0.85);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 11; i += 1) {
      const a = Math.PI / 2 + side * (0.12 + (i / 10) * 2.28);
      const lx = cx + Math.cos(a) * r * 1.2;
      const ly = cy + Math.sin(a) * r * 1.2;
      ctx.beginPath();
      ctx.ellipse(lx, ly, r * 0.11, r * 0.045, a + Math.PI / 2, 0, TAU);
      ctx.fill();
    }
  }

  ctx.fillStyle = withAlpha(material.marble, 0.92);
  ctx.font = `${Math.round(r * 0.72)}px "Cinzel", "Trajan Pro", Georgia, serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(numeral, cx, cy);
  ctx.restore();
}

/** The honour roll at dusk: a shield for each name on it, ranked from the centre out. */
function shields(
  ctx: SceneCtx,
  size: SceneSize,
  pal: ScenePalette,
  p: number,
  count: number,
): void {
  const vis = clamp01(band(p, 0.9, 1));
  if (vis <= 0.01) return;
  const { w, h } = size;
  const n = Math.max(3, Math.min(8, count));
  const bw = w * 0.07;
  const y = h * 0.84;
  ctx.save();
  ctx.globalAlpha = vis * 0.9;
  for (let i = 0; i < n; i += 1) {
    const cx = w * 0.5 + (i - (n - 1) / 2) * bw * 1.5;
    const lift = Math.sin(Math.PI * (i / (n - 1 || 1))) * h * 0.012;
    ctx.fillStyle = withAlpha(pal.stoneDeep, 0.8);
    ctx.beginPath();
    ctx.moveTo(cx - bw / 2, y - bw * 0.6 - lift);
    ctx.lineTo(cx + bw / 2, y - bw * 0.6 - lift);
    ctx.lineTo(cx + bw / 2, y + bw * 0.12 - lift);
    ctx.quadraticCurveTo(cx, y + bw * 0.62 - lift, cx - bw / 2, y + bw * 0.12 - lift);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = withAlpha(forge.gold, 0.6);
    ctx.lineWidth = Math.max(1, w / 1400);
    ctx.stroke();
  }
  ctx.restore();
}

function vignette(ctx: SceneCtx, size: SceneSize, pal: ScenePalette): void {
  const { w, h } = size;
  const g = ctx.createRadialGradient(
    w / 2,
    h * 0.48,
    Math.min(w, h) * 0.22,
    w / 2,
    h * 0.5,
    w * 0.8,
  );
  g.addColorStop(0, withAlpha("#000000", 0));
  g.addColorStop(1, withAlpha("#000000", 0.62));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Stone grain. One fixed scatter, so it never shimmers while the reader scrolls.
  const rand = prng(91);
  ctx.fillStyle = withAlpha(material.marble, 0.05);
  for (let i = 0; i < 160; i += 1) ctx.fillRect(rand() * w, rand() * h, 1, 1);
}

/**
 * One narrow cast, in one place, on purpose.
 *
 * The real context's `fillStyle` is `string | CanvasGradient | CanvasPattern`; the scene only
 * ever *writes* a string or a gradient to it and never reads it back, so the wider union is
 * safe to narrow here. Doing it in a named adapter keeps the guarantee in a single line that
 * can be argued with, instead of scattering `as unknown as` across call sites where a future
 * incompatibility would be invisible.
 */
export function asSceneCtx(ctx: CanvasRenderingContext2D): SceneCtx {
  return ctx as unknown as SceneCtx;
}

/**
 * Draw one frame of the sequence. The host calls this when a published sample moves, when the
 * buffer is resized, and when the data being narrated changes — there is no clock in the scene
 * for it to be called on.
 */
export function drawScene(ctx: SceneCtx, size: SceneSize, input: SceneInput): void {
  const p = clamp01(input.progress);
  const crowd = clamp01(input.crowd ?? 0);
  const pal = scenePalette(p, input.mark ?? "none");

  // One pair around the whole frame. Layers early-return out of the middle of a band, and a
  // layer that set an alpha before bailing would otherwise tint whatever came next. Isolating
  // each frame means the drawing at 0.62 is the same drawing whether you scrolled there from
  // 0.10 or from 0.95 — which is the property the HUD counter is implicitly promising.
  ctx.save();
  sky(ctx, size, pal, p);
  skyline(ctx, size, pal, p);
  exterior(ctx, size, pal, p);
  passage(ctx, size, pal, p);
  interior(ctx, size, pal, p, crowd);
  shafts(ctx, size, pal, p);
  dust(ctx, size, pal, p);
  banners(ctx, size, pal, p);
  pulvinar(ctx, size, pal, p);
  seal(ctx, size, pal, p, input.seal ?? "V");
  shields(ctx, size, pal, p, Math.round(3 + crowd * 5));
  vignette(ctx, size, pal);
  ctx.restore();
}
