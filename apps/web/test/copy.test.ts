import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The live pages are for a visitor, not for the builder. These are the phrases that made a
 * reader stop and decode instead of read, kept out of the rendered strings. Comments are
 * stripped first: the code is allowed to explain the old vocabulary, the page is not.
 */
const PAGES = [
  "../src/app/page.tsx",
  "../src/app/agents/page.tsx",
  "../src/app/agents/[id]/page.tsx",
  "../src/app/hall/page.tsx",
  "../src/app/bounties/page.tsx",
  "../src/app/forge/page.tsx",
  "../src/app/escrow/page.tsx",
  "../src/lib/escrow/view.ts",
  "../src/components/Chrome.tsx",
];

function visibleSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("live copy", () => {
  it("keeps the reader-facing pages free of the old builder vocabulary", () => {
    const banned = /soulbound|Lost slag|proven lie|\bscars\b|half-life|minted from outcomes|Hall of Alloy|No smiths registered/i;
    for (const path of PAGES) {
      expect(visibleSource(path), path).not.toMatch(banned);
    }
  });

  it("states the settlement and custody boundary in plain words", () => {
    const landing = visibleSource("../src/app/page.tsx");
    expect(landing).toContain("non-transferable");
    expect(landing).toContain("cannot be sold or borrowed");
    expect(landing).toContain("fades gradually");
  });
});
