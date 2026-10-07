import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { forge } from "@/lib/forge";
import { material, mix, scenePalette, withAlpha } from "@/lib/scrub/palette";

/**
 * Two things are being held here.
 *
 * The colour maths is checked directly, because a `mix` that rounds wrong makes every gradient
 * in the scene subtly off and nothing would ever complain.
 *
 * The palette is then cross-checked against the stylesheet. `forge.ts` and `tokens.css` are two
 * files in two languages that must say the same thing, and every previous drift between them
 * showed up as a screen that looked fine until someone compared it to a button. This is the
 * only place that claim is enforced.
 */
const tokensSource = readFileSync(
  fileURLToPath(new URL("../src/styles/tokens.css", import.meta.url)),
  "utf8",
);

describe("scene colour maths", () => {
  it("returns the endpoints unchanged", () => {
    expect(mix("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mix("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mix("#ff8000", "#ff8000", 0.5)).toBe("#ff8000");
  });

  it("blends the middle honestly", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#123456", "#fedcba", 0)).toBe("#123456");
  });

  it("clamps out-of-range mixes instead of producing a negative channel", () => {
    for (const bad of [-5, 1.5, Number.NaN]) {
      const out = mix("#000000", "#ffffff", bad);
      expect(out).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("parses three-digit hex and ignores case and stray space", () => {
    expect(mix("#fff", "#000", 0)).toBe("#ffffff");
    expect(mix(" #FFF ", "#000", 1)).toBe("#000000");
    expect(mix("#fff", "#FFF", 0.5)).toBe("#ffffff");
  });

  it("emits rgba the canvas can actually consume", () => {
    expect(withAlpha("#ff5a00", 0.5)).toBe("rgba(255,90,0,0.500)");
    expect(withAlpha("#000000", 0)).toBe("rgba(0,0,0,0.000)");
    expect(withAlpha("#ffffff", 2)).toBe("rgba(255,255,255,1.000)");
    expect(withAlpha("#ffffff", -1)).toBe("rgba(255,255,255,0.000)");
  });

  it("never leaks an undefined channel into a colour string", () => {
    for (const junk of ["", "not-a-colour", "#12", "#zzzzzz"]) {
      const out = mix(junk, "#ffffff", 0.5);
      expect(out, `mix from ${junk}`).toMatch(/^#[0-9a-f]{6}$/);
      expect(out).not.toContain("NaN");
    }
  });
});

describe("the light ramp", () => {
  it("stays inside 0..1 and never throws at the ends", () => {
    for (const p of [-1, 0, 0.5, 1, 2, Number.NaN]) {
      const pal = scenePalette(p);
      for (const value of Object.values(pal)) {
        if (typeof value === "string") expect(value).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  });

  it("changes continuously as the reader scrolls, with no snapped steps", () => {
    const a = scenePalette(0.4);
    const b = scenePalette(0.4001);
    expect(a.stoneLit).toBe(b.stoneLit); // a hair of movement is below the rounding floor
    const c = scenePalette(0.45);
    expect(c.stoneLit).not.toBe(a.stoneLit);
  });

  it("keeps the sovereign accent fixed while everything else moves", () => {
    // Tyrian is the colour of the emperor's box. It should not be interpolating toward sunset.
    for (const p of [0, 0.3, 0.6, 0.9, 1]) expect(scenePalette(p).tyrian).toBe(material.tyrian);
  });

  it("only adopts the settlement's colour once the verdict is on screen", () => {
    expect(scenePalette(0.2, "slashed").mark).toBe(material.bronze);
    expect(scenePalette(0.95, "slashed").mark).not.toBe(material.bronze);
    expect(scenePalette(0.95, "paid").mark).not.toBe(scenePalette(0.95, "slashed").mark);
  });
});

describe("theme drift", () => {
  it("every state colour in forge.ts is declared in tokens.css", () => {
    const declared = new Set(
      [...tokensSource.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)].map(
        (m) => m[2]!.toUpperCase(),
      ),
    );
    const checked: [string, string][] = [
      ["ember", forge.ember],
      ["gold", forge.gold],
      ["hot", forge.hot],
      ["quench", forge.quench],
      ["sear", forge.sear],
      ["ash", forge.ash],
      ["text", forge.text.DEFAULT],
      ["dim", forge.text.dim],
      ["faint", forge.text.faint],
      ["bg0", forge.bg[0]],
      ["bg1", forge.bg[1]],
      ["bg2", forge.bg[2]],
    ];
    const missing = checked.filter(([, hex]) => !declared.has(hex.toUpperCase())).map(([name]) => name);
    expect(missing, `tokens.css does not declare: ${missing.join(", ")}`).toEqual([]);
  });

  it("every Roman material colour the scene paints is a declared token", () => {
    for (const [name, hex] of Object.entries(material)) {
      expect(
        tokensSource,
        `--${name} (${hex}) is missing from tokens.css, so the canvas and the theme disagree`,
      ).toMatch(new RegExp(`--${name}:\\s*${hex}`, "i"));
    }
  });
});
