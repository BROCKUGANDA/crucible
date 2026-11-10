"use client";

import type { SVGProps } from "react";

/**
 * AgentInsignia — rank insignia for an agent's standing tier.
 *
 * Variants: "I" through "V" (novice → archon). Each insignia uses laurel leaves
 * in bronze, with gold accents at IV and V. Use on agent profiles, hall standings,
 * and trial rows to communicate earned standing.
 *
 * Never imply a rank depends on one arbitrary number — the tier comes from the
 * registry and is labelled with its tier name.
 */
type Rank = "I" | "II" | "III" | "IV" | "V";

const RANK_LABELS: Record<Rank, { name: string; numeral: string }> = {
  I: { name: "Novice", numeral: "I" },
  II: { name: "Proven", numeral: "II" },
  III: { name: "Veteran", numeral: "III" },
  IV: { name: "Master", numeral: "IV" },
  V: { name: "Archon", numeral: "V" },
};

export function AgentInsignia({
  rank = "I",
  width = 40,
  height = 40,
  className,
  "aria-label": ariaLabel,
  ...props
}: SVGProps<SVGSVGElement> & { rank?: Rank; width?: number | string; height?: number | string }) {
  const info = RANK_LABELS[rank];
  const label = ariaLabel ?? `Agent rank ${info.name} (${info.numeral})`;

  // Each rank draws laurel leaves scaled to the viewBox. Bronze stroke, stone fill.
  // IV adds a gold center dot; V adds a larger gold ring.
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 400 400"
      role="img"
      aria-label={label}
      className={className}
      {...props}
    >
      <title>Agent rank insignia {info.numeral}</title>
      <desc>Rank {info.numeral} — {info.name}. {rank.length === 1 ? "Single" : rank.length === 2 ? "Two" : rank.length === 3 ? "Three" : rank.length === 4 ? "Four" : "Five"} laurel leaf{rank.length > 1 ? "s" : ""} in bronze, stone ground.</desc>
      <circle cx="200" cy="200" r="180" fill="none" stroke="currentColor" stroke-width="10" opacity="0.5"/>
      {/* Laurel leaves — simplified leaf shapes radiating from center */}
      {rank === "I" && (
        <path d="M 200 120 Q 140 160 140 240 Q 140 320 200 280 Q 260 320 260 240 Q 260 160 200 120 Z" fill="currentColor" opacity="0.9"/>
      )}
      {rank === "II" && (
        <>
          <path d="M 150 140 Q 110 180 110 260 Q 110 340 170 300 Q 210 340 210 260 Q 210 180 150 140 Z" fill="currentColor" opacity="0.9"/>
          <path d="M 250 140 Q 290 180 290 260 Q 290 340 230 300 Q 190 340 190 260 Q 190 180 250 140 Z" fill="currentColor" opacity="0.9"/>
        </>
      )}
      {rank === "III" && (
        <>
          <path d="M 120 150 Q 90 190 90 270 Q 90 350 140 310 Q 170 350 170 270 Q 170 190 120 150 Z" fill="currentColor" opacity="0.9"/>
          <path d="M 200 140 Q 200 100 200 20 Q 200 100 200 140 Z" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round"/>
          <path d="M 280 150 Q 310 190 310 270 Q 310 350 260 310 Q 230 350 230 270 Q 230 190 280 150 Z" fill="currentColor" opacity="0.9"/>
        </>
      )}
      {rank === "IV" && (
        <>
          <path d="M 100 160 Q 70 200 70 280 Q 70 360 120 320 Q 150 360 150 280 Q 150 200 100 160 Z" fill="currentColor" opacity="0.9"/>
          <path d="M 160 150 Q 160 110 160 70 Q 160 110 160 150 Z" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round"/>
          <path d="M 240 160 Q 270 200 270 280 Q 270 360 220 320 Q 190 360 190 280 Q 190 200 240 160 Z" fill="currentColor" opacity="0.9"/>
          <path d="M 280 150 Q 300 210 300 290 Q 300 370 260 330 Q 240 370 240 290 Q 240 210 280 150 Z" fill="currentColor" opacity="0.9"/>
          <circle cx="200" cy="200" r="14" fill="currentColor"/>
        </>
      )}
      {rank === "V" && (
        <>
          <path d="M 80 170 Q 50 210 50 290 Q 50 370 100 330 Q 130 370 130 290 Q 130 210 80 170 Z" fill="currentColor" opacity="0.9"/>
          <path d="M 140 140 Q 140 100 140 60 Q 140 100 140 140 Z" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round"/>
          <path d="M 260 170 Q 290 210 290 290 Q 290 370 240 330 Q 210 370 210 290 Q 210 210 260 170 Z" fill="currentColor" opacity="0.9"/>
          <path d="M 300 160 Q 320 220 320 300 Q 320 380 280 340 Q 260 380 260 300 Q 260 220 300 160 Z" fill="currentColor" opacity="0.9"/>
          <path d="M 360 170 Q 380 210 380 290 Q 380 370 340 330 Q 320 370 320 290 Q 320 210 360 170 Z" fill="currentColor" opacity="0.9"/>
          <circle cx="200" cy="200" r="20" fill="currentColor"/>
          <circle cx="200" cy="200" r="8" fill="currentColor" opacity="0.1"/>
        </>
      )}
      <text x="200" y="370" font-family="Cinzel, serif" font-size="34" fill="currentColor" text-anchor="middle">{info.numeral}</text>
    </svg>
  );
}
