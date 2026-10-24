import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CLAIMS } from "@/lib/claims/registry";

/**
 * The claim matrix is only worth publishing if it cannot drift into an advertisement.
 *
 * `/claims` renders `CLAIMS` verbatim, so the table is the page. These checks are what stop that
 * page becoming a list of adjectives: an `enforced` row has to name files that exist, an `absent`
 * row is not allowed to hide itself by being deleted, and the copy a claim quotes has to still be
 * the copy the site carries.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PAGE = fileURLToPath(new URL("../src/app/page.tsx", import.meta.url));
// JSX reflows sentences across lines, so the comparison is on collapsed whitespace:
// a paragraph break in the source is not a different sentence.
const pageCopy = readFileSync(PAGE, "utf8").replace(/\s+/g, " ").toLowerCase();

describe("the claim registry", () => {
  it("is never cited by a row that cannot produce the file", () => {
    const missing: string[] = [];
    for (const claim of CLAIMS) {
      for (const path of claim.enforcedBy) {
        if (!existsSync(new URL(`../../../${path}`, import.meta.url))) missing.push(`${claim.id} → ${path}`);
      }
    }
    expect(missing, `rows naming files that do not exist:\n  ${missing.join("\n  ")}`).toEqual([]);
    expect(ROOT.length).toBeGreaterThan(0);
  });

  it("does not label anything enforced without evidence behind the label", () => {
    for (const claim of CLAIMS.filter((c) => c.status === "enforced")) {
      expect(claim.enforcedBy.length, `${claim.id} is claimed enforced with nothing cited`).toBeGreaterThan(0);
    }
  });

  it("keeps at least one honest absence on the page", () => {
    // The strongest sign a matrix has gone decorative is that every row passes. This assertion is
    // deliberately awkward to satisfy: to clear it, a row has to be *fixed*, not relabelled.
    expect(CLAIMS.some((c) => c.status === "absent")).toBe(true);
    expect(CLAIMS.filter((c) => c.status === "absent").length).toBeGreaterThanOrEqual(3);
  });

  it("does not put words in the landing page's mouth", () => {
    // A row that says "the site promises X" has to be quoting the site. Anything else is a claim
    // about a sentence nobody wrote, which is the failure this whole table exists to avoid.
    const flagged = CLAIMS.filter((c) => c.onSite);
    expect(flagged.length, "no row is flagged as site copy, so this check checks nothing").toBeGreaterThan(5);
    for (const claim of flagged) {
      const head = claim.copy.replace(/\s+/g, " ").slice(0, 24).toLowerCase();
      expect(pageCopy, `${claim.id} quotes copy the landing page does not carry: "${head}"`).toContain(head);
    }
  });

  it("has one row per id, and every id is the shape the gates use", () => {
    const ids = CLAIMS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Z]{1,3}-\d+$/);
  });
});
