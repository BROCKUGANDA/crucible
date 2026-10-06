#!/usr/bin/env node
/**
 * build-icons.mjs — the Crucible icon + media set, from ONE master mark.
 *
 * Re-runnable: `npm run icons --workspace @crucible/web`
 *
 * Everything here derives from the single `GEO` block below. There are no
 * hand-tweaked copies of the polygon: `favicon.svg`, `icon.svg`,
 * `icon-maskable.svg` and every PNG are composed from the same six numbers, so
 * the corner radii and stroke weights can no longer drift between files (they
 * had drifted: favicon used rx 14/64 = 0.219 while icon used 96/512 = 0.1875).
 *
 * Colours are READ from src/app/globals.css at build time, never typed out here.
 * If the theme agent changes `--ember`, regenerating follows them.
 *
 * Rasterisation is deterministic: @resvg/resvg-js with the brand fonts vendored
 * into scripts/fonts/. It does not touch system fonts, so the PNGs come out the
 * same on any machine and in CI. (`sharp` would work too but resolves text
 * through the host's fontconfig, which is not reproducible across machines.)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(WEB, "public");
const FONTS = path.join(WEB, "scripts", "fonts");

/* ------------------------------------------------------------------ tokens */

/** Parse `--name: #rrggbb;` out of globals.css. Never guess a brand colour. */
function readTokens() {
  const css = fs.readFileSync(path.join(WEB, "src", "app", "globals.css"), "utf8");
  const grab = (name) => {
    const m = css.match(new RegExp("--" + name + ":\\s*(#[0-9a-fA-F]{6})\\s*;", "m"));
    if (!m) throw new Error(`globals.css has no --${name} hex token — refusing to guess it`);
    return m[1].toLowerCase();
  };
  return { bg0: grab("bg0"), bg1: grab("bg1"), bg2: grab("bg2"), ember: grab("ember"), gold: grab("gold"), hot: grab("hot"), text: grab("text"), dim: grab("dim"), faint: grab("faint"), ash: grab("ash") };
}
const T = readTokens();

/* -------------------------------------------------------------------- fonts
 * Bricolage Grotesque (display) and JetBrains Mono (mono) are the families
 * globals.css names. They are vendored here as the official Google Fonts TTFs
 * (OFL.txt shipped beside them) so rasterising needs no network and no host
 * fonts. They are VARIABLE fonts; resvg renders the default instance and
 * ignores font-weight, so heaviness is forged with a same-colour stroke under
 * `paint-order:stroke` — see embolden() — rather than by swapping in a generic
 * bold. */
const FONT_FILES = [path.join(FONTS, "BricolageGrotesque-var.ttf"), path.join(FONTS, "JetBrainsMono-var.ttf")];
for (const f of FONT_FILES) if (!fs.existsSync(f)) throw new Error(`missing vendored font ${f}`);
const DISPLAY = "Bricolage Grotesque";
const MONO = "JetBrains Mono";

/**
 * Stroke-embolden a display-face run to approximate font-weight 800.
 * resvg renders a variable font's default instance and ignores font-weight, so
 * heaviness is forged by laying a same-colour stroke *under* the fill
 * (paint-order:stroke), which grows the outline outward by sw/2.
 */
const EMBOLDEN = 0.045;
const embolden = (size) => Math.max(1, size * EMBOLDEN);

/**
 * Tracking for an emboldened run. The brand tracks the wordmark tight at
 * -0.035em, but a stroke of sw adds sw of width between neighbours, so the
 * optical gap is recovered by putting sw back on: net = -0.035em + sw. Without
 * this the counters close and the letters fuse.
 */
const track = (size, em, sw) => n(-em * size + sw);

/* ---------------------------------------------------------------- geometry */
import { deflateSync } from "node:zlib";


