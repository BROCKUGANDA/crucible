import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The landing HUD publishes no operator balance.
 *
 * Gate 438's lesson, applied to a different promise: this repo has no React renderer, so a
 * rendered claim is checked by reading the source that produces it — the same method
 * `demo-notice.test.ts` and `no-inline-styles.test.ts` use. Here the claim is the owner's
 * 2026-10-27 instruction: the site must not show the treasury or "how much I have".
 *
 * The scan strips comments first, because AGENTS.md records the exact failure mode this avoids:
 * a wiring check written over a file's prose stays green after the code it describes is gone —
 * and these files deliberately *explain* the removed figures in their comments, so a naive
 * substring scan would be red on the explanation of the fix.
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(join(here, "..", "src", rel), "utf8");

/** Line and block comments removed; strings and JSX kept. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

describe("the landing money display", () => {
  it("renders no treasury or fee balance cell", () => {
    const hud = code(src("components/scrub/ScrubHud.tsx"));
    expect(hud).not.toMatch(/<dt>\s*(Treasury|Fees|Take)\s*<\/dt>/i);
    expect(hud).toMatch(/<dt>\s*Fee\s*<\/dt>/);
    // A balance cell is a number carrying a unit; the HUD gets its figures from props, so the
    // presence of the formatter here is how one would sneak back in.
    expect(hud).not.toMatch(/formatEth/);
  });

  it("derives no ETH amount in the landing's view model", () => {
    const facts = code(src("lib/scrub/arenaFacts.ts"));
    expect(facts).not.toMatch(/feesEth|treasuryCreditEth/);
    expect(facts).not.toMatch(/import\s*\{[^}]*\bformatEth\b[^}]*\}\s*from/);
    expect(facts).toMatch(/feeBps/);
  });

  it("keeps the assay page's books free of the operator's cumulative fee", () => {
    const assay = code(src("app/assay/page.tsx"));
    expect(assay).not.toMatch(/Fees kept/);
    expect(assay).toMatch(/The fee the chain charges/);
    const ops = code(src("lib/ops.ts"));
    expect(ops).not.toMatch(/fees:\s*formatEth/);
  });
});
