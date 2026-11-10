"use client";

import type { SVGProps } from "react";

/**
 * CrucibleSeal — the master institutional seal.
 *
 * Renders the master Crucible seal SVG (public/brand/identity/crucible-seal.svg)
 * as an inline React component so it can be tone-styled and sized like any other
 * element. Carries an accessible title and desc. Use for headers, footers, and
 * institutional branding — never as decoration alone.
 *
 * Sizes: pass `width`/`height` (CSS-logical). Defaults to a 48px square.
 */
export function CrucibleSeal({
  width = 48,
  height = 48,
  className,
  "aria-label": ariaLabel = "Crucible institutional seal",
  ...props
}: SVGProps<SVGSVGElement> & { width?: number | string; height?: number | string }) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 1000 1000"
      role="img"
      aria-label={ariaLabel}
      className={className}
      {...props}
    >
      <title>Crucible seal</title>
      <desc>
        Master institutional seal: double-banded stone ring, laurel wreath, crucible
        bowl over flame. Obsidian, marble, laurel bronze, verdict gold.
      </desc>
      <circle cx="500" cy="500" r="470" fill="none" stroke="currentColor" stroke-width="28" opacity="0.5"/>
      <circle cx="500" cy="500" r="442" fill="none" stroke="currentColor" stroke-width="14"/>
      <circle cx="500" cy="500" r="428" fill="none" stroke="currentColor" stroke-width="4"/>
      <circle cx="500" cy="500" r="390" fill="none" stroke="currentColor" stroke-width="10"/>
      <path d="M 180 700 Q 140 500 180 320" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round"/>
      <path d="M 180 700 Q 260 720 380 560" fill="none" stroke="currentColor" stroke-width="14" stroke-linecap="round"/>
      <path d="M 820 700 Q 860 500 820 320" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round"/>
      <path d="M 820 700 Q 740 720 620 560" fill="none" stroke="currentColor" stroke-width="14" stroke-linecap="round"/>
      <ellipse cx="210" cy="420" rx="10" ry="20" transform="rotate(-40 210 420)" fill="none" stroke="currentColor" stroke-width="4"/>
      <ellipse cx="240" cy="360" rx="10" ry="20" transform="rotate(-55 240 360)" fill="none" stroke="currentColor" stroke-width="4"/>
      <ellipse cx="275" cy="320" rx="10" ry="20" transform="rotate(-70 275 320)" fill="none" stroke="currentColor" stroke-width="4"/>
      <ellipse cx="730" cy="420" rx="10" ry="20" transform="rotate(40 730 420)" fill="none" stroke="currentColor" stroke-width="4"/>
      <ellipse cx="760" cy="360" rx="10" ry="20" transform="rotate(55 760 360)" fill="none" stroke="currentColor" stroke-width="4"/>
      <ellipse cx="725" cy="320" rx="10" ry="20" transform="rotate(70 725 320)" fill="none" stroke="currentColor" stroke-width="4"/>
      <path d="M 440 560 L 560 560 L 500 680 Z" fill="none" stroke="currentColor" stroke-width="8" stroke-linejoin="round"/>
      <path d="M 470 680 Q 485 620 500 590 Q 515 620 530 680 Q 510 660 500 650 Q 490 660 470 680 Z" fill="none" stroke="currentColor" stroke-width="6" stroke-linejoin="round"/>
      <path d="M 400 860 Q 500 880 600 860" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round"/>
      <circle cx="500" cy="860" r="6" fill="currentColor"/>
      <circle cx="500" cy="940" r="30" fill="none" stroke="currentColor" stroke-width="5"/>
    </svg>
  );
}