/**
 * The master mark, on a 512 grid, in units. This is the whole brand: an
 * anvil-horn chevron rising out of the slag with an ember in its core.
 *   cx        centre line
 *   apexY     top point
 *   baseY     the two feet sit here
 *   halfBase  half the overall width at the base
 *   arm       arm thickness, measured horizontally at the base
 *   notchY    the inner apex — how deep the notch cuts
 * The polygon is a wedge, not a parallel stroke: it is thickest at the feet
 * and draws to a point at the apex. That taper is the anvil horn.
 */
const GEO = { size: 512, cx: 256, apexY: 96, baseY: 368, halfBase: 160, arm: 64, notchY: 160 };

/**
 * The ember, seated INSIDE the notch rather than straddling the feet line.
 * The shipped mark had it at cy 352 / r 36, which hangs 20u below the base, so
 * at 16px the dot fused with the floor into one warm smear. Measured against
 * candidates at 16 and 32px, cy 312 / r 30 keeps the dot a discrete core at both
 * sizes — it reads as heat suspended in the crucible.
 */
const EMBER = { cy: 312, r: 30 };

/** Plate corner radius, as a ratio of canvas — the canonical 0.1875. */
const PLATE_R = 0.1875;
/** Brand-frame inset and radius, as ratios of canvas. */
const FRAME = { inset: 0.03125, radius: 0.171875, stroke: 0.03125 };

function n(v) {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
}

/** The chevron polygon, emitted from GEO only. */
function chevron(g) {
  const p = [
    [g.cx, g.apexY],
    [g.cx - g.halfBase, g.baseY],
    [g.cx - g.halfBase + g.arm, g.baseY],
    [g.cx, g.notchY],
    [g.cx + g.halfBase - g.arm, g.baseY],
    [g.cx + g.halfBase, g.baseY],
  ];
  return "M" + p.map(([x, y]) => `${n(x)} ${n(y)}`).join(" ") + "Z";
}

/** Half the notch opening at height y — used to size the ember honestly. */
function notchHalfWidth(g, y) {
  return ((y - g.notchY) / (g.baseY - g.notchY)) * (g.halfBase - g.arm);
}

/**
 * The glyph as a group, scaled about the canvas centre. Derived files use a
 * transform instead of redrawing: scale 1 is the master. `ember: null` drops the
 * dot — that is the whole difference between the mark and its mono cut.
 */
function glyph(g, ember, scale, S) {
  if (ember) {
    const half = notchHalfWidth(g, ember.cy);
    const clearance = (half - ember.r) / half;
    if (clearance < 0.05) throw new Error(`ember dot would collide with the chevron arm (clearance ${clearance.toFixed(2)})`);
  }
  const h = S / 2;
  const shapes =
    `<path d="${chevron(g)}" fill="${T.ember}"/>` +
    (ember ? `<circle cx="${n(g.cx)}" cy="${n(ember.cy)}" r="${n(ember.r)}" fill="${T.gold}"/>` : "");
  if (scale === 1) return shapes;
  return `<g transform="translate(${n(h)} ${n(h)}) scale(${n(scale)}) translate(${n(-g.cx)} ${n(-g.cx)})">${shapes}</g>`;
}

/**
 * The tiny-size cut. Same silhouette, three honest changes, all of them
 * multipliers on GEO rather than a redraw:
 *   - the ember is dropped (a 30u dot is 0.9px at 16px — it can only smear)
 *   - the arms go 1.31x thicker so each leg clears one pixel
 *   - the stance widens and the notch shallows, so the two feet stay separate
 */
const MONO_SPEC = { arm: 1.31, halfBase: 1.1625, apexRise: 8, baseDrop: 28, notchDrop: 8 };
function monoGeo() {
  return {
    g: {
      cx: GEO.cx,
      apexY: GEO.apexY - MONO_SPEC.apexRise,
      baseY: GEO.baseY + MONO_SPEC.baseDrop,
      halfBase: Math.round(GEO.halfBase * MONO_SPEC.halfBase),
      arm: Math.round(GEO.arm * MONO_SPEC.arm),
      notchY: GEO.notchY + MONO_SPEC.notchDrop,
    },
    e: null,
  };
}

