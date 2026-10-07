import { describe, expect, it } from "vitest";
import { inscription, roman, tierNumeral } from "@/lib/theme/roman";

/**
 * A wrong numeral on an honour roll is a wrong fact in costume. The classic subtractive forms
 * are enumerated rather than spot-checked, and anything outside the range the function
 * actually supports must fall back to digits instead of inventing a symbol.
 */
describe("roman formatting", () => {
  it("writes the range a reader will actually meet", () => {
    const expected = [
      "I",
      "II",
      "III",
      "IV",
      "V",
      "VI",
      "VII",
      "VIII",
      "IX",
      "X",
      "XIV",
      "XIX",
      "XL",
      "XC",
      "CD",
      "MCMXCIX",
      "MMXXVI",
    ];
    const inputs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14, 19, 40, 90, 400, 1999, 2026];
    expect(inputs.map(roman)).toEqual(expected);
  });

  it("refuses to invent numerals outside its range", () => {
    expect(roman(0)).toBe("0");
    expect(roman(-4)).toBe("-4");
    expect(roman(4000)).toBe("4000");
    expect(roman(1.5)).toBe("1.5");
    expect(roman(Number.NaN)).toBe("NaN");
  });

  it("counts tiers from one, and reports an unread tier as none", () => {
    expect(tierNumeral(0)).toBe("I");
    expect(tierNumeral(4)).toBe("V");
    expect(tierNumeral(null)).toBeNull();
    // A negative ordinal is a read that went wrong, not tier zero.
    expect(tierNumeral(-1)).toBeNull();
    expect(tierNumeral(1.5)).toBeNull();
  });

  it("joins with the interpunct and drops the parts nobody read", () => {
    expect(inscription(["Ignis", "Aqua", "Ferrum"])).toBe("Ignis·Aqua·Ferrum");
    expect(inscription(["Ignis", null, "", undefined, "Ferrum"])).toBe("Ignis·Ferrum");
    expect(inscription([])).toBe("");
    expect(inscription(["  Spare  ", "  Space "])).toBe("Spare·Space");
  });
});
