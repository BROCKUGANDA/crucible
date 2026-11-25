import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatBps } from "../src/lib/useEvidenceBundles";

/**
 * The page a committee reads when it decides whether money moves.
 *
 * Two rules carry the weight here, and both are asserted against the
 * source, because there is no React renderer in this workspace: the
 * gaps are shown BEFORE the contents, and a score that was never recorded
 * shows an em dash and not a zero.
 *
 * The em dash is the first rule of this repository's display layer:
 * "a figure is read or it is not shown". A bundle with no aggregate score
 * that renders `0.0%` is a bundle that says the trial scored nothing,
 * which is a claim about the trial and not about the bundle.
 */

const PAGE = readFileSync(
  fileURLToPath(new URL("../src/app/disputes/[trialId]/dispute-evidence.tsx", import.meta.url)),
  "utf8",
);

describe("the dispute evidence page", () => {
  it("shows what the bundle does NOT contain before what it contains", () => {
    const gaps = PAGE.indexOf("What this bundle does not contain");
    const chain = PAGE.indexOf("What the chain said");
    const measured = PAGE.indexOf("What the platform measured");
    expect(gaps, "the page no longer names the gaps").toBeGreaterThan(-1);
    expect(chain, "the page no longer names the chain facts").toBeGreaterThan(-1);
    expect(measured, "the page no longer names the measurement").toBeGreaterThan(-1);
    // A reader who sees "the sponsor has not disclosed the suite" first will
    // read the rest accordingly. That is the point of the order.
    expect(gaps).toBeLessThan(chain);
    expect(gaps).toBeLessThan(measured);
  });

  it("states the gaps in the bundle itself, not in a comment", () => {
    // The gaps are rendered from the bundle's own contents — the component
    // must not carry a hand-written list, which could disagree with the
    // evidence it sits next to.
    expect(PAGE).toContain("detail.bundle.gaps");
    expect(PAGE).toContain('data-testid="bundle-gaps"');
  });

  it("shows a score that was never recorded as an em dash and not a zero", () => {
    expect(formatBps(null)).toBe("—");
    expect(formatBps(undefined)).toBe("—");
    expect(formatBps(Number.NaN)).toBe("—");
    expect(formatBps(0)).toBe("0.0%");
  });

  it("does not say a bundle predates the break unless the chain said so", () => {
    // "Unknown" is rendered as its own sentence, not as a yes or a no.
    expect(PAGE).toContain("the chain has not said when the dispute opened");
    expect(PAGE).toContain("sealed before the break");
    expect(PAGE).toContain("sealed after the break");
  });
});