const svgOpen = (vbw, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vbw} ${vbw}" width="${vbw}" height="${vbw}" role="img">` +
  (title ? `<title>${title}</title>` : "");

const plate = (S, radius) => `<rect width="${n(S)}" height="${n(S)}"${radius ? ` rx="${n(radius)}"` : ""} fill="${T.bg0}"/>`;
const brandFrame = (S) =>
  `<rect x="${n(S * FRAME.inset)}" y="${n(S * FRAME.inset)}" width="${n(S * (1 - 2 * FRAME.inset))}" height="${n(S * (1 - 2 * FRAME.inset))}" rx="${n(S * FRAME.radius)}" fill="none" stroke="${T.ember}" stroke-width="${n(S * FRAME.stroke)}"/>`;

/* The mark's worst-case radius from the canvas centre, at scale 1. This single
   number drives every safe zone, so no file is padded "by eye". */
const MARK_EXTENT = Math.max(
  GEO.cx - GEO.apexY,
  Math.hypot(GEO.halfBase, GEO.baseY - 256),
  EMBER.cy + EMBER.r - 256
);

/* ------------------------------------------------------------------ files */

const S = 512;

/** canonical mark, transparent — the thing the media sheet shows on light/dark */
const markSvg = (g, e, scale, title) =>
  svgOpen(S, title) + glyph(g, e, scale, S) + `</svg>`;

/** icon.svg — the brand plate: charcoal rounded square, ember frame, mark. */
const iconSvg =
  svgOpen(S, "Crucible") + plate(S, S * PLATE_R) + brandFrame(S) + glyph(GEO, EMBER, 1, S) + `</svg>`;

/** favicon.svg — no rounded-mask treatment is applied to SVG favicons, so the
 *  plate is a full-bleed square and the mark is scaled to stay inside the
 *  inscribed circle (it must read in a square AND a circle). The brand frame is
 *  dropped: at 16px a 0.5px rule is mush, and a square frame clipped by a circle
 *  reads as damage rather than design. */
const FAVICON_SAFE = 0.81;
const FAVICON_SCALE = Math.floor(((S / 2) * FAVICON_SAFE) / MARK_EXTENT * 1000) / 1000;
const faviconSvg =
  svgOpen(S, "Crucible") +
  plate(S, 0) +
  glyph(GEO, EMBER, FAVICON_SCALE, S) +
  `</svg>`;

/** icon-maskable.svg — the platform crops this. Full-bleed charcoal bleeding to
 *  every edge, mark pulled inside the central 80% safe zone (0.60 of canvas for
 *  a 512 circle). No frame: it would be cropped away. The 0.94 is optical slack
 *  so the mark is not exactly tangent to the crop circle on any launcher. */
const SAFE_RATIO = 0.6;
const OPTICAL_SLACK = 0.94;
const MASKABLE_SCALE = Math.floor(((((S * SAFE_RATIO) / 2) / MARK_EXTENT) * OPTICAL_SLACK * 1000)) / 1000;

/* apple-touch-icon: iOS masks the tile into its own squircle and ignores SVG
   favicons outright, so this is a real opaque PNG on a full-bleed plate with the
   frame dropped. Airier than the favicon (0.70 of the radius vs 0.81) because a
   180px tile has room to breathe and a 16px tab does not. */
const APPLE_SAFE = 0.7;
const APPLE_SCALE = Math.floor(((S / 2) * APPLE_SAFE) / MARK_EXTENT * 1000) / 1000;
const maskableSvg =
  svgOpen(S, "Crucible") + plate(S, 0) + glyph(GEO, EMBER, MASKABLE_SCALE, S) + `</svg>`;

/* --------------------------------------------------------------- social card */

const OG = { w: 1200, h: 630 };

/** Measure how wide a run actually rasterises, so rules and columns can be cut
 *  to the type instead of guessed. Returns ink width in device px. */
