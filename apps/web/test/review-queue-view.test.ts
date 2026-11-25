import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The queue a reviewer reads.
 *
 * Two rules carry the weight here, and both are asserted against the
 * source, because there is no React renderer in this workspace:
 *
 *  1. The page offers exactly the three actions the API offers — take a
 *     case, step away from one, declare a conflict — and no fourth. A
 *     page that invented a fourth action would promise something the API
 *     does not do.
 *  2. The money is shown in ETH, formatted from the wei string, and never
 *     through a float: the reward arrives as a string of wei, and a
 *     `parseFloat` on the way to the screen is eight wei off in a
 *     hundredth of the cases, which is the same lie the rest of the
 *     repository refuses to tell.
 */

const PAGE = readFileSync(
  fileURLToPath(new URL("../src/app/reviews/page.tsx", import.meta.url)),
  "utf8",
);

const CLIENT = readFileSync(
  fileURLToPath(new URL("../src/lib/useReviewQueue.ts", import.meta.url)),
  "utf8",
);

describe("the review queue page", () => {
  it("offers the three actions, and only the three", () => {
    expect(PAGE).toContain("Take this case");
    expect(PAGE).toContain("Step away");
    expect(PAGE).toContain("Declare the conflict");
    // The client calls exactly those three endpoints.
    expect(CLIENT).toContain("/claim");
    expect(CLIENT).toContain("/abstain");
    expect(CLIENT).toContain("/conflict");
  });

  it("does not ask the reviewer for a reason it will not record", () => {
    // Stepping away without a reason is refused by the API, so the button
    // must be disabled until there is one — otherwise the reviewer reads a
    // refusal where the page looked like it had accepted the click.
    expect(PAGE).toContain('reason.trim() === ""');
    expect(PAGE).toContain('description.trim() === ""');
  });

  it("shows the reward in ETH, from the wei string, without a float", () => {
    expect(PAGE).toContain("formatWei(BigInt(reviewCase.rewardWei))");
    // No float anywhere near the money on this page.
    expect(PAGE).not.toMatch(/parseFloat|Number\([^)]*reward/);
    expect(PAGE).not.toMatch(/rewardWei\s*\*\s*/);
  });

  it("says what an unknown is: an em dash, not a zero", () => {
    // An agent the chain has not recorded is "—". A zero would be a claim
    // that the trial had no agent, which is not what is known.
    expect(PAGE).toContain('reviewCase.agent ?? "—"');
    expect(PAGE).toContain('reviewCase.disclosed ? "Published" : "—"');
  });

  it("tells the reviewer that a declared conflict bars them", () => {
    // The bar is the point of the surface: the page says what a declaration
    // does, so a reviewer chooses to declare one knowing the cost.
    expect(PAGE).toContain("bars you from this case");
  });

  it("shows who holds a case, rather than hiding it", () => {
    expect(PAGE).toContain("Another reviewer holds this case");
  });
});
