import { describe, expect, it } from "vitest";
import { MAX_BACKING_PIXELS, MAX_DPR, canvasMetrics } from "@/lib/scrub/canvasMetrics";

describe("canvas metrics", () => {
  it("keeps the scene in CSS pixels by scaling the buffer by dpr", () => {
    const m = canvasMetrics(1000, 600, 2);
    expect(m.backingW).toBe(2000);
    expect(m.backingH).toBe(1200);
    expect(m.scale).toBe(2);
  });

  it("clamps a phone-reported 3x down to the agreed maximum", () => {
    const m = canvasMetrics(400, 800, 3);
    expect(m.scale).toBe(MAX_DPR);
  });

  it("raises a sub-1 reported ratio to one device pixel per CSS pixel", () => {
    expect(canvasMetrics(400, 800, 0.4).scale).toBe(1);
  });

  it("caps the backing store on a 4K panel instead of filling 8 megapixels per frame", () => {
    const m = canvasMetrics(3840, 2160, 2);
    expect(m.backingW * m.backingH).toBeLessThanOrEqual(MAX_BACKING_PIXELS * 1.02);
    expect(m.scale).toBeLessThan(1);
    expect(m.scale).toBeGreaterThanOrEqual(0.5);
  });

  it("never degrades past the point the architecture stops reading", () => {
    const m = canvasMetrics(7680, 4320, 2);
    expect(m.scale).toBe(0.5);
  });

  it("leaves a small viewport exactly crisp, uncapped", () => {
    const m = canvasMetrics(800, 600, 2);
    expect(m.scale).toBe(2);
    expect(m.backingW * m.backingH).toBeLessThan(MAX_BACKING_PIXELS);
  });

  it("survives a zero-size layout from a hidden container", () => {
    const m = canvasMetrics(0, 0, 2);
    expect(m.backingW).toBeGreaterThanOrEqual(1);
    expect(m.backingH).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(m.scale)).toBe(true);
  });

  it("treats a nonsense devicePixelRatio as 1 rather than as a NaN buffer", () => {
    const m = canvasMetrics(500, 500, Number.NaN);
    expect(Number.isNaN(m.backingW)).toBe(false);
    expect(m.backingW).toBe(500);
  });
});