function measureRun(text, family, size, attrs) {
  const w = Math.ceil(size * 16);
  const h = Math.ceil(size * 3);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="${T.bg0}"/>` +
    `<text x="8" y="${h * 0.7}" font-family="${family}" font-size="${size}" fill="${T.hot}" ${attrs}>${text}</text></svg>`;
  const box = inkBox(rasterise(svg, w));
  if (!box) throw new Error(`measureRun: "${text}" rendered no ink — is the font registered?`);
  return box.w;
}

/**
 * Fit a run to a target ink width. Both the emboldening stroke and the tracking
 * are defined in ems, so the advance is exactly linear in font-size and one
 * probe at 100px is enough — no search, no eyeballing.
 */
function fitSize(text, family, targetW, attrsAt) {
  const per100 = measureRun(text, family, 100, attrsAt(100));
  return (targetW * 100) / per100;
}

/**
 * The card is composed, not screenshotted: flat --bg0 ground, a cold --bg2
 * plate up the right edge and along the floor (the foundry slab), the mark in
 * its cell, then the type column. The only gradient is the brand's own molten
 * rule, used as a rule and as the wordmark fill — never as a wash.
 */
function ogSvg() {
  const pad = 96;
  const markW = 220; // the mark's own rendered width, not a padded cell
  const gap = 60;
  const markX = pad;
  const textX = pad + markW + gap;
  const availW = OG.w - pad - textX;
  const wordAttrs = (size) => `letter-spacing="${track(size, 0.035, embolden(size))}" stroke="url(#molten)" stroke-width="${n(embolden(size))}" paint-order="stroke"`;
  const word = fitSize("CRUCIBLE", DISPLAY, availW, wordAttrs);
  const wordW = availW;
  const markCy = 338;
  const s = markW / (2 * GEO.halfBase);
  const t = `translate(${n(markX + markW / 2)} ${n(markCy)}) scale(${n(s)}) translate(-${n(GEO.cx)} -${n(GEO.cx)})`;
  const kickerY = 176;
  const wordY = 330;
  const ruleY = 368;
  const tagY = [428, 468, 508];
  const tags = ["A proving ground for AI agents.", "Reputation mints only from outcomes", "that survived."];

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${OG.w} ${OG.h}" width="${OG.w}" height="${OG.h}" role="img">`,
    `<title>Crucible — a proving ground for AI agents</title>`,
    `<defs><linearGradient id="molten" x1="0" y1="0" x2="1" y2="0">`,
    `<stop offset="0" stop-color="${T.ember}"/>`,
    `<stop offset="0.55" stop-color="${T.gold}"/>`,
    `<stop offset="1" stop-color="${T.hot}"/>`,
    `</linearGradient></defs>`,
    `<rect width="${OG.w}" height="${OG.h}" fill="${T.bg0}"/>`,
    `<rect x="${OG.w - 12}" y="0" width="12" height="${OG.h}" fill="${T.bg2}"/>`,
    `<rect x="0" y="${OG.h - 12}" width="${OG.w}" height="12" fill="${T.bg2}"/>`,
    `<g transform="${t}">`,
    `<path d="${chevron(GEO)}" fill="${T.ember}"/>`,
    `<circle cx="${n(GEO.cx)}" cy="${n(EMBER.cy)}" r="${n(EMBER.r)}" fill="${T.gold}"/>`,
    `</g>`,
    `<text x="${n(textX)}" y="${kickerY}" font-family="${MONO}" font-size="21" letter-spacing="4.2" fill="${T.faint}">TRUST IS EARNED UNDER HEAT</text>`,
    `<text x="${n(textX)}" y="${wordY}" font-family="${DISPLAY}" font-size="${n(word)}" fill="url(#molten)" ${wordAttrs(word)}>CRUCIBLE</text>`,
    `<rect x="${n(textX)}" y="${ruleY}" width="${n(wordW)}" height="5" fill="url(#molten)"/>`,
    ...tagY.map((y, i) => `<text x="${n(textX)}" y="${y}" font-family="${MONO}" font-size="26" fill="${T.dim}">${tags[i]}</text>`),
    `</svg>`,
  ].join("");
}

