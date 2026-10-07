/**
 * Roman display conventions. Pure string work — no colours, no React, nothing to mock.
 *
 * This exists so the contract's numbers (tiers 0-4, act indices, trial ids) never appear
 * raw in JSX. The enum ordinal is a machine fact; `III` is a reader-facing one, and the two
 * belong in different files.
 */

const UNITS: readonly [number, string][] = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
] as const;

/**
 * 1..3999. Anything outside that range returns the decimal digits instead of lying: a fake
 * numeral on a leaderboard is exactly the kind of plausible-but-wrong read this project has
 * been hunted for.
 */
export function roman(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > 3999) return String(value);
  let n = value;
  let out = "";
  for (const [amount, glyph] of UNITS) {
    while (n >= amount) {
      out += glyph;
      n -= amount;
    }
  }
  return out;
}

/** Tiers are 0-indexed on the contract and 1-indexed for a reader. null is unread, not zero. */
export function tierNumeral(tier: number | null): string | null {
  if (tier === null || !Number.isInteger(tier) || tier < 0) return null;
  return roman(tier + 1);
}

/**
 * The interpunct is the Roman word separator. Joining parts with `·` turns a string of
 * labels into an inscription, which is what the act rails and the hall headers are.
 * Empty parts are dropped, so an unread field disappears rather than printing a gap.
 */
export function inscription(parts: readonly (string | null | undefined)[]): string {
  return parts
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p))
    .join("·");
}
