"use client";

import type { SVGProps } from "react";

/**
 * VerdictStamp — wax-seal style verdict stamp.
 *
 * Variants: "paid" (quench green), "slashed" (seared red), "reclaimed" (muted stone).
 * Use on trial rows, hall profiles, and verdict panels to communicate outcome at a glance.
 * Never colour-only: each variant also carries a distinct glyph (check / fracture /
 * hourglass) and an accessible label.
 */
type VerdictVariant = "paid" | "slashed" | "reclaimed";

const STAMP_CONFIG: Record<VerdictVariant, { label: string; glyph: string; tone: string }> = {
  paid: {
    label: "Verified — the run survived every strike",
    glyph: `
      <path d="M 160 250 L 190 280 L 240 220" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M 200 260 Q 200 280 200 300" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>
    `,
    tone: "quench",
  },
  slashed: {
    label: "Broken — the skeptic's proof held",
    glyph: `
      <path d="M 150 260 Q 200 300 250 260" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round"/>
      <path d="M 200 260 Q 200 240 200 220" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>
    `,
    tone: "sear",
  },
  reclaimed: {
    label: "Reclaimed — no run arrived before the deadline",
    glyph: `
      <path d="M 160 260 Q 200 290 240 260 M 200 260 L 200 300 M 180 280 L 220 280" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    `,
    tone: "muted",
  },
};

export function VerdictStamp({
  variant = "paid",
  width = 48,
  height = 48,
  className,
  "aria-label": ariaLabel,
  ...props
}: SVGProps<SVGSVGElement> & { variant?: VerdictVariant; width?: number | string; height?: number | string }) {
  const config = STAMP_CONFIG[variant];
  const label = ariaLabel ?? config.label;

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 400 400"
      role="img"
      aria-label={label}
      data-tone={config.tone}
      className={className}
      {...props}
    >
      <title>{label}</title>
      <desc>Verdict stamp — {config.label}.</desc>
      <circle cx="200" cy="200" r="170" fill="none" stroke="currentColor" stroke-width="14" stroke-linecap="round"/>
      <circle cx="200" cy="200" r="150" fill="none" stroke="currentColor" stroke-width="4" opacity="0.4"/>
      <text x="200" y="195" font-family="Cinzel, serif" font-size="56" fill="currentColor" text-anchor="middle" letter-spacing="8">
        {variant === "paid" ? "PAID" : variant === "slashed" ? "SLASHED" : "RECLAIMED"}
      </text>
      <g dangerouslySetInnerHTML={{ __html: config.glyph }} />
    </svg>
  );
}