/* ------------------------------------------------------------------ render */

function rasterise(svg, width) {
  const resvg = new Resvg(svg, {
    font: { fontFiles: FONT_FILES, defaultFontFamily: MONO, loadSystemFonts: false },
    fitTo: { mode: "width", value: width },
  });
  const im = resvg.render();
  return {
    width: im.width,
    height: im.height,
    pixels: Buffer.from(im.pixels),
    /* resvg's own encoder for the real deliverables; the raw pixels are only
       needed for the nearest-neighbour probe blow-ups below. */
    png: Buffer.from(im.asPng()),
  };
}

/** Ink bounding box of an RGBA buffer — real legibility measurement, not vibes.
 *  "Ink" is anything hotter than the coldest plate steel: --bg0 (lum 9) and
 *  --bg2 (lum 23) read as ground, so the 40 threshold excludes both and keeps
 *  every ember, gold and text tone. */
function inkBox(im, alphaMin = 8) {
  const { width: w, height: h, pixels: p } = im;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (p[i + 3] < alphaMin) continue;
    const lum = 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
    if (lum < 40) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Nearest-neighbour blow-up so a 16px mark can be eyeballed at 160px. */
function upscale(im, k) {
  const { width: w, height: h, pixels: p } = im;
  const out = Buffer.alloc(w * k * h * k * 4);
  for (let y = 0; y < h * k; y++) for (let x = 0; x < w * k; x++) {
    const s = (((y / k) | 0) * w + ((x / k) | 0)) * 4;
    const d = (y * w * k + x) * 4;
    out.writeUInt32BE(p.readUInt32BE(s), d);
  }
  return { buf: PNG.encode(w * k, h * k, out), w: w * k, h: h * k };
}

/* Minimal PNG writer, so the 16px probes can be nearest-neighbour scaled by
   hand rather than trusting a viewer's smoothing. resvg gives us RGBA; we
   re-encode with no filtering (filter byte 0 per scanline) + zlib. */
const PNG = (() => {
  const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  function encode(w, h, rgba) {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
  }
  return { encode };
})();

/* ------------------------------------------------------------------- write */

/** Every file this script owns, so the media sheet's manifest table is measured
 *  from the build rather than transcribed into it. */
const assets = [];
let mediaStatus = "";

function out(file, data, meta = {}) {
  const p = path.join(PUBLIC, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  assets.push({
    file,
    kind: meta.kind || (file.endsWith(".svg") ? "svg" : file.endsWith(".png") ? "png" : "text"),
    dims: meta.dims || "—",
    bytes: data.length,
    note: meta.note || "",
  });
}

const { g: MG, e: ME } = monoGeo();

const SVG_DIMS = "512 × 512 vb";
out("crucible-mark.svg", markSvg(GEO, EMBER, 1, "Crucible mark"), { dims: SVG_DIMS, note: "master mark, transparent — the geometry everything else derives from" });
out("crucible-mark-mono.svg", markSvg(MG, ME, 1, "Crucible mark, simplified for small sizes"), { dims: SVG_DIMS, note: "tiny-size cut — ember dropped, arms 1.31x, stance widened" });
out("favicon.svg", faviconSvg, { dims: SVG_DIMS, note: "full-bleed plate, mark at 1.061x, no frame: survives a square AND a circle" });
out("icon.svg", iconSvg, { dims: SVG_DIMS, note: "the brand plate — rounded charcoal, ember frame, canonical mark" });
out("icon-maskable.svg", maskableSvg, { dims: SVG_DIMS, note: "purpose maskable — mark inside the 60% safe zone, bleed to all edges" });

/* PNGs. The maskable pair is generated from the maskable SVG, so the safe zone
   is real geometry rather than a re-labelled normal icon. */
const pngs = [];
function png(name, svg, width, note) {
  const im = rasterise(svg, width);
  out(name, im.png, { dims: `${im.width} × ${im.height}`, note });
  pngs.push({ name, dims: `${im.width}x${im.height}`, bytes: im.png.length });
}

png("icon-192.png", iconSvg, 192, "manifest purpose any — small launcher slot");
png("icon-512.png", iconSvg, 512, "manifest purpose any — Play Store / A2HS hero");
png("icon-maskable-192.png", maskableSvg, 192, "manifest purpose maskable — cropped by the platform");
png("icon-maskable-512.png", maskableSvg, 512, "manifest purpose maskable — cropped by the platform");
/* iOS ignores SVG favicons entirely and masks this into its own squircle, so it
   is a real opaque PNG on a full-bleed plate — transparency would show black. */
png("apple-touch-icon.png", svgOpen(S, "Crucible") + plate(S, 0) + glyph(GEO, EMBER, APPLE_SCALE, S) + `</svg>`, 180, "apple-touch-icon — iOS wants a real PNG at 180");

/* The OG card. */
const og = rasterise(ogSvg(), OG.w);
out("og.png", og.png, { dims: `${og.width} × ${og.height}`, note: "social card, rendered from an authored SVG — no browser, no screenshot" });

/* Legibility probes: the two marks rasterised at 16px, then blown up 10x with
   no smoothing, so "does the ember survive" can be answered by looking. */
const probes = [];
for (const [key, svg] of [["favicon", faviconSvg], ["mark", markSvg(GEO, EMBER, 1, "")], ["mono", markSvg(MG, ME, 1, "")]]) {
  for (const px of [16, 32]) {
    const im = rasterise(svg, px);
    const big = upscale(im, 10);
    out(`media/probe-${key}-${px}.png`, big.buf, { dims: `${big.w} × ${big.h}`, note: `PROOF ONLY — ${key} rasterised at ${px}px, blown up x10 nearest-neighbour` });
    const box = inkBox(im);
    probes.push({ probe: `${key}@${px}`, rendered: `${im.width}x${im.height}`, inkBox: box ? `${box.w}x${box.h}` : "NO INK", blownUp: `${big.w}x${big.h}` });
  }
}

/* ---------------------------------------------------------------- manifest */

const manifest = {
  name: "Crucible — trust is earned under heat",
  short_name: "Crucible",
  description: "A proving ground for AI agents: stake a bond, do the work, keep only what survives.",
  id: "/",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "any",
  background_color: T.bg0,
  theme_color: T.ember,
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
    { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    { src: "/crucible-mark.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
  ],
};
out("manifest.webmanifest", JSON.stringify(manifest, null, 2) + "\n", {
  kind: "webmanifest",
  dims: "—",
  note: "name/short_name, start_url /, display standalone, colours from globals.css, any + maskable icons",
});

/* ------------------------------------------------- media sheet injection */

const MEDIA_HTML = path.join(PUBLIC, "media", "index.html");
const SMALL = [16, 32, 48, 128];

/** The rows the sheet must show. `big` is the size it is drawn at 1:1. */
const SHEET_ROWS = [
  { file: "crucible-mark.svg", sub: "master mark · transparent", big: 512 },
  { file: "crucible-mark-mono.svg", sub: "tiny-size cut · ember dropped", big: 512 },
  { file: "favicon.svg", sub: "full-bleed plate · no frame", big: 512 },
  { file: "icon.svg", sub: "brand plate + ember frame", big: 512 },
  { file: "icon-maskable.svg", sub: "purpose maskable · 60% safe zone", big: 512 },
  { file: "apple-touch-icon.png", sub: "iOS ignores SVG favicons", big: 180 },
  { file: "icon-192.png", sub: "purpose any", big: 192 },
  { file: "icon-512.png", sub: "purpose any", big: 512 },
  { file: "icon-maskable-192.png", sub: "purpose maskable", big: 192 },
  { file: "icon-maskable-512.png", sub: "purpose maskable", big: 512 },
];

const cell = (file, px, ground) =>
  `<td class="cell"><span class="ground ${ground}"><img src="../${file}" width="${px}" height="${px}" alt=""></span></td>`;
const matrixRow = (r, ground) =>
  `        <tr><td class="rowhead">${r.file}<span>${r.sub}</span></td>${SMALL.map((px) => cell(r.file, px, ground)).join("")}</tr>`;
const figure = (r) =>
  `    <figure><div class="pair">${["dark", "light"].map((g) => `<span class="ground ${g}"><img src="../${r.file}" width="${r.big}" height="${r.big}" alt=""></span>`).join("")}</div>` +
  `<figcaption><b>${r.file}</b>${r.sub} · both grounds, drawn 1:1 at ${r.big}px</figcaption></figure>`;

const fileRow = (a) =>
  `        <tr><td>${a.file}</td><td>${a.kind}</td><td>${a.dims}</td><td class="n">${a.bytes.toLocaleString("en-US")}</td><td class="purpose">${a.note}</td></tr>`;

function inject(html, key, body) {
  const re = new RegExp(`(<!--\\s*@begin:${key}\\s*-->)[\\s\\S]*?(<!--\\s*@end:${key}\\s*-->)`);
  if (!re.test(html)) throw new Error(`media/index.html is missing its @${key} markers`);
  return html.replace(re, `$1\n${body}\n        $2`);
}

if (fs.existsSync(MEDIA_HTML)) {
  let html = fs.readFileSync(MEDIA_HTML, "utf8");
  html = inject(html, "dark", SHEET_ROWS.map((r) => matrixRow(r, "dark")).join("\n"));
  html = inject(html, "light", SHEET_ROWS.map((r) => matrixRow(r, "light")).join("\n"));
  html = inject(html, "big", SHEET_ROWS.map(figure).join("\n"));
  html = inject(html, "files", assets.map(fileRow).join("\n"));
  fs.writeFileSync(MEDIA_HTML, html);

  /* The sheet must open from file:// with nothing to fetch, so fail the build on
     any absolute, protocol or off-directory reference rather than shipping a
     page that silently shows broken images offline. */
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  const bad = refs.filter((r) => /^(https?:)?\/\//.test(r) || r.startsWith("/") || /@import|fonts\.googleapis|cdn/i.test(r));
  if (bad.length) throw new Error(`media/index.html has network-dependent refs: ${bad.join(", ")}`);
  const missing = refs.filter((r) => !fs.existsSync(path.join(PUBLIC, "media", r)));
  if (missing.length) throw new Error(`media/index.html references files that do not exist: ${missing.join(", ")}`);
  mediaStatus = `injected + link-checked (${refs.length} refs, all local)`;
} else {
  mediaStatus = "SKIPPED — public/media/index.html not found";
}

/* ------------------------------------------------------------------ report */

console.log("tokens read from globals.css:", JSON.stringify(T));
console.log(`MARK_EXTENT (radius at scale 1) = ${MARK_EXTENT.toFixed(1)}u`);
console.log(`favicon mark scale ${FAVICON_SCALE} -> ${MARK_EXTENT * FAVICON_SCALE <= S / 2 ? "fits" : "OVERFLOWS"} the inscribed circle (${(MARK_EXTENT * FAVICON_SCALE).toFixed(1)} <= ${S / 2})`);
console.log(`maskable mark scale ${MASKABLE_SCALE} -> safe zone ${(MARK_EXTENT * MASKABLE_SCALE).toFixed(1)}u <= ${((S * SAFE_RATIO) / 2).toFixed(1)}u`);
const ogBox = inkBox(og);
console.log(`og.png ${og.width}x${og.height} ink box ${JSON.stringify(ogBox)}`);
if (!ogBox) throw new Error("og.png has no ink");
if (ogBox.x1 > OG.w - 12 || ogBox.y1 > OG.h - 12) throw new Error("og.png ink runs under the steel edge - the type does not fit");
console.table(pngs);
console.table(probes);
console.log("media/index.html:", mediaStatus);
console.log("wrote " + assets.length + " files");
