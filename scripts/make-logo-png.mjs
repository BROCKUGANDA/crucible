#!/usr/bin/env node
/**
 * make-logo-png.mjs — export the master mark as a high-resolution PNG for the
 * README, the submission page and anywhere else a raster of the logo is needed.
 *
 * It rasterises the same `public/crucible-mark.svg` the icon set derives from,
 * so there is no second source of truth to drift from. Run `npm run icons
 * --workspace @crucible/web` first if the SVG itself may be stale.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARK = path.join(ROOT, "apps/web/public/crucible-mark.svg");
const OG = path.join(ROOT, "apps/web/public/og.png");
const OUT_DIR = path.join(ROOT, "docs");

const svg = fs.readFileSync(MARK, "utf8");

// The mark at 1024: big enough for a slide, a README and a submission thumbnail.
const mark = new Resvg(svg, { fitTo: { mode: "width", value: 1024 } });
fs.writeFileSync(path.join(OUT_DIR, "logo.png"), mark.render().asPng());

// The social card already carries mark + wordmark; copy it beside the mark so the
// judges' assets live in one folder rather than half in public/ and half here.
fs.copyFileSync(OG, path.join(OUT_DIR, "logo-banner.png"));

console.log("docs/logo.png (1024px mark), docs/logo-banner.png (1200x630 card) written");
