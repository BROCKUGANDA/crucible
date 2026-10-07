import { describe, expect, it } from "vitest";
import { ACTS, actAt, actByKey, actIndexAt, band, clamp01, frameAt } from "@/lib/scrub/timeline";
import { FRAME_COUNT } from "@/lib/scrub/timeline";

/**
 * The timeline is the contract between the drawing, the HUD and the copy. If the bands are
 * not contiguous, the canvas freezes for one band of scroll and nobody notices until a demo
 * goes cold; if `frameAt` is not monotonic, the counter in the corner lies.
 */
describe("scrub timeline", () => {
  it("covers [0,1] with no gap and no overlap", () => {
    expect(ACTS[0]!.from).toBe(0);
    for (let i = 1; i < ACTS.length; i += 1) {
      const previous = ACTS[i - 1]!;
      const current = ACTS[i]!;
      expect(current.from).toBe(previous.to);
    }
    // The last band is allowed a hair of slack so progress exactly 1 still resolves.
    expect(ACTS[ACTS.length - 1]!.to).toBeGreaterThanOrEqual(1);
  });

  it("every sampled position resolves to exactly one act", () => {
    for (let i = 0; i <= 1000; i += 1) {
      const p = i / 1000;
      const act = actAt(p);
      const byIndex = ACTS[actIndexAt(p)]!;
      expect(byIndex.key).toBe(act.key);
    }
  });

  it("names every act once, and the ends land", () => {
    expect(new Set(ACTS.map((a) => a.key)).size).toBe(ACTS.length);
    expect(new Set(ACTS.map((a) => a.numeral)).size).toBe(ACTS.length);
    expect(actAt(0).key).toBe("gate");
    expect(actAt(1).key).toBe("alloy");
    expect(actAt(0.99).key).toBe("alloy");
  });

  it("actByKey falls back instead of returning undefined", () => {
    expect(actByKey("gate").numeral).toBe("I");
    // @ts-expect-error deliberately wrong key: the point is the fallback, not the type
    expect(actByKey("nonsense").key).toBe("gate");
  });

  it("frames rise monotonically across the whole ruler", () => {
    let previous = -1;
    for (let i = 0; i <= 200; i += 1) {
      const frame = frameAt(i / 200);
      expect(frame).toBeGreaterThanOrEqual(previous);
      expect(frame).toBeLessThan(FRAME_COUNT);
      previous = frame;
    }
    expect(frameAt(0)).toBe(0);
    expect(frameAt(1)).toBe(FRAME_COUNT - 1);
  });

  it("band localises a position and clamps outside it", () => {
    expect(band(0.25, 0.2, 0.3)).toBe(0.5);
    expect(band(0.1, 0.2, 0.3)).toBe(0);
    expect(band(0.9, 0.2, 0.3)).toBe(1);
    // A zero-width band must not divide by zero into the drawing.
    expect(Number.isFinite(band(0.5, 0.5, 0.5))).toBe(true);
  });

  it("clamp01 survives the values that reach it from a browser", () => {
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(-Infinity)).toBe(0);
    expect(clamp01(Infinity)).toBe(1);
    expect(clamp01(undefined as unknown as number)).toBe(0);
  });
});
