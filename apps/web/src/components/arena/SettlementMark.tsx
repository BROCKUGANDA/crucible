"use client";

import type { SVGProps } from "react";

/**
 * SettlementMark — pull-ledger payout emblem.
 *
 * Coin stack with a withdrawal mark, verdict gold. Signals that the recipient
 * calls withdraw() in a separate transaction — settlement never pushes ETH.
 * Use on hall profiles, settlement receipts, and payout status.
 */
export function SettlementMark({
  width = 40,
  height = 40,
  className,
  "aria-label": ariaLabel = "Settlement — pull ledger, recipient withdraws",
  ...props
}: SVGProps<SVGSVGElement> & { width?: number | string; height?: number | string }) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 400 400"
      role="img"
      aria-label={ariaLabel}
      className={className}
      {...props}
    >
      <title>Settlement emblem</title>
      <desc>Pull-ledger payout mark: coin stack with withdrawing hand. Settlement never
      pushes ETH; the recipient calls withdraw() in a separate transaction.</desc>
      <circle cx="200" cy="200" r="170" fill="none" stroke="currentColor" stroke-width="12" opacity="0.6"/>
      <ellipse cx="200" cy="150" rx="50" ry="22" fill="currentColor" opacity="0.9"/>
      <ellipse cx="200" cy="178" rx="44" ry="18" fill="currentColor" opacity="0.8"/>
      <ellipse cx="200" cy="202" rx="38" ry="14" fill="currentColor" opacity="0.7"/>
      <path d="M 200 240 L 200 290 Q 200 310 185 310 L 185 330 L 215 330 L 215 310 Q 200 310 200 290" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  );
}
