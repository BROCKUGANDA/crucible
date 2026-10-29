import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The contrast gate: the claim is computed from the tokens, not eyeballed.
 *
 * The 2026-10-29 browser audit measured the verdict/slash red `#cf4132` at **3.96:1** on the card
 * surface and **4.20:1** on the page ground, at 13.9px/400 weight, and Tyrian `#7a2b56` at
 * **2.17:1**. WCAG AA asks 4.5:1 for text that small, so a reader looking at "Broken" — the word
 * that carries the whole verdict — was looking at text the palette failed. The audit's numbers are
 * reproduced below with this file's own maths before anything is asserted about the new values:
 * if the implementation did not agree with the measurement, the gate would be measuring nothing.
 *
 * The values are read out of `src/styles/tokens.css` — the one palette — with CSS comments
 * stripped first, because this file's own prose now *names* the rejected hexes and a gate that
 * grepped the file as text would pass on the description of the bug.
 *
 * Pairs are limited to colours this stylesheet actually paints as **text** on the two grounds it
 * paints on: `--bg0` (the page) and `--bg1` (`.surface`, i.e. every card). `--bg2` is borders and
 * hover, not a text ground, and `--ink` is the ink a bright *fill* writes with — checked the other
 * way round at the bottom.
 */

const tokensSource = readFileSync(
  fileURLToPath(new URL("../src/styles/tokens.css", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

/** Declarations only. A comment that quotes `--sear: #000000;` must not satisfy a token lookup. */
function declarations(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const CODE = declarations(tokensSource);

function token(name: string): string {
  const m = CODE.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
  if (!m) throw new Error(`--${name} is not declared in tokens.css — the gate has no value to read`);
  return m[1]!;
}

/** WCAG 1.4.3's relative luminance: sRGB channels linearised, then weighted. */
function relativeLuminance(hex: string): number {
  const h = hex.trim().replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const channels = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** The contrast ratio of two opaque colours, lighter first so the order of arguments is not a bug. */
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const BG0 = token("bg0");
const BG1 = token("bg1");
const AA_SMALL = 4.5;

/** Small text in these colours, on these grounds — each pair is a rule in `src/styles/`. */
const TEXT_ON_GROUND: [string, string, string][] = [
  ["sear", "bg0", "[data-tone=\"sear\"] (base.css) — verdicts, alerts, `Doused.`"],
  ["sear", "bg1", ".trial-row__verdict / .field-error on .surface — the audit's 3.96:1 case"],
  ["error", "bg0", ".badge--error, .metric-card__value--error"],
  ["error", "bg1", "the same badges on a card"],
  ["bronze", "bg0", ".hall-row__numeral on the page ground"],
  ["bronze", "bg1", ".hall-row__rank inside a .surface"],
  ["tyrian", "bg0", "the scene's sovereign accent over the night ground — the audit's 2.17:1 case"],
  ["tyrian", "bg1", "the same accent against a card"],
  ["ember", "bg0", "the action colour, as text"],
  ["gold", "bg1", "rewards and values on a card"],
  ["quench", "bg1", "verified/reprieve text on a card"],
  ["ash", "bg1", "the muted step, e.g. the environment chip"],
  ["faint", "bg1", ".field > label — the smallest label in the app"],
  ["dim", "bg1", "body copy on a card"],
  ["text", "bg1", "marble body copy on a card"],
];

describe("the contrast maths, against the audit's own numbers", () => {
  it("knows black on white and a colour on itself", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#000000")).toBe(0);
  });

  it("reproduces the three ratios the 2026-10-29 audit published", () => {
    // Asserting the auditor's numbers against this implementation is what makes the rest of the
    // file a measurement rather than a tautology: 3.96:1 was the finding.
    expect(contrastRatio("#cf4132", "#151210")).toBeCloseTo(3.96, 2);
    expect(contrastRatio("#cf4132", "#0b0a09")).toBeCloseTo(4.2, 2);
    expect(contrastRatio("#7a2b56", "#0b0a09")).toBeCloseTo(2.17, 2);
  });

  it("parses the three- and six-digit forms the stylesheet uses", () => {
    expect(relativeLuminance("#fff")).toBeCloseTo(relativeLuminance("#ffffff"), 10);
    expect(contrastRatio("#000", "#FFF")).toBeCloseTo(21, 5);
  });
});

describe("the palette as declared, at the sizes it is used", () => {
  it.each(TEXT_ON_GROUND)("--%s on --%s clears AA for small text", (fgName, bgName, where) => {
    const ratio = contrastRatio(token(fgName), token(bgName));
    expect(
      ratio,
      `${where}: --${fgName} (${token(fgName)}) on --${bgName} (${token(bgName)}) is ${ratio.toFixed(2)}:1, AA asks ${AA_SMALL}:1`,
    ).toBeGreaterThanOrEqual(AA_SMALL);
  });

  it("keeps the ink legible on the fills that invert onto it", () => {
    // The other direction of the same rule: a button's label is `--ink` written on a hot fill,
    // and lightening a state colour quietly degrades *that* pair if nobody checks it.
    const ink = token("ink");
    for (const fill of ["ember", "gold", "hot", "sear"]) {
      const ratio = contrastRatio(ink, token(fill));
      expect(ratio, `--ink on --${fill} (${token(fill)}) is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_SMALL);
    }
  });

  it("fails on the values the audit rejected, so the gate cannot be re-satisfied by a revert", () => {
    // Pinned as numbers rather than as a comment: if a token is moved back to the old hex, the
    // test above goes red *and* this one records that the old value was never compliant.
    expect(contrastRatio("#cf4132", BG1)).toBeLessThan(AA_SMALL);
    expect(contrastRatio("#cf4132", BG0)).toBeLessThan(AA_SMALL);
    expect(contrastRatio("#7a2b56", BG0)).toBeLessThan(AA_SMALL);
    expect(contrastRatio("#8c6b3f", BG1)).toBeLessThan(AA_SMALL);
    // And the shipped tokens are not those values.
    expect(token("sear").toLowerCase()).not.toBe("#cf4132");
    expect(token("error").toLowerCase()).not.toBe("#cf4132");
    expect(token("tyrian").toLowerCase()).not.toBe("#7a2b56");
    expect(token("bronze").toLowerCase()).not.toBe("#8c6b3f");
  });

  it("holds --error and --sear as the one colour they are documented to be", () => {
    expect(token("error")).toBe(token("sear"));
    expect(token("info")).toBe(token("quench"));
    expect(token("pending")).toBe(token("faint"));
  });
});
