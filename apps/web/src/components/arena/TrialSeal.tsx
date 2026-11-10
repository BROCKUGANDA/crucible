"use client";

import type { SVGProps } from "react";

/**
 * TrialSeal — circular seal marking a posted trial on the arena board.
 *
 * Small seal with central "T" trial mark over flame. Use on trial cards and
 * trial detail to mark a trial as formally posted.
 */
export function TrialSeal({
  width = 32,
  height = 32,
  className,
  "aria-label": ariaLabel = "Trial posted",
  ...props
}: SVGProps<SVGSVGElement> & { width?: number | string; height?: number | string }) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 600 600"
      role="img"
      aria-label={ariaLabel}
      className={className}
      {...props}
    >
      <title>Trial seal</title>
      <desc>Circular seal marking a posted trial. Outer stone ring, inner T mark over flame.</desc>
      <circle cx="300" cy="300" r="280" fill="none" stroke="currentColor" stroke-width="16" opacity="0.5"/>
      <circle cx="300" cy="300" r="260" fill="none" stroke="currentColor" stroke-width="8"/>
      <circle cx="300" cy="300" r="245" fill="none" stroke="currentColor" stroke-width="5"/>
      <path d="M 265 215 L 335 215 M 300 215 L 300 385" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M 280 385 Q 290 340 300 315 Q 310 340 320 385 Q 305 370 300 365 Q 295 370 280 385 Z" fill="none" stroke="currentColor" stroke-width="6" stroke-linejoin="round"/>
      <text x="300" y="140" font-family="Cinzel, serif" font-size="30" fill="currentColor" text-anchor="middle" letter-spacing="4" opacity="0.6">TRIAL</text>
    </svg>
  );
}
