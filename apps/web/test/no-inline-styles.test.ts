import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The separation-of-concerns gate.
 *
 * Inline styles were the single largest structural complaint about this app: two hundred-plus
 * places where a component decided its own spacing and colour, so the design system could not
 * be changed, only argued with, and a strict `style-src` was impossible because every page
 * carried its own style attribute.
 *
 * The rule is absolute rather than "prefer", because a threshold that permits a few is a
 * threshold that keeps the few it permits forever. Values that genuinely vary at runtime move
 * to CSS custom properties written through `element.style.setProperty` (CSSOM, which CSP does
 * not police the way it polices markup) or to `data-*` attributes selected by CSS.
 */

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const stats = statSync(full);
    if (stats.isDirectory()) out.push(...sources(full));
    else if (entry.endsWith(".tsx") || entry.endsWith(".jsx")) out.push(full);
  }
  return out;
}

function findInlineStyles(root: string) {
  const findings: { file: string; line: number; text: string }[] = [];
  for (const file of sources(root)) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, i) => {
      // `style={{ ... }}` is the React form; `style="..."` is the HTML form. Both are markup
      // carrying presentation the stylesheet is supposed to own.
      if (/style\s*=\s*\{/.test(text) || /\bstyle\s*=\s*["']/.test(text)) {
        findings.push({ file: file.replace(root, "src"), line: i + 1, text: text.trim().slice(0, 90) });
      }
    });
  }
  return findings;
}

describe("separation of concerns", () => {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const findings = findInlineStyles(root);

  it("scans real files, so an empty list cannot come from a bad path", () => {
    const scanned = sources(root);
    expect(scanned.length).toBeGreaterThan(20);
    // Every component in the app must be reachable from the walk, or the gate is measuring a
    // directory nobody renders.
    expect(scanned.some((f) => f.endsWith("Chrome.tsx"))).toBe(true);
    expect(scanned.some((f) => f.endsWith("page.tsx"))).toBe(true);
  });

  it("no component carries a style attribute", () => {
    const summary = findings
      .slice(0, 25)
      .map((f) => `${f.file}:${f.line}  ${f.text}`)
      .join("\n");
    expect(
      findings,
      `${findings.length} inline style attributes remain (first 25 shown):\n${summary}`,
    ).toEqual([]);
  });
});
