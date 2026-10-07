/**
 * How big the drawing buffer should be.
 *
 * A 2× devicePixelRatio on a 4K panel is 8 megapixels of fill per frame, and this canvas is
 * repainted on every scroll tick. The cap is the only defence that costs nothing: below it,
 * the scene is pixel-crisp; above it, the buffer shrinks and the blur is masked by the
 * vignette and the grain. Pure, because a cap nobody can test is a cap nobody trusts.
 */

/** Pixels of backing store we are willing to fill per frame. */
export const MAX_BACKING_PIXELS = 3_600_000;

export const MAX_DPR = 2;

/**
 * How far the buffer may fall below one device pixel per CSS pixel. Without a floor at all a
 * 5K display would render the scene at postage-stamp size; past this point the architecture
 * stops reading as architecture, so the cap gives up rather than degrading further.
 */
export const MIN_SCALE = 0.5;

export interface CanvasMetrics {
  /** Device pixels to set on the canvas element. */
  backingW: number;
  backingH: number;
  /** The scale to hand to `ctx.scale` so the scene can keep drawing in CSS pixels. */
  scale: number;
}

export function canvasMetrics(
  cssW: number,
  cssH: number,
  devicePixelRatio: number,
  maxBackingPixels: number = MAX_BACKING_PIXELS,
): CanvasMetrics {
  const w = Math.max(1, Math.floor(cssW));
  const h = Math.max(1, Math.floor(cssH));
  const dpr = Math.min(MAX_DPR, Math.max(1, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1));

  const area = w * h * dpr * dpr;
  // Clamping dpr alone is not a cap: at 3840x2160 a floor of 1 still fills eight megapixels,
  // so the scale has to be allowed to drop below one device pixel per CSS pixel.
  const scale = area > maxBackingPixels ? Math.max(MIN_SCALE, Math.sqrt(maxBackingPixels / (w * h))) : dpr;

  return { backingW: Math.round(w * scale), backingH: Math.round(h * scale), scale };
}
