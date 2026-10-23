import { describe, expect, it } from "vitest";
import { TRIALS_PAGE, windowed, windowLabel } from "../src/lib/paging";

/**
 * The bound on what the board draws, and the sentence that admits it.
 *
 * A page that shows 50 of 137 silently is a page that has told the reader there are 50 trials.
 * These cases pin the arithmetic and the wording together, because the wording is the part that
 * carries the honesty.
 */
const rows = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe("windowed", () => {
  it("takes one page when asked for none", () => {
    const w = windowed(rows(137), 0);
    expect(w.visible.length).toBe(TRIALS_PAGE);
    expect(w.withheld).toBe(137 - TRIALS_PAGE);
    expect(w.hasMore).toBe(true);
  });

  it("never draws more than it is told to", () => {
    // `shown` comes from a button a visitor presses. A renderer that obeys whatever it is handed
    // is a renderer that can be asked for the whole index.
    const w = windowed(rows(137), 10 ** 9, 50);
    expect(w.visible.length).toBe(137);
    expect(w.hasMore).toBe(false);
  });

  it("clamps a value that is not a whole page rather than trusting the caller", () => {
    // Rounding DOWN is the safe direction: the guard's whole job is that no caller — including a
    // button someone has clicked fifty times — can make this render more than it asked for.
    expect(windowed(rows(137), 73).visible.length).toBe(50);
    expect(windowed(rows(137), 100).visible.length).toBe(100);
    expect(windowed(rows(137), Number.NaN).visible.length).toBe(TRIALS_PAGE);
    expect(windowed(rows(137), -50).visible.length).toBe(TRIALS_PAGE);
  });

  it("reports a short list as fully shown", () => {
    const w = windowed(rows(8), 50);
    expect(w.visible.length).toBe(8);
    expect(w.withheld).toBe(0);
    expect(w.hasMore).toBe(false);
    expect(w.total).toBe(8);
  });

  it("survives an empty board without inventing a row", () => {
    const w = windowed([], 50);
    expect(w.visible).toEqual([]);
    expect(w.total).toBe(0);
    expect(w.hasMore).toBe(false);
  });
});

describe("windowLabel", () => {
  it("says what is on screen and what is still behind it", () => {
    expect(windowLabel(windowed(rows(137), 50))).toBe(
      "showing 50 of 137, newest first — 87 more behind",
    );
  });

  it("claims the whole board only when it is showing the whole board", () => {
    expect(windowLabel(windowed(rows(3), 50))).toBe("all 3 trials, newest first");
    expect(windowLabel(windowed(rows(1), 50))).toBe("all 1 trial, newest first");
  });

  it("keeps an empty board and an uncounted board as different sentences", () => {
    // The distinction the whole site keeps making: zero is a measurement, nothing is not.
    expect(windowLabel(windowed([], 50))).toBe("nothing on the chain yet");
  });
});
